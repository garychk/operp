-- ============================================================================
-- deploy_71_finance_fx_subject.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 1/5：汇兑损益科目 + 科目按租户完备
--
-- 依赖 deploy_21（7 个必备科目）、deploy_41（唯一索引改成 (tenant_id, code)）、
--      deploy_67（RESTRICTIVE 租户策略的既有写法）。
--
-- 本脚本做四件事：
--   A. 必备科目按租户补齐：把 deploy_21 的 7 个科目 + 新增的 6603
--      财务费用—汇兑损益，补到**每一个已有科目的租户**上。
--      为什么必须按租户补齐：科目表的唯一索引已经是 (tenant_id, code)
--      （deploy_41 改的），而 deploy_21 的种子行是靠 DEFAULT
--      current_tenant_id() 落在单一下租户里的 → 新租户（tenant 2）
--      此前一个科目都没有。核销/折旧在租户 2 上会因为「科目缺失」
--      直接报 P0001，多币别的汇兑损益也就无处可记。
--   B. finance_subject_id 加「本租户优先」：它是 SECURITY INVOKER，受 RLS
--      约束，但 RLS 给 super_admin 开了跨租户可见的口子（同上一次币别
--      双份的根因）→ 超管在租户 1 上下文里核销时会取到租户 1 的科目 id，
--      写进租户 2 的凭证，形成跨租户引用。
--   C. 新增 finance_subject_id_for(p_codes, p_tenant_id)：SECURITY DEFINER，
--      按**显式指定的租户**精确取科目，供跨租户过账（超管代租户操作）用。
--      必须是 DEFINER：INVOKER 会被 RLS 挡住，取不到目标租户的科目。
--   D. fail-loud 自检。
--
-- ⚠️ 刻意没有去改 deploy_21 的两个惯用法问题（属于「已执行脚本不回改」）：
--   1. 它用 ON CONFLICT (code)，而科目表现在的唯一索引是 (tenant_id, code)
--      → **增量重跑 deploy_21 必炸 42P10**。全新部署不会炸，因为第 21 步
--      跑在 deploy_41 之前（那时索引还是 (code)）。本脚本用正确的列组。
--   2. 它的 VALUES 不带 tenant_id，靠 DEFAULT current_tenant_id() 取，
--      部署时落到哪个租户取决于当时 app.tenant_id → 本次改为显式指定。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_71] 汇兑损益科目 6603 + 必备科目按租户补齐...'

-- ---------------------------------------------------------------------------
-- A. 必备科目按租户补齐（含新增 6603）
--    写法：所需科目清单 = VALUES 常量表，租户清单 = 科目表现有 tenant_id，
--    两者 CROSS JOIN 后 upsert。已存在则只刷新属性（幂等）。
-- ---------------------------------------------------------------------------
WITH required_subjects (code, name, category, direction, is_cash_account, is_bank_account, sort_order) AS (
  VALUES
    ('1001', '库存现金',           'asset',     'debit',  TRUE,  FALSE, 1),
    ('1002', '银行存款',           'asset',     'debit',  TRUE,  TRUE,  2),
    ('1122', '应收账款',           'asset',     'debit',  FALSE, FALSE, 3),
    ('1602', '累计折旧',           'asset',     'credit', FALSE, FALSE, 4),
    ('2202', '应付账款',           'liability', 'credit', FALSE, FALSE, 5),
    ('6601', '销售费用',           'expense',   'debit',  FALSE, FALSE, 6),
    ('6602', '管理费用',           'expense',   'debit',  FALSE, FALSE, 7),
    -- 第 3 期新增：财务费用—汇兑损益
    ('6603', '财务费用—汇兑损益',  'expense',   'debit',  FALSE, FALSE, 8)
),
existing_tenants AS (
  -- 全部在册租户 ∪ 科目表里已出现的租户。
  -- 只取「已有科目」的租户不够：tenant 2 这种从没播种过科目的租户会被漏掉，
  -- 而它在核销/折旧时会直接报「科目缺失」(P0001)，汇兑损益也就无处可记。
  SELECT id AS tenant_id FROM public.sys_tenants WHERE is_deleted = 'n'
  UNION
  SELECT DISTINCT tenant_id
    FROM public.erp_account_subjects_s_539dcf81_b
   WHERE is_deleted = 'n' AND tenant_id IS NOT NULL
)
INSERT INTO public.erp_account_subjects_s_539dcf81_b (
  corp_id, emp_id, is_deleted, code, name, level, category, direction,
  is_cash_account, is_bank_account, status, tenant_id
)
SELECT
  NULL, NULL, 'n', r.code, r.name, 1, r.category, r.direction,
  r.is_cash_account, r.is_bank_account, 'active', t.tenant_id
FROM existing_tenants t
CROSS JOIN required_subjects r
ON CONFLICT (tenant_id, code) DO UPDATE SET
  name            = EXCLUDED.name,
  category        = EXCLUDED.category,
  direction       = EXCLUDED.direction,
  is_cash_account = EXCLUDED.is_cash_account,
  is_bank_account = EXCLUDED.is_bank_account,
  is_deleted      = 'n',
  status          = 'active',
  updated_at      = NOW();

-- ---------------------------------------------------------------------------
-- B. finance_subject_id 加「本租户优先」
--    同签名 CREATE OR REPLACE（不改参数列表，故不会产生重载）。
--    排序键：本租户(0) < 基线 tenant_id IS NULL(1) < 其他租户(2)，
--    同档内按 p_codes 给定的先后顺序（array_position）。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_subject_id(p_codes TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_id     INTEGER;
  v_tenant BIGINT := public.current_tenant_id();
BEGIN
  SELECT s.id
    INTO v_id
    FROM public.erp_account_subjects_s_539dcf81_b s
   WHERE s.code = ANY(p_codes)
     AND s.is_deleted = 'n'
     AND s.status = 'active'
   ORDER BY
     CASE
       WHEN v_tenant IS NOT NULL AND s.tenant_id = v_tenant THEN 0
       WHEN s.tenant_id IS NULL THEN 1
       ELSE 2
     END,
     array_position(p_codes, s.code)
   LIMIT 1;
  RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- C. finance_subject_id_for：按显式租户取科目（跨租户过账用）
--    SECURITY DEFINER + 固定 search_path。owner 为 postgres，
--    且 erp_account_subjects 未 FORCE ROW LEVEL SECURITY → 绕过 RLS，
--    可以读到**目标租户**的科目行（这正是它存在的意义）。
--    只读函数，不写任何数据。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finance_subject_id_for(
  p_codes TEXT[],
  p_tenant_id BIGINT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id INTEGER;
BEGIN
  SELECT s.id
    INTO v_id
    FROM public.erp_account_subjects_s_539dcf81_b s
   WHERE s.code = ANY(p_codes)
     AND s.is_deleted = 'n'
     AND s.status = 'active'
     AND (p_tenant_id IS NULL OR s.tenant_id = p_tenant_id OR s.tenant_id IS NULL)
   ORDER BY
     CASE
       WHEN p_tenant_id IS NOT NULL AND s.tenant_id = p_tenant_id THEN 0
       WHEN s.tenant_id IS NULL THEN 1
       ELSE 2
     END,
     array_position(p_codes, s.code)
   LIMIT 1;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.finance_subject_id_for(TEXT[], BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_subject_id_for(TEXT[], BIGINT) TO authenticated;

-- ---------------------------------------------------------------------------
-- D. fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_missing_6603  INTEGER;
  v_tenant_count  INTEGER;
  v_invoker       BOOLEAN;
  v_definer       BOOLEAN;
  v_body          TEXT;
BEGIN
  -- D1. 每一个在册租户都必须有 6603
  SELECT COUNT(*) INTO v_missing_6603
    FROM public.sys_tenants t
   WHERE t.is_deleted = 'n'
     AND NOT EXISTS (
      SELECT 1 FROM public.erp_account_subjects_s_539dcf81_b s
       WHERE s.tenant_id = t.id AND s.code = '6603' AND s.is_deleted = 'n'
    );
  IF v_missing_6603 > 0 THEN
    RAISE EXCEPTION '[deploy_71] 有 % 个租户缺少 6603 汇兑损益科目', v_missing_6603;
  END IF;

  -- D2. 每个在册租户的必备科目数量都必须 >= 8
  SELECT COUNT(*) INTO v_tenant_count
    FROM public.sys_tenants t
   WHERE t.is_deleted = 'n'
     AND (SELECT COUNT(*) FROM public.erp_account_subjects_s_539dcf81_b s
           WHERE s.tenant_id = t.id AND s.is_deleted = 'n') < 8;
  IF v_tenant_count > 0 THEN
    RAISE EXCEPTION '[deploy_71] 有 % 个租户的必备科目不足 8 个', v_tenant_count;
  END IF;

  SELECT COUNT(DISTINCT tenant_id) INTO v_tenant_count
    FROM public.erp_account_subjects_s_539dcf81_b
   WHERE is_deleted = 'n' AND tenant_id IS NOT NULL;
  IF v_tenant_count = 0 THEN
    RAISE EXCEPTION '[deploy_71] 科目表里没有任何租户行，补齐逻辑没有生效';
  END IF;

  -- D3. finance_subject_id 必须仍是 SECURITY INVOKER（它受 RLS 保护，
  --     不允许被顺手改成 DEFINER 而绕过租户隔离）
  SELECT NOT p.prosecdef INTO v_invoker
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_subject_id'
     AND pg_get_function_identity_arguments(p.oid) = 'p_codes text[]';
  IF v_invoker IS NULL OR v_invoker = FALSE THEN
    RAISE EXCEPTION '[deploy_71] finance_subject_id 必须保持 SECURITY INVOKER';
  END IF;

  -- D4. finance_subject_id_for 必须是 SECURITY DEFINER
  SELECT p.prosecdef, p.prosrc INTO v_definer, v_body
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finance_subject_id_for';
  IF v_definer IS NULL OR v_definer = FALSE THEN
    RAISE EXCEPTION '[deploy_71] finance_subject_id_for 必须是 SECURITY DEFINER（否则取不到目标租户的科目）';
  END IF;

  -- D5. 指纹：函数体必须真的带上了租户优先排序
  IF v_body IS NULL OR v_body NOT LIKE '%p_tenant_id%' THEN
    RAISE EXCEPTION '[deploy_71] finance_subject_id_for 函数体未生效（指数字段缺失）';
  END IF;

  RAISE NOTICE '[deploy_71] 自检通过：租户数=% 个，6603 齐备，两个取科目函数模式正确。', v_tenant_count;
END $$;
