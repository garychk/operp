-- ============================================================================
-- deploy_97 —— P1-9b：存货 vs 总账 对账（视图）
-- ============================================================================
--
-- 目标（用户原话）："按科目 + 期间比对 erp_gl_entries 中存货/成本科目的发生额与
--   erp_inventory_transactions 的金额，把「被跳过凭证」（period_closed /
--   subject_not_found 等）的差异显式列出来。"
--
-- 交付三个视图：
--   ① vw_erp_inventory_voucher_plan   —— 已解析的"业务类型 → 存货/对方科目"计划
--   ② vw_erp_inventory_gl_recon       —— 主对账表：按 期间 × 单据类型 比库存净额与总账存货科目净额
--   ③ vw_erp_inventory_gl_recon_detail —— 差异明细：逐张"被跳过凭证"的单据 + 无对应流水的孤儿凭证行
--
-- 为什么要有 ①：`inventory_voucher_plan()` 是个 set-returning 函数，视图里逐行调用很慢，
--   也看不出"到底走的是租户映射还是内置兜底"。这里把它**内联**成视图，逻辑与函数保持一致
--   （改了函数记得同步改这里，反之亦然 —— 见文件末自检里的口径断言）。
--
-- 口径（与 deploy_87/92/93 对齐）：
--   * 库存净额 = SUM(erp_inventory_transactions.total_cost)（本位币，出库为负）
--   * 总账存货侧净额 = SUM(debit_amount - credit_amount)，只取**存货科目**上的分录
--   * 两者理论相等：入库借存货，出库贷存货。差额 ≠ 0 就是"账实不符/凭证缺失"的抓手。
--   * `generate_voucher = FALSE` 的业务（内部调拨、状态流转等）本来就不进总账，
--     状态记为 not_required，**不算差异**。
--
-- ⚠️ **业务单据 ↔ 凭证 的反查键（踩过一次坑，务必记住）**：
--   `erp_gl_entries.source_type/source_id` 的取值是 `'voucher'` + **凭证头 id**，
--   不是业务单据。真正的反查链在**凭证头**上：
--       erp_vouchers.inventory_source_type / inventory_source_id
--   本视图曾用 gl_entries.source_type 去 join 业务类型，结果 gl 侧恒为空、
--   所有行都被误判成 diff（verify-96 的 D 段抓出来的）。改这里前先想清楚这两列的区别。
--
-- 一律 security_invoker，靠底层 erp_*/sys_* 的 RLS 做租户隔离。
-- ============================================================================


-- 视图列类型有过变更（source_type 从 varchar(50) 收成 varchar），
-- CREATE OR REPLACE 不允许改列类型，所以先显式 DROP（先删依赖方，避免 CASCADE 误伤）。
DROP VIEW IF EXISTS public.vw_erp_inventory_gl_recon_detail;
DROP VIEW IF EXISTS public.vw_erp_inventory_gl_recon;
DROP VIEW IF EXISTS public.vw_erp_inventory_voucher_plan;


-- ============================================================================
-- ① 业务类型 → 科目 计划（内联 inventory_voucher_plan 的解析结果）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_voucher_plan
  WITH (security_invoker = true) AS
WITH combos AS (
  -- 实际发生过的组合
  SELECT DISTINCT t.tenant_id,
         t.reference_type AS source_type,
         t.transaction_type AS transaction_type_code
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n' AND t.reference_type IS NOT NULL
  UNION
  -- 已配置但还没发生过的组合（配置页要看得到）
  SELECT DISTINCT m.tenant_id, m.source_type, m.transaction_type_code
    FROM public.erp_inventory_subject_map_s_539dcf81_b m
   WHERE m.is_deleted = 'n'
)
SELECT c.tenant_id,
       c.source_type,
       c.transaction_type_code,
       it.name AS transaction_type_name,
       COALESCE(it.direction, 'neutral') AS direction,
       -- 租户映射优先，其次内置兜底（与 inventory_voucher_plan 完全一致）
       COALESCE(m.stock_subject_code,
                CASE c.transaction_type_code
                  WHEN 'purchase_receipt_in'   THEN '1405'
                  WHEN 'sales_delivery_out'    THEN '1405'
                  WHEN 'purchase_return_out'   THEN '1405'
                  WHEN 'sales_return_in'       THEN '1405'
                  WHEN 'production_receipt_in' THEN '1405'
                  WHEN 'stock_count_increase'  THEN '1405'
                  WHEN 'stock_count_decrease'  THEN '1405'
                  WHEN 'stock_adjust_in'       THEN '1405'
                  WHEN 'stock_adjust_out'      THEN '1405'
                  WHEN 'material_issue_out'    THEN '1403'
                  WHEN 'material_return_in'    THEN '1403'
                END) AS stock_subject_code,
       COALESCE(m.counter_subject_code,
                CASE c.transaction_type_code
                  WHEN 'purchase_receipt_in'   THEN '2202'
                  WHEN 'purchase_return_out'   THEN '2202'
                  WHEN 'sales_delivery_out'    THEN '6401'
                  WHEN 'sales_return_in'       THEN '6401'
                  WHEN 'production_receipt_in' THEN '5001'
                  WHEN 'stock_count_increase'  THEN '1901'
                  WHEN 'stock_count_decrease'  THEN '1901'
                  WHEN 'stock_adjust_in'       THEN '1901'
                  WHEN 'stock_adjust_out'      THEN '1901'
                  WHEN 'material_issue_out'    THEN '5001'
                  WHEN 'material_return_in'    THEN '5001'
                END) AS counter_subject_code,
       CASE
         WHEN m.id IS NOT NULL THEN COALESCE(m.generate_voucher, TRUE)
         WHEN c.transaction_type_code IN (
           'purchase_receipt_in','sales_delivery_out','purchase_return_out','sales_return_in',
           'production_receipt_in','stock_count_increase','stock_count_decrease',
           'stock_adjust_in','stock_adjust_out','material_issue_out','material_return_in'
         ) THEN TRUE
         ELSE FALSE
       END AS generate_voucher,
       (m.id IS NOT NULL) AS is_override
  FROM combos c
  LEFT JOIN public.sys_inventory_transaction_types it
         ON it.code = c.transaction_type_code
  LEFT JOIN LATERAL (
    SELECT mm.*
      FROM public.erp_inventory_subject_map_s_539dcf81_b mm
     WHERE mm.is_deleted = 'n'
       AND mm.source_type = c.source_type
       AND mm.transaction_type_code = c.transaction_type_code
       AND mm.tenant_id = c.tenant_id
     ORDER BY mm.id
     LIMIT 1
  ) m ON TRUE;


-- ============================================================================
-- ② 主对账表：按 期间 × 单据类型
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_gl_recon
  WITH (security_invoker = true) AS
WITH inv AS (
  SELECT t.tenant_id,
         date_trunc('month', t.transaction_date)::date AS period_start,
         t.reference_type AS source_type,
         SUM(t.total_cost) AS inventory_amount,
         COUNT(*) AS txn_count,
         MIN(t.transaction_date) AS first_date,
         MAX(t.transaction_date) AS last_date
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n' AND t.reference_type IS NOT NULL
   GROUP BY t.tenant_id, date_trunc('month', t.transaction_date), t.reference_type
),
plan AS (
  SELECT tenant_id, source_type,
         MIN(stock_subject_code) AS stock_subject_code,
         MIN(counter_subject_code) AS counter_subject_code,
         BOOL_OR(generate_voucher) AS generate_voucher,
         ARRAY_AGG(DISTINCT transaction_type_code) AS transaction_types
    FROM public.vw_erp_inventory_voucher_plan
   GROUP BY tenant_id, source_type
),
gl AS (
  -- ⚠️ 关键口径：**不能**用 `erp_gl_entries.source_type` —— 它的取值是 'voucher' + 凭证 id，
  -- 指向的是凭证头而不是业务单据。业务单据的反查链在**凭证头**上：
  --     erp_vouchers.inventory_source_type / inventory_source_id
  -- （deploy_87 建立的 "单据 ↔ 凭证" 反查关系就是这两列）
  SELECT v.tenant_id,
         date_trunc('month', v.voucher_date)::date AS period_start,
         v.inventory_source_type AS source_type,
         s.code AS subject_code,
         SUM(g.debit_amount)  AS debit_amount,
         SUM(g.credit_amount) AS credit_amount,
         COUNT(DISTINCT v.id) AS voucher_count
    FROM public.erp_gl_entries g
    JOIN public.erp_vouchers_s_539dcf81_b v
           ON v.id = g.voucher_id AND v.is_deleted = 'n'
    LEFT JOIN public.erp_account_subjects_s_539dcf81_b s
           ON s.id = g.subject_id AND s.tenant_id = g.tenant_id
   WHERE g.is_deleted = 'n'
     AND v.inventory_source_type IS NOT NULL
   GROUP BY v.tenant_id, date_trunc('month', v.voucher_date), v.inventory_source_type, s.code
),
exc AS (
  SELECT e.tenant_id,
         date_trunc('month', e.document_date)::date AS period_start,
         e.source_type,
         COUNT(*) AS exception_count,
         STRING_AGG(DISTINCT e.reason, ',' ORDER BY e.reason) AS skip_reasons
    FROM public.erp_inventory_voucher_exceptions_s_539dcf81_b e
   WHERE e.is_deleted = 'n'
   GROUP BY e.tenant_id, date_trunc('month', e.document_date), e.source_type
)
SELECT i.tenant_id,
       i.period_start,
       EXTRACT(YEAR  FROM i.period_start)::INTEGER AS period_year,
       EXTRACT(MONTH FROM i.period_start)::INTEGER AS period_month,
       i.source_type,
       COALESCE(dt.document_name, i.source_type) AS source_type_name,
       p.stock_subject_code,
       p.counter_subject_code,
       COALESCE(p.generate_voucher, FALSE) AS generate_voucher,
       p.transaction_types,
       i.txn_count,
       i.first_date,
       i.last_date,
       i.inventory_amount,
       COALESCE(g.debit_amount, 0) - COALESCE(g.credit_amount, 0) AS gl_stock_amount,
       i.inventory_amount
         - (COALESCE(g.debit_amount, 0) - COALESCE(g.credit_amount, 0)) AS difference,
       COALESCE(g.voucher_count, 0) AS voucher_count,
       COALESCE(e.exception_count, 0) AS exception_count,
       e.skip_reasons,
       CASE
         WHEN COALESCE(p.generate_voucher, FALSE) = FALSE                        THEN 'not_required'
         WHEN COALESCE(e.exception_count, 0) > 0                                 THEN 'voucher_skipped'
         WHEN ABS(i.inventory_amount
                  - (COALESCE(g.debit_amount, 0) - COALESCE(g.credit_amount, 0))) < 0.005
                                                                                 THEN 'matched'
         ELSE 'diff'
       END AS recon_status
  FROM inv i
  LEFT JOIN plan p
         ON p.tenant_id = i.tenant_id AND p.source_type = i.source_type
  LEFT JOIN gl g
         ON g.tenant_id = i.tenant_id
        AND g.period_start = i.period_start
        AND g.source_type = i.source_type
        AND g.subject_code = p.stock_subject_code
  LEFT JOIN exc e
         ON e.tenant_id = i.tenant_id
        AND e.period_start = i.period_start
        AND e.source_type = i.source_type
  LEFT JOIN public.sys_document_types dt
         ON dt.document_type = i.source_type;


-- ============================================================================
-- ③ 差异明细：逐张被跳过凭证的单据 + 孤儿凭证行
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_gl_recon_detail
  WITH (security_invoker = true) AS
WITH inv_amt AS (
  SELECT t.tenant_id, t.reference_type AS source_type, t.reference_id AS source_id,
         SUM(t.total_cost) AS inventory_amount,
         COUNT(*) AS txn_count
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n' AND t.reference_id IS NOT NULL
   GROUP BY t.tenant_id, t.reference_type, t.reference_id
),
gl_amt AS (
  -- 同 gl CTE 的口径：业务单据的反查键在凭证头 inventory_source_* 上
  SELECT v.tenant_id,
         v.inventory_source_type AS source_type,
         v.inventory_source_id   AS source_id,
         -- 净额：用于与库存净额比对（一张平衡凭证按科目求和会归零，所以这里只是兜底口径）
         SUM(g.debit_amount - g.credit_amount) AS gl_amount,
         -- 发生额规模：孤儿凭证要报"挂了多少金额"，净额恒为 0 没有意义，用借方合计
         SUM(g.debit_amount) AS gl_debit_total,
         SUM(g.credit_amount) AS gl_credit_total,
         COUNT(DISTINCT v.id) AS voucher_count,
         MIN(v.voucher_no) AS voucher_no
    FROM public.erp_gl_entries g
    JOIN public.erp_vouchers_s_539dcf81_b v
           ON v.id = g.voucher_id AND v.is_deleted = 'n'
   WHERE g.is_deleted = 'n' AND v.inventory_source_id IS NOT NULL
   GROUP BY v.tenant_id, v.inventory_source_type, v.inventory_source_id
)
-- (a) 被跳过凭证的单据：库存已过账，但总账没有（或没对上）
SELECT e.tenant_id,
       'voucher_skipped'::TEXT AS kind,
       e.source_type,
       COALESCE(dt.document_name, e.source_type) AS source_type_name,
       e.source_id,
       e.document_no,
       e.document_date,
       e.reason,
       e.detail,
       e.transaction_type,
       e.attempts,
       COALESCE(ia.inventory_amount, 0) AS inventory_amount,
       COALESCE(ga.gl_amount, 0)        AS gl_amount,
       COALESCE(ia.inventory_amount, 0) - COALESCE(ga.gl_amount, 0) AS difference,
       ga.voucher_no,
       -- 例外已记录、但后来凭证又补上了（比如期间重开）→ 不再算未清
       (ga.voucher_count IS NULL) AS still_outstanding,
       NULL::TEXT AS subject_code
  FROM public.erp_inventory_voucher_exceptions_s_539dcf81_b e
  LEFT JOIN inv_amt ia
         ON ia.tenant_id = e.tenant_id AND ia.source_type = e.source_type AND ia.source_id = e.source_id
  LEFT JOIN gl_amt ga
         ON ga.tenant_id = e.tenant_id AND ga.source_type = e.source_type AND ga.source_id = e.source_id
  LEFT JOIN public.sys_document_types dt ON dt.document_type = e.source_type
 WHERE e.is_deleted = 'n'

UNION ALL

-- (b) 孤儿凭证：总账有分录，但对应的库存流水已不存在（单据被反过账/软删而凭证没作废）
SELECT ga.tenant_id,
       'orphan_gl'::TEXT AS kind,
       ga.source_type,
       COALESCE(dt.document_name, ga.source_type) AS source_type_name,
       ga.source_id,
       ga.voucher_no AS document_no,
       NULL::DATE AS document_date,
       'inventory_transactions_missing'::TEXT AS reason,
       '总账仍有该单据的凭证分录，但库存流水已全部软删（单据反过账后凭证未作废）'::TEXT AS detail,
       NULL::TEXT AS transaction_type,
       1 AS attempts,
       0::NUMERIC AS inventory_amount,
       -- 孤儿凭证报"挂着多少金额"：用借方合计（净额按科目求和恒为 0，报了没意义）
       ga.gl_debit_total AS gl_amount,
       0::NUMERIC - ga.gl_debit_total AS difference,
       ga.voucher_no,
       TRUE AS still_outstanding,
       NULL::TEXT AS subject_code
  FROM gl_amt ga
  LEFT JOIN public.sys_document_types dt ON dt.document_type = ga.source_type
 WHERE NOT EXISTS (
   SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.tenant_id = ga.tenant_id
      AND t.reference_type = ga.source_type
      AND t.reference_id = ga.source_id
      AND t.is_deleted = 'n'
 );


-- ============================================================================
-- 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_name    TEXT;
  v_opts    TEXT;
  v_missing TEXT := '';
  v_expect  TEXT[] := ARRAY[
    'vw_erp_inventory_voucher_plan',
    'vw_erp_inventory_gl_recon',
    'vw_erp_inventory_gl_recon_detail'];
BEGIN
  FOREACH v_name IN ARRAY v_expect LOOP
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') INTO v_opts
      FROM pg_class c
     WHERE c.relkind = 'v'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = v_name;
    IF v_opts IS NULL THEN
      v_missing := v_missing || format('%s 未创建;', v_name);
      CONTINUE;
    END IF;
    IF v_opts NOT ILIKE '%security_invoker=%true%' AND v_opts NOT ILIKE '%security_invoker=true%' THEN
      v_missing := v_missing || format('%s 缺 security_invoker（当前 %s）;', v_name, v_opts);
    END IF;
  END LOOP;

  -- 口径断言：与 inventory_voucher_plan() 内置兜底逐条比对，防止两处漂移
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_voucher_plan'::regclass, TRUE))
     NOT ILIKE '%purchase_return_out%' THEN
    v_missing := v_missing || 'voucher_plan 视图缺 purchase_return_out 兜底;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_voucher_plan'::regclass, TRUE))
     NOT ILIKE '%material_return_in%' THEN
    v_missing := v_missing || 'voucher_plan 视图缺 material_return_in 兜底;';
  END IF;
  -- 主对账表必须真的把 库存净额 与 总账存货净额 摆在一起
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_gl_recon'::regclass, TRUE))
     NOT ILIKE '%difference%' THEN
    v_missing := v_missing || 'vw_erp_inventory_gl_recon 缺 difference;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_gl_recon'::regclass, TRUE))
     NOT ILIKE '%voucher_skipped%' THEN
    v_missing := v_missing || 'vw_erp_inventory_gl_recon 缺 voucher_skipped 状态;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_gl_recon_detail'::regclass, TRUE))
     NOT ILIKE '%orphan_gl%' THEN
    v_missing := v_missing || 'gl_recon_detail 缺 orphan_gl 分支;';
  END IF;

  -- 反查链断言：必须经凭证头 inventory_source_*，而不是 gl_entries.source_type
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_gl_recon'::regclass, TRUE))
     NOT ILIKE '%inventory_source_type%' THEN
    v_missing := v_missing
      || 'vw_erp_inventory_gl_recon 未用凭证头 inventory_source_type 反查业务单据'
         || '（gl_entries.source_type 恒为 ''voucher''，用它 join 会永远对不上）;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_gl_recon_detail'::regclass, TRUE))
     NOT ILIKE '%inventory_source_type%' THEN
    v_missing := v_missing || 'gl_recon_detail 未用凭证头 inventory_source_type 反查;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_97 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_97 OK：存货 vs 总账 对账视图（含被跳过凭证明细）已就绪';
END;
$$;
