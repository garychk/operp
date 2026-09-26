-- ============================================================================
-- deploy_47_naming_counter_tenant.sql — 单据编号计数器的租户隔离
--
-- 依赖：deploy_41（sys_tenants / current_tenant_id()）
--       deploy_32（原计数器表与 generate_document_no）
--
-- 问题性质与前几个脚本不同，先说清楚：
--
--   这不是「跨租户能看到别人的数据」，而是**跨租户串号**：
--     租户 1 建了 5 张采购单 → 计数器 PO2026 = 5
--     租户 2 建第一张采购单 → 拿到 PO20260006
--   单据号带着别家的流水号，业务上直接不可用。
--
--   所以本脚本不建 RLS 策略 —— 没必要。deploy_32 已经
--   `REVOKE ALL ON sys_document_naming_counters FROM authenticated`，
--   前端根本碰不到这张表，只能走 SECURITY DEFINER 的 generate_document_no。
--   真正的修法是把租户塞进计数器的主键。
--
-- 改造内容：
--   1. 加 tenant_id，主键从 (document_type, period_key)
--      改为 (tenant_id, document_type, period_key)
--   2. generate_document_no 按租户取号
--   3. reset_document_no_counter 按租户删（原版会删掉所有租户的计数器）
--
-- 执行方式（建议先干跑）：
--   BEGIN;  ... 本文件 ...  ROLLBACK;   -- 看 NOTICE
--   BEGIN;  ... 本文件 ...  COMMIT;     -- 确认后落地
-- ============================================================================


-- ============================================================================
-- 1. 加列 + 回填 + 改主键
-- ============================================================================

DO $$
DECLARE
    default_tenant BIGINT;
    n_rows         BIGINT;
BEGIN
    SELECT id INTO default_tenant
    FROM public.sys_tenants
    WHERE code = 'default' AND is_deleted = 'n'
    LIMIT 1;

    IF default_tenant IS NULL THEN
        RAISE EXCEPTION '找不到 default 租户，无法回填计数器，请先执行 deploy_41';
    END IF;

    -- 存量计数器全部归到 default 租户：它们是多租户改造之前产生的，
    -- 本来就只有一份，归属 default 是唯一合理的选择。
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='sys_document_naming_counters' AND column_name='tenant_id'
    ) THEN
        EXECUTE 'ALTER TABLE public.sys_document_naming_counters ADD COLUMN tenant_id BIGINT';
        RAISE NOTICE 'sys_document_naming_counters: 已加列';
    ELSE
        RAISE NOTICE 'sys_document_naming_counters: tenant_id 已存在，跳过加列';
    END IF;

    UPDATE public.sys_document_naming_counters
    SET tenant_id = default_tenant
    WHERE tenant_id IS NULL;
    GET DIAGNOSTICS n_rows = ROW_COUNT;
    RAISE NOTICE '回填 % 行计数器到 default 租户 (%)', n_rows, default_tenant;

    -- 主键列必须 NOT NULL
    EXECUTE 'ALTER TABLE public.sys_document_naming_counters ALTER COLUMN tenant_id SET NOT NULL';

    -- 换主键：先删旧的，再建三元组的
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sys_document_naming_counters_pkey'
          AND conrelid = 'public.sys_document_naming_counters'::regclass
    ) THEN
        EXECUTE 'ALTER TABLE public.sys_document_naming_counters '
                'DROP CONSTRAINT sys_document_naming_counters_pkey';
        RAISE NOTICE '已删除旧主键 (document_type, period_key)';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'sys_document_naming_counters_pkey'
          AND conrelid = 'public.sys_document_naming_counters'::regclass
    ) THEN
        EXECUTE 'ALTER TABLE public.sys_document_naming_counters '
                'ADD PRIMARY KEY (tenant_id, document_type, period_key)';
        RAISE NOTICE '已建立新主键 (tenant_id, document_type, period_key)';
    ELSE
        RAISE NOTICE '新主键已存在，跳过';
    END IF;
END $$;

COMMENT ON COLUMN public.sys_document_naming_counters.tenant_id IS
    '所属租户。计数器按租户独立，否则不同租户的单据会共用一套流水号';


-- ============================================================================
-- 2. generate_document_no —— 按租户取号
--
--    原两参数版本保留函数签名不变（前端 src/utils/documentNaming.ts 就是
--    这么调的），内部改为按 current_tenant_id() 取号，前端调用点零改动。
--
--    显式传租户的版本**用独立函数名 generate_document_no_for_tenant，
--    不做同名重载**：
--      PostgREST 对同名重载函数的支持不稳定，schema cache 里只暴露一个
--      /rpc/<name> 端点，选错重载的表现是运行时报缺参数，排查成本高。
--      用独立名字彻底消掉这个风险，代价只是后台调用方换个函数名。
--
--    SECURITY DEFINER 不改变 auth.uid()（它读的是 request.jwt.claims 这个
--    GUC，与执行身份无关），所以函数内调 current_tenant_id() 仍然有效。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_document_no(
  p_document_type TEXT,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule TEXT;
  v_period TEXT;
  v_next INTEGER;
  v_result TEXT := '';
  v_rest TEXT;
  v_match TEXT[];
  v_tenant BIGINT;
BEGIN
  IF p_document_type IS NULL OR BTRIM(p_document_type) = '' THEN
    RAISE EXCEPTION 'Document type is required' USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL THEN
    p_date := CURRENT_DATE;
  END IF;

  v_tenant := public.current_tenant_id();

  IF v_tenant IS NULL THEN
    -- 不能静默落到某个租户：串号比报错更难发现。
    RAISE EXCEPTION
      'Cannot resolve tenant for document numbering (type=%). '
      'Ensure the caller has a tenant, or call generate_document_no_for_tenant() '
      'with an explicit tenant id.',
      p_document_type
      USING ERRCODE = '22023';
  END IF;

  SELECT NULLIF(BTRIM(naming_rule), '') INTO v_rule
  FROM public.sys_document_types
  WHERE document_type = BTRIM(p_document_type)
    AND status = '1'
    AND is_deleted = 'n';

  IF v_rule IS NULL THEN
    RAISE EXCEPTION 'No naming rule configured for document type: %', p_document_type USING ERRCODE = 'P0002';
  END IF;

  IF v_rule LIKE '%{DD}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMMDD');
  ELSIF v_rule LIKE '%{MM}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMM');
  ELSE
    v_period := TO_CHAR(p_date, 'YYYY');
  END IF;

  INSERT INTO public.sys_document_naming_counters AS c
    (tenant_id, document_type, period_key, last_no)
  VALUES (v_tenant, BTRIM(p_document_type), v_period, 1)
  ON CONFLICT (tenant_id, document_type, period_key)
  DO UPDATE SET last_no = c.last_no + 1, updated_at = NOW()
  RETURNING c.last_no INTO v_next;

  v_rest := v_rule;
  LOOP
    v_match := regexp_match(v_rest, '^(.*?)\{([^{}]+)\}(.*)$');
    EXIT WHEN v_match IS NULL;
    v_result := v_result || v_match[1] || CASE v_match[2]
      WHEN 'YYYY' THEN TO_CHAR(p_date, 'YYYY')
      WHEN 'YY' THEN TO_CHAR(p_date, 'YY')
      WHEN 'MM' THEN TO_CHAR(p_date, 'MM')
      WHEN 'DD' THEN TO_CHAR(p_date, 'DD')
      ELSE CASE
        WHEN v_match[2] ~ '^#+$' THEN LPAD(v_next::TEXT, LENGTH(v_match[2]), '0')
        ELSE '{' || v_match[2] || '}'
      END
    END;
    v_rest := v_match[3];
  END LOOP;
  v_result := v_result || v_rest;

  RETURN LEFT(v_result, 50);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_document_no(TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_document_no(TEXT, DATE) TO authenticated;


-- ============================================================================
-- 2b. generate_document_no_for_tenant —— 显式传租户的版本
--
--     给 service_role / ai-server / 后台任务用：它们没有 auth.uid()，
--     current_tenant_id() 会解析成 NULL，必须显式传。
--     命名独立而非重载，原因见第 2 节。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.generate_document_no_for_tenant(
  p_document_type TEXT,
  p_date DATE DEFAULT CURRENT_DATE,
  p_tenant_id BIGINT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule TEXT;
  v_period TEXT;
  v_next INTEGER;
  v_result TEXT := '';
  v_rest TEXT;
  v_match TEXT[];
BEGIN
  IF p_document_type IS NULL OR BTRIM(p_document_type) = '' THEN
    RAISE EXCEPTION 'Document type is required' USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL THEN
    p_date := CURRENT_DATE;
  END IF;
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id is required for generate_document_no_for_tenant'
      USING ERRCODE = '22023';
  END IF;

  SELECT NULLIF(BTRIM(naming_rule), '') INTO v_rule
  FROM public.sys_document_types
  WHERE document_type = BTRIM(p_document_type)
    AND status = '1'
    AND is_deleted = 'n';

  IF v_rule IS NULL THEN
    RAISE EXCEPTION 'No naming rule configured for document type: %', p_document_type USING ERRCODE = 'P0002';
  END IF;

  IF v_rule LIKE '%{DD}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMMDD');
  ELSIF v_rule LIKE '%{MM}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMM');
  ELSE
    v_period := TO_CHAR(p_date, 'YYYY');
  END IF;

  INSERT INTO public.sys_document_naming_counters AS c
    (tenant_id, document_type, period_key, last_no)
  VALUES (p_tenant_id, BTRIM(p_document_type), v_period, 1)
  ON CONFLICT (tenant_id, document_type, period_key)
  DO UPDATE SET last_no = c.last_no + 1, updated_at = NOW()
  RETURNING c.last_no INTO v_next;

  v_rest := v_rule;
  LOOP
    v_match := regexp_match(v_rest, '^(.*?)\{([^{}]+)\}(.*)$');
    EXIT WHEN v_match IS NULL;
    v_result := v_result || v_match[1] || CASE v_match[2]
      WHEN 'YYYY' THEN TO_CHAR(p_date, 'YYYY')
      WHEN 'YY' THEN TO_CHAR(p_date, 'YY')
      WHEN 'MM' THEN TO_CHAR(p_date, 'MM')
      WHEN 'DD' THEN TO_CHAR(p_date, 'DD')
      ELSE CASE
        WHEN v_match[2] ~ '^#+$' THEN LPAD(v_next::TEXT, LENGTH(v_match[2]), '0')
        ELSE '{' || v_match[2] || '}'
      END
    END;
    v_rest := v_match[3];
  END LOOP;
  v_result := v_result || v_rest;

  RETURN LEFT(v_result, 50);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_document_no_for_tenant(TEXT, DATE, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_document_no_for_tenant(TEXT, DATE, BIGINT) TO service_role;


-- ============================================================================
-- 3. reset_document_no_counter —— 加租户边界
--
--    原版 DELETE 不带租户条件，重置一个单据类型的计数器会
--    **把所有租户的计数器一起删掉**。这是破坏性的跨租户写入，必须修。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reset_document_no_counter(
  p_document_type TEXT,
  p_period_key TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_tenant BIGINT;
BEGIN
  v_tenant := public.current_tenant_id();

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION
      'Cannot resolve tenant for counter reset (type=%). '
      'Refusing to delete counters across all tenants.',
      p_document_type
      USING ERRCODE = '22023';
  END IF;

  IF p_period_key IS NULL THEN
    DELETE FROM public.sys_document_naming_counters
    WHERE document_type = p_document_type AND tenant_id = v_tenant;
  ELSE
    DELETE FROM public.sys_document_naming_counters
    WHERE document_type = p_document_type
      AND period_key = p_period_key
      AND tenant_id = v_tenant;
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_document_no_counter(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_document_no_counter(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.reset_document_no_counter_for_tenant(
  p_document_type TEXT,
  p_period_key TEXT DEFAULT NULL,
  p_tenant_id BIGINT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id is required for reset_document_no_counter_for_tenant'
      USING ERRCODE = '22023';
  END IF;

  IF p_period_key IS NULL THEN
    DELETE FROM public.sys_document_naming_counters
    WHERE document_type = p_document_type AND tenant_id = p_tenant_id;
  ELSE
    DELETE FROM public.sys_document_naming_counters
    WHERE document_type = p_document_type
      AND period_key = p_period_key
      AND tenant_id = p_tenant_id;
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_document_no_counter_for_tenant(TEXT, TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_document_no_counter_for_tenant(TEXT, TEXT, BIGINT) TO service_role;


-- ============================================================================
-- 4. 刷新 schema 缓存（新函数与改动后的签名要能被 PostgREST 看见）
-- ============================================================================

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 5. 自检
-- ============================================================================

-- 5.1 主键是否已是三元组
-- SELECT pg_get_constraintdef(oid) FROM pg_constraint
-- WHERE conname = 'sys_document_naming_counters_pkey';

-- 5.2 各租户的计数器分布
-- SELECT tenant_id, document_type, period_key, last_no
-- FROM public.sys_document_naming_counters ORDER BY tenant_id, document_type;

-- 5.3 函数签名（应为 4 个，两两一对，无同名重载）
-- SELECT p.oid::regprocedure
-- FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname='public' AND p.proname IN
--   ('generate_document_no','generate_document_no_for_tenant',
--    'reset_document_no_counter','reset_document_no_counter_for_tenant')
-- ORDER BY 1;

-- 5.4 人工验收（用 service_role 在 Studio 里跑，两个号应各自从 1 开始）
-- SELECT public.generate_document_no_for_tenant('purchase_order', CURRENT_DATE, 1);
-- SELECT public.generate_document_no_for_tenant('purchase_order', CURRENT_DATE, 2);
-- 预期：PO20260001 和 PO20260001（各自独立计数），改造前第二次会拿到 PO20260002

-- 5.5 回滚（会把计数器退回共享状态，谨慎）
-- ALTER TABLE public.sys_document_naming_counters
--   DROP CONSTRAINT sys_document_naming_counters_pkey;
-- ALTER TABLE public.sys_document_naming_counters
--   ADD PRIMARY KEY (document_type, period_key);
-- ALTER TABLE public.sys_document_naming_counters DROP COLUMN tenant_id;


-- ============================================================================
-- 必须知道的两件事
-- ============================================================================
-- 1. 前端有静默 fallback，会掩盖租户解析失败。
--    src/utils/documentNaming.ts 的 nextDocumentNo 在 RPC 报错时
--    catch 掉并返回 `PO12345678`（时间戳后 8 位），只在 console.warn 打日志。
--    所以「无租户 → 本脚本抛异常」的结果是：单据号变成不规则的时间戳串，
--    而不是弹错误。不会串号，但也不会有人立刻发现。
--    建议后续在 nextDocumentNo 里对这类错误区分处理，别一律 fallback。
--
-- 2. sys_document_types（命名规则本身）仍是全局共享的。
--    所有租户共用同一套编号规则。将来若某个租户要求自定义前缀，
--    需要把 naming_rule 也做成可按租户覆盖，那是另一个需求。
-- ============================================================================
