-- ============================================================================
-- 多币别改造 · 第 1 期（骨架）—— 币别与汇率主数据
--
-- 交付：
--   1) erp_currencies_s_539dcf81_b      币别主数据（每租户一份：本位币 / 符号 / 金额小数位）
--   2) erp_exchange_rates_s_539dcf81_b  汇率（外币 -> 本位币，按生效日 + 汇率类型）
--   3) current_base_currency()          本位币唯一取值入口
--   4) get_exchange_rate()              折算取汇率（第 2 期入库成本/应收应付要用）
--   5) seed_tenant_currencies()         标准币别清单幂等种子 + 新租户自动补
--   6) set_base_currency()              切换本位币（原子切换 + 同步 sys_config）
--   7) 删除保护触发器：本位币、已被汇率引用的币别不可删
--
-- 设计决策（已与用户拍板，全期一致）：
--   · 双金额：原币金额 + 本位币金额，汇率冻结在单据上（本期不落单据，只备好主数据）
--   · 库存成本一律本位币
--   · 汇率方向：1 单位外币 = rate 单位本位币（**只此一种口径，不许反用**）
--   · 汇兑损益：核销差额 + 期末调汇（第 3 期实现）
--
-- 多租户模型（与 deploy_63 MPS 表完全同构）：
--   币别/汇率都是租户业务数据（各公司本位币与汇率不同），tenant_id NOT NULL
--   DEFAULT current_tenant_id()，走 install_role_table_rls()；租户看不到别人的行。
--   表权限（sys_role_table_permissions）走「基线授权 + clone_platform_baseline_to_tenant 补差」；
--   币别**数据**不走 clone 函数（它只认识菜单/角色/字典），改由 seed_tenant_currencies()
--   负责，并在 sys_tenants 上挂独立触发器覆盖新租户 —— 不修改已执行的 deploy_52。
--
-- 注：脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（sys_config）、deploy_41（install_role_table_rls / refresh_sys_tables）、
--       deploy_48（save_tenant_config 的 sys_config 租户化）、deploy_52（clone 函数 + sys_tenants 触发器）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 币别主数据
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_currencies_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- ISO 4217 三位代码，统一存大写
  code VARCHAR(10) NOT NULL,
  name VARCHAR(100) NOT NULL,
  -- 展示用符号；JPY 与 CNY 都用 ¥，故 JPY 用 JP¥ 区分
  symbol VARCHAR(10),
  -- 该币别的金额小数位（JPY = 0，CNY/USD = 2）
  decimal_places SMALLINT NOT NULL DEFAULT 2,
  -- 全租户唯一一个本位币（部分唯一索引见下）
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 0,
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  CONSTRAINT chk_currency_code_upper CHECK (code = upper(btrim(code)) AND btrim(code) <> ''),
  CONSTRAINT chk_currency_decimal_places CHECK (decimal_places BETWEEN 0 AND 4)
);

COMMENT ON TABLE public.erp_currencies_s_539dcf81_b IS
  '币别主数据：本位币（is_base）决定本期所有「本位币金额」的口径；每租户恰好一个本位币。';
COMMENT ON COLUMN public.erp_currencies_s_539dcf81_b.code IS
  'ISO 4217 代码，大写（CNY / USD / EUR / HKD / JPY / GBP ...）。单据上的 currency 列软引用本列，不建 FK（跨租户 + 软删语义）。';
COMMENT ON COLUMN public.erp_currencies_s_539dcf81_b.decimal_places IS
  '该币别金额的小数位，供前端 formatMoney 使用；与 DECIMAL(18,2) 的存储精度独立。';
COMMENT ON COLUMN public.erp_currencies_s_539dcf81_b.is_base IS
  '本位币标记。切换走 RPC set_base_currency()，不要直接 UPDATE（部分唯一索引会瞬时冲突）。';

-- 业务唯一键租户内唯一；软删后允许复用代码
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_currencies_tenant_code
  ON public.erp_currencies_s_539dcf81_b (tenant_id, code)
  WHERE is_deleted = 'n';

-- 每租户至多一个本位币
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_currencies_one_base
  ON public.erp_currencies_s_539dcf81_b (tenant_id)
  WHERE is_base AND is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_currencies_tenant_status
  ON public.erp_currencies_s_539dcf81_b (tenant_id, status);

-- ----------------------------------------------------------------------------
-- 2) 汇率
--    ⚠️ 方向写死：1 单位 currency_code = rate 单位本位币。
--       反向取用（本位币 -> 外币）必须写 1/rate，不允许把语义倒过来存。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.erp_exchange_rates_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 外币代码（本位币本身不设汇率；取本位币汇率恒为 1）
  currency_code VARCHAR(10) NOT NULL,
  -- spot 即期 / monthly 月初 / custom 自定义（如预算汇率、合同汇率）
  rate_type VARCHAR(20) NOT NULL DEFAULT 'spot',
  effective_date DATE NOT NULL,
  rate NUMERIC(18, 8) NOT NULL,
  source VARCHAR(50),
  remark TEXT,
  tenant_id BIGINT NOT NULL DEFAULT current_tenant_id(),
  CONSTRAINT chk_fx_rate_positive CHECK (rate > 0),
  CONSTRAINT chk_fx_rate_type CHECK (rate_type IN ('spot', 'monthly', 'custom')),
  CONSTRAINT chk_fx_code_upper CHECK (currency_code = upper(btrim(currency_code)) AND btrim(currency_code) <> '')
);

COMMENT ON TABLE public.erp_exchange_rates_s_539dcf81_b IS
  '汇率：按币种 + 汇率类型 + 生效日维护，取「生效日 <= 业务日期」的最新一条。';
COMMENT ON COLUMN public.erp_exchange_rates_s_539dcf81_b.rate IS
  '1 单位 currency_code = rate 单位本位币（外币 -> 本位币）。反向折算用 1/rate，禁止倒序存储。';
COMMENT ON COLUMN public.erp_exchange_rates_s_539dcf81_b.rate_type IS
  'spot = 即期（默认）/ monthly = 月初 / custom = 自定义（预算价、合同价等）。单据引用时须与业务口径一致。';

-- 同租户 + 同币种 + 同类型 + 同生效日只有一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_exchange_rates_key
  ON public.erp_exchange_rates_s_539dcf81_b (tenant_id, currency_code, rate_type, effective_date)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_exchange_rates_lookup
  ON public.erp_exchange_rates_s_539dcf81_b (tenant_id, currency_code, rate_type, effective_date DESC)
  WHERE is_deleted = 'n';

-- ----------------------------------------------------------------------------
-- 3) 本位币唯一取值入口
--    优先级：本租户 erp_currencies.is_base > 本租户 sys_config.finance.baseCurrency
--            > 基线 sys_config.finance.baseCurrency > 'CNY'
--    最后一级兜底是为了「币别数据还没种上」时不至于把前端打挂。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_base_currency()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT c.code
       FROM public.erp_currencies_s_539dcf81_b c
      WHERE c.is_base
        AND COALESCE(c.is_deleted, 'n') = 'n'
        AND c.tenant_id = public.current_tenant_id()
      ORDER BY c.id
      LIMIT 1),
    (SELECT NULLIF(upper(btrim(cfg.config_json ->> 'baseCurrency')), '')
       FROM public.sys_config cfg
      WHERE cfg.category_code = 'finance'
        AND COALESCE(cfg.is_deleted, 'n') = 'n'
        AND cfg.tenant_id = public.current_tenant_id()
      ORDER BY cfg.id DESC
      LIMIT 1),
    (SELECT NULLIF(upper(btrim(cfg.config_json ->> 'baseCurrency')), '')
       FROM public.sys_config cfg
      WHERE cfg.category_code = 'finance'
        AND COALESCE(cfg.is_deleted, 'n') = 'n'
        AND cfg.tenant_id IS NULL
      ORDER BY cfg.id DESC
      LIMIT 1),
    'CNY'
  );
$$;

COMMENT ON FUNCTION public.current_base_currency() IS
  '本位币唯一取值入口。money.ts 与后续所有折算逻辑都从这里取，不要各处硬编码 CNY。';

GRANT EXECUTE ON FUNCTION public.current_base_currency() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_base_currency() TO service_role;

-- ----------------------------------------------------------------------------
-- 4) 取汇率
--    返回「1 单位 p_currency = ? 单位本位币」。
--      · p_currency 为空 或 = 本位币  -> 1
--      · 取不到有效汇率              -> NULL（调用方决定报错还是回退，本期不做隐式 1）
--    只认同租户 + 同类型的行；SECURITY DEFINER 便于 ai-server（BYPASSRLS）复用。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_exchange_rate(
  p_currency TEXT,
  p_date DATE DEFAULT CURRENT_DATE,
  p_rate_type TEXT DEFAULT 'spot'
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code TEXT := NULLIF(upper(btrim(p_currency)), '');
  v_base TEXT := public.current_base_currency();
  v_rate NUMERIC;
BEGIN
  IF v_code IS NULL OR v_code = v_base THEN
    RETURN 1;
  END IF;

  SELECT r.rate INTO v_rate
  FROM public.erp_exchange_rates_s_539dcf81_b r
  WHERE r.currency_code = v_code
    AND r.rate_type = COALESCE(NULLIF(btrim(p_rate_type), ''), 'spot')
    AND r.effective_date <= COALESCE(p_date, CURRENT_DATE)
    AND COALESCE(r.is_deleted, 'n') = 'n'
    AND r.tenant_id = public.current_tenant_id()
  ORDER BY r.effective_date DESC, r.id DESC
  LIMIT 1;

  RETURN v_rate;   -- 可能为 NULL：调用方必须显式处理
END;
$$;

COMMENT ON FUNCTION public.get_exchange_rate(TEXT, DATE, TEXT) IS
  '取「1 单位外币 = ? 单位本位币」。无有效汇率时返回 NULL（fail-loud），不要在调用处用 COALESCE(...,1) 兜底。';

GRANT EXECUTE ON FUNCTION public.get_exchange_rate(TEXT, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_exchange_rate(TEXT, DATE, TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 5) 标准币别清单种子（幂等）
--    清单硬编码在函数里（不依赖任何租户现有数据），现有租户遍历 + 新租户触发器共用。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_tenant_currencies(
  p_tenant_id BIGINT,
  p_base_code TEXT DEFAULT 'CNY'
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER := 0;
  v_base TEXT := COALESCE(NULLIF(upper(btrim(p_base_code)), ''), 'CNY');
  v_has_base BOOLEAN;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION '租户 ID 不能为空' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.erp_currencies_s_539dcf81_b
    (code, name, symbol, decimal_places, is_base, status, sort_order, tenant_id)
  SELECT v.code, v.name, v.symbol, v.dp, FALSE, 'active', v.sort_order, p_tenant_id
  FROM (VALUES
    ('CNY', '人民币', '¥',    2::SMALLINT, 1),
    ('USD', '美元',   '$',    2::SMALLINT, 2),
    ('EUR', '欧元',   '€',    2::SMALLINT, 3),
    ('HKD', '港币',   'HK$',  2::SMALLINT, 4),
    ('JPY', '日元',   'JP¥',  0::SMALLINT, 5),
    ('GBP', '英镑',   '£',    2::SMALLINT, 6)
  ) AS v(code, name, symbol, dp, sort_order)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.erp_currencies_s_539dcf81_b c
    WHERE c.tenant_id = p_tenant_id
      AND c.code = v.code
      AND COALESCE(c.is_deleted, 'n') = 'n'
  );

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 该租户还没有本位币时，把 p_base_code 设为本位币（清单里没有该代码就退回 CNY）
  SELECT EXISTS (
    SELECT 1 FROM public.erp_currencies_s_539dcf81_b c
    WHERE c.tenant_id = p_tenant_id AND c.is_base
      AND COALESCE(c.is_deleted, 'n') = 'n'
  ) INTO v_has_base;

  IF NOT v_has_base THEN
    UPDATE public.erp_currencies_s_539dcf81_b c
       SET is_base = TRUE, updated_at = NOW()
     WHERE c.tenant_id = p_tenant_id
       AND COALESCE(c.is_deleted, 'n') = 'n'
       AND c.code = v_base;

    IF NOT FOUND THEN
      UPDATE public.erp_currencies_s_539dcf81_b c
         SET is_base = TRUE, updated_at = NOW()
       WHERE c.tenant_id = p_tenant_id
         AND COALESCE(c.is_deleted, 'n') = 'n'
         AND c.code = 'CNY';
    END IF;
  END IF;

  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION public.seed_tenant_currencies(BIGINT, TEXT) IS
  '幂等：给一个租户补齐标准币别清单，并保证至少有一个本位币。新租户由 sys_tenants 触发器自动调用。';

GRANT EXECUTE ON FUNCTION public.seed_tenant_currencies(BIGINT, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 6) 切换本位币（原子 + 同步 sys_config）
--    ⚠️ 直接 UPDATE erp_currencies.is_base 会撞 uq_erp_currencies_one_base
--       （新旧两行在语句内瞬时同时为 TRUE）→ 必须先全部清零再置位。
--    切换不重算历史金额：历史单据/库存/凭证的金额口径由各自的汇率字段决定，
--    本位币只影响「今后新发生的业务」，这一点在产品上要明示。
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_base_currency(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant BIGINT := public.current_tenant_id();
  v_code TEXT := NULLIF(upper(btrim(p_code)), '');
  v_prev TEXT;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '当前用户没有租户上下文，无法切换本位币' USING ERRCODE = '28000';
  END IF;
  IF v_code IS NULL THEN
    RAISE EXCEPTION '币别代码不能为空' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_currencies_s_539dcf81_b c
    WHERE c.tenant_id = v_tenant
      AND c.code = v_code
      AND COALESCE(c.is_deleted, 'n') = 'n'
      AND c.status = 'active'
  ) THEN
    RAISE EXCEPTION '币别 % 不存在、已删除或已停用', v_code USING ERRCODE = 'P0002';
  END IF;

  SELECT c.code INTO v_prev
  FROM public.erp_currencies_s_539dcf81_b c
  WHERE c.tenant_id = v_tenant AND c.is_base
    AND COALESCE(c.is_deleted, 'n') = 'n'
  ORDER BY c.id LIMIT 1;

  IF v_prev = v_code THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'base_currency', v_code, 'previous', v_prev);
  END IF;

  UPDATE public.erp_currencies_s_539dcf81_b c
     SET is_base = FALSE, updated_at = NOW()
   WHERE c.tenant_id = v_tenant
     AND COALESCE(c.is_deleted, 'n') = 'n'
     AND c.is_base;

  UPDATE public.erp_currencies_s_539dcf81_b c
     SET is_base = TRUE, updated_at = NOW()
   WHERE c.tenant_id = v_tenant
     AND COALESCE(c.is_deleted, 'n') = 'n'
     AND c.code = v_code;

  -- 同步 finance 配置里的 baseCurrency，避免「设置页」与「币别页」两处真相源打架
  UPDATE public.sys_config cfg
     SET config_json = jsonb_set(
           COALESCE(cfg.config_json, '{}'::JSONB),
           '{baseCurrency}', to_jsonb(v_code), TRUE),
         updated_at = NOW()
   WHERE cfg.category_code = 'finance'
     AND cfg.tenant_id = v_tenant
     AND COALESCE(cfg.is_deleted, 'n') = 'n';

  IF NOT FOUND THEN
    -- 该租户还没有私有 finance 配置行：以基线行为模板插一条（沿用名称/描述/排序/状态）
    INSERT INTO public.sys_config
      (category_code, category_name, config_json, description, sort_order, status, tenant_id)
    SELECT 'finance',
           COALESCE(b.category_name, '财务设置'),
           jsonb_set(COALESCE(b.config_json, '{}'::JSONB),
                     '{baseCurrency}', to_jsonb(v_code), TRUE),
           COALESCE(b.description, '本位币、税率、会计期间和凭证过账控制。'),
           COALESCE(b.sort_order, 2),
           COALESCE(b.status, '1'),
           v_tenant
    FROM (SELECT 1) dummy
    LEFT JOIN LATERAL (
      SELECT category_name, config_json, description, sort_order, status
      FROM public.sys_config
      WHERE category_code = 'finance' AND tenant_id IS NULL
        AND COALESCE(is_deleted, 'n') = 'n'
      ORDER BY id
      LIMIT 1
    ) b ON TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sys_config c2
      WHERE c2.category_code = 'finance' AND c2.tenant_id = v_tenant
        AND COALESCE(c2.is_deleted, 'n') = 'n'
    );
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'base_currency', v_code, 'previous', v_prev);
END;
$$;

COMMENT ON FUNCTION public.set_base_currency(TEXT) IS
  '切换本位币：原子改 is_base + 同步 sys_config.finance.baseCurrency。不重算历史金额。';

GRANT EXECUTE ON FUNCTION public.set_base_currency(TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- 7) 删除保护：本位币、被汇率引用的币别不可删（停用即可）
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_currency_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.is_base THEN
    RAISE EXCEPTION '币别 % 是本位币，不能删除（请先切换本位币）', OLD.code
      USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.erp_exchange_rates_s_539dcf81_b r
    WHERE r.currency_code = OLD.code
      AND r.tenant_id = OLD.tenant_id
      AND COALESCE(r.is_deleted, 'n') = 'n'
  ) THEN
    RAISE EXCEPTION '币别 % 仍被汇率引用，不能删除（请停用或先清理汇率）', OLD.code
      USING ERRCODE = '23503';
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_currencies_protect_delete ON public.erp_currencies_s_539dcf81_b;
CREATE TRIGGER trg_erp_currencies_protect_delete
  BEFORE DELETE ON public.erp_currencies_s_539dcf81_b
  FOR EACH ROW EXECUTE FUNCTION public.protect_currency_delete();

-- ----------------------------------------------------------------------------
-- 8) RLS + 授权 + sys_tables 登记 + 基线角色表权限
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_currencies_s_539dcf81_b TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_exchange_rates_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_currencies_s_539dcf81_b_id_seq TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_exchange_rates_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_currencies_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_exchange_rates_s_539dcf81_b');

-- 目录登记（has_table_permission 走 sys_tables，漏登记 = 表级权限永远不命中）
SELECT public.refresh_sys_tables();

-- 基线角色授权：币别/汇率归财务，超管 + 租户管理员 + 财务经理
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager')
  AND t.table_name IN ('erp_currencies_s_539dcf81_b', 'erp_exchange_rates_s_539dcf81_b')
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 给已物化租户补差（表权限副本）
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 表权限补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补表权限副本', v_count;
END;
$$;

-- ----------------------------------------------------------------------------
-- 9) 币别数据：现有租户逐一种子 + 新租户自动补
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant RECORD;
  v_n INTEGER;
  v_total INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
    ORDER BY t.id
  LOOP
    v_n := public.seed_tenant_currencies(v_tenant.id);
    RAISE NOTICE '租户 % (%) 币别种子：新增 % 条', v_tenant.id, v_tenant.code, v_n;
    v_total := v_total + 1;
  END LOOP;
  RAISE NOTICE '已覆盖 % 个租户', v_total;
END;
$$;

-- 新租户自动种子（独立于 deploy_52 的 trg_sys_tenants_clone_baseline，不修改已执行脚本）
CREATE OR REPLACE FUNCTION public.trg_sys_tenants_seed_currencies()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.seed_tenant_currencies(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- 与 deploy_52 的 clone 触发器同策略：失败只告警不阻断开通
    RAISE WARNING '租户 % 币别种子失败（%），请手工执行 SELECT public.seed_tenant_currencies(%);',
      NEW.id, SQLERRM, NEW.id;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sys_tenants_seed_currencies ON public.sys_tenants;
CREATE TRIGGER trg_sys_tenants_seed_currencies
  AFTER INSERT ON public.sys_tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sys_tenants_seed_currencies();

-- ----------------------------------------------------------------------------
-- 10) 自检（fail-loud）
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant RECORD;
  v_cur INTEGER;
  v_base INTEGER;
  v_grants INTEGER;
  v_missing TEXT := '';
BEGIN
  SELECT count(*) INTO v_grants
  FROM public.sys_role_table_permissions rp
  JOIN public.sys_roles r ON r.id = rp.role_id
  JOIN public.sys_tables t ON t.id = rp.table_id
  WHERE rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager')
    AND t.table_name IN ('erp_currencies_s_539dcf81_b', 'erp_exchange_rates_s_539dcf81_b');

  IF v_grants < 6 THEN
    RAISE EXCEPTION '币别/汇率表权限基线不全（期望 3 角色 × 2 表 = 6，实际 %）', v_grants;
  END IF;

  FOR v_tenant IN
    SELECT t.id, t.code, t.metadata_materialized
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
    ORDER BY t.id
  LOOP
    SELECT count(*) INTO v_cur
    FROM public.erp_currencies_s_539dcf81_b c
    WHERE c.tenant_id = v_tenant.id AND COALESCE(c.is_deleted, 'n') = 'n';

    SELECT count(*) INTO v_base
    FROM public.erp_currencies_s_539dcf81_b c
    WHERE c.tenant_id = v_tenant.id AND c.is_base
      AND COALESCE(c.is_deleted, 'n') = 'n';

    IF v_cur = 0 THEN
      v_missing := v_missing || format(' 租户%s无币别数据;', v_tenant.id);
    ELSIF v_base <> 1 THEN
      v_missing := v_missing || format(' 租户%s本位币不是恰好一个(%s);', v_tenant.id, v_base);
    END IF;

    -- 已物化租户的表权限副本必须落地，否则币别页整表不可见
    IF v_tenant.metadata_materialized AND NOT EXISTS (
      SELECT 1
      FROM public.sys_role_table_permissions rp
      JOIN public.sys_roles r ON r.id = rp.role_id
      JOIN public.sys_tables t ON t.id = rp.table_id
      WHERE rp.tenant_id = v_tenant.id AND COALESCE(rp.is_deleted, 'n') = 'n'
        AND r.role_code = 'tenant_admin' AND r.tenant_id = v_tenant.id
        AND t.table_name = 'erp_currencies_s_539dcf81_b'
    ) THEN
      v_missing := v_missing || format(' 租户%s的tenant_admin无币别表权限副本;', v_tenant.id);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION '币别主数据初始化不完整：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_65 OK：币别/汇率主数据、本位币函数、表权限与租户数据齐备';
END;
$$;

-- 回滚提示
--   1) 清数据与触发器：
--        DROP TRIGGER IF EXISTS trg_sys_tenants_seed_currencies ON public.sys_tenants;
--        DROP FUNCTION IF EXISTS public.trg_sys_tenants_seed_currencies();
--        DROP FUNCTION IF EXISTS public.set_base_currency(TEXT);
--        DROP FUNCTION IF EXISTS public.seed_tenant_currencies(BIGINT, TEXT);
--        DROP FUNCTION IF EXISTS public.get_exchange_rate(TEXT, DATE, TEXT);
--        DROP FUNCTION IF EXISTS public.current_base_currency();
--   2) 删表（会连带 RLS 策略与触发器）：
--        DROP TABLE IF EXISTS public.erp_exchange_rates_s_539dcf81_b;
--        DROP TABLE IF EXISTS public.erp_currencies_s_539dcf81_b;
--        SELECT public.refresh_sys_tables();
--   3) 版本回退后把 sys_config.finance.baseCurrency 改回 CNY 由业务决定，脚本不动它。
