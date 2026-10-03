-- ============================================================================
-- deploy_75_finance_report_currency_views.sql
-- 多币别改造 · 第 3 期（财务）· 步骤 5/5：报表视图的租户与双金额口径
--
-- 依赖 deploy_72（gl_entries 的双金额列）、deploy_74（fx_revaluation 表）。
--
-- 本脚本改什么、为什么：
--
--  1) 原 4 个视图**没有 tenant_id 维度**。erp_gl_entries 的 RLS 给 super_admin
--     开了跨租户可见的口子，所以超管打开试算平衡时，看到的是**两个租户加在
--     一起**的借贷合计 —— 试算仍然"平"，但那是个没有意义的平（USD 和 CNY
--     相加也不会报错，风险 4「跨单据汇总静默串币」的账务版）。
--     修法：把 tenant_id 加进分组维度。视图本身是 SECURITY INVOKER，
--     底层表 RLS 照旧生效，加列只是让"按租户分行"成为可能。
--
--  2) CREATE OR REPLACE VIEW 的硬约束：**只能在列尾追加**，不能改已有列的
--     名字/类型/顺序（否则报 cannot change name of view column）。
--     所以 tenant_id 一律加在最后，不追求"更好看的列序"。
--
--  3) 凭证/总账的双金额（debit_amount 本位币 / debit_fc 原币）在
--     vw_erp_ledger_detail 里补齐；试算平衡与科目余额**只按本位币口径**
--     汇总，原币列一概不参与——这是"本位币记账 + 原币辅助"的落点。
--
--  4) 新增 vw_erp_ar_ap_open：外币未核销余额视图，把「账面本位币」
--     与「按单据汇率折算的本位币」并列，差额即**已累计确认的调汇额**，
--     是期末调汇前的体检表。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_75] 报表视图租户维度 + 双金额口径...'

-- ---------------------------------------------------------------------------
-- 1) vw_erp_gl_balance：按 (租户, 期间, 科目) 汇总本位币借贷
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_gl_balance AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS period_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS period_credit,
  e.tenant_id
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id, e.tenant_id;

-- ---------------------------------------------------------------------------
-- 2) vw_erp_trial_balance：试算平衡**本位币口径**，按租户分组
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_trial_balance AS
SELECT
  e.period_id,
  SUM(COALESCE(e.debit_amount, 0)) AS total_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS total_credit,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS balance_diff,
  e.tenant_id
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.tenant_id;

-- ---------------------------------------------------------------------------
-- 3) vw_erp_subject_balance：同上，科目粒度
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_subject_balance AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS debit_total,
  SUM(COALESCE(e.credit_amount, 0)) AS credit_total,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS net_amount,
  e.tenant_id
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id, e.tenant_id;

-- ---------------------------------------------------------------------------
-- 4) vw_erp_ledger_detail：明细补租户与双金额
--    前 20 列必须与旧定义逐字一致（顺序、名字），只在后面追加 5 列。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_ledger_detail AS
SELECT
  e.id,
  e.period_id,
  e.subject_id,
  e.voucher_id,
  e.voucher_detail_id,
  e.voucher_no,
  e.voucher_date,
  e.summary,
  e.debit_amount,
  e.credit_amount,
  e.source_type,
  e.source_id,
  e.source_detail_id,
  e.posted_at,
  e.posted_by,
  e.corp_id,
  e.emp_id,
  e.is_deleted,
  e.created_at,
  e.updated_at,
  e.tenant_id,
  e.currency,
  e.exchange_rate,
  e.debit_fc,
  e.credit_fc
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n';

-- ---------------------------------------------------------------------------
-- 5) vw_erp_ar_ap_open：外币未核销余额（含"已累计调汇额"）
--    base_balance                    账面本位币余额（已被调汇改写）
--    base_balance_at_doc_rate        按单据汇率折算的本位币余额
--    revalued_fx                     两者之差 = 已累计确认的调汇差额
--                                    正数：账面高于单据汇率口径
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.vw_erp_ar_ap_open AS
SELECT
  'receivable'::TEXT                                       AS object_type,
  r.id                                                     AS object_id,
  r.tenant_id                                              AS tenant_id,
  r.doc_no                                                 AS doc_no,
  r.doc_date                                               AS doc_date,
  r.due_date                                               AS due_date,
  r.customer_id                                            AS party_id,
  r.currency                                               AS currency,
  r.exchange_rate                                          AS exchange_rate,
  r.amount                                                 AS original_amount,
  r.paid_amount                                            AS paid_original_amount,
  r.balance                                                AS open_original_amount,
  r.base_amount                                            AS base_amount,
  r.base_paid_amount                                       AS base_paid_amount,
  r.base_balance                                           AS base_balance,
  ROUND(r.balance * COALESCE(r.exchange_rate, 1), 2)       AS base_balance_at_doc_rate,
  r.base_balance - ROUND(r.balance * COALESCE(r.exchange_rate, 1), 2) AS revalued_fx,
  r.status                                                 AS status
FROM public.erp_receivables_s_539dcf81_b r
WHERE r.is_deleted = 'n' AND COALESCE(r.balance, 0) <> 0
UNION ALL
SELECT
  'payable'::TEXT,
  p.id,
  p.tenant_id,
  p.doc_no,
  p.doc_date,
  p.due_date,
  p.supplier_id,
  p.currency,
  p.exchange_rate,
  p.amount,
  p.paid_amount,
  p.balance,
  p.base_amount,
  p.base_paid_amount,
  p.base_balance,
  ROUND(p.balance * COALESCE(p.exchange_rate, 1), 2),
  p.base_balance - ROUND(p.balance * COALESCE(p.exchange_rate, 1), 2),
  p.status
FROM public.erp_payables_s_539dcf81_b p
WHERE p.is_deleted = 'n' AND COALESCE(p.balance, 0) <> 0;

COMMENT ON VIEW public.vw_erp_ar_ap_open IS
  '外币未核销往来余额。revalued_fx = 账面本位币余额 − 按单据汇率折算额，即已累计确认的调汇差额。';

GRANT SELECT ON public.vw_erp_ar_ap_open TO authenticated;

-- ---------------------------------------------------------------------------
-- 6) fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cols  TEXT;
  v_def   TEXT;
  v_miss  TEXT := '';
BEGIN
  -- 6.1 四个既有视图的列尾必须追加到位（顺序无关，按存在性判断）
  SELECT string_agg(t.v || '.' || t.c, ', ') INTO v_miss
    FROM (VALUES
      ('vw_erp_gl_balance', 'tenant_id'),
      ('vw_erp_trial_balance', 'tenant_id'),
      ('vw_erp_subject_balance', 'tenant_id'),
      ('vw_erp_ledger_detail', 'tenant_id'),
      ('vw_erp_ledger_detail', 'currency'),
      ('vw_erp_ledger_detail', 'exchange_rate'),
      ('vw_erp_ledger_detail', 'debit_fc'),
      ('vw_erp_ledger_detail', 'credit_fc'),
      ('vw_erp_ar_ap_open', 'revalued_fx'),
      ('vw_erp_ar_ap_open', 'base_balance_at_doc_rate')
    ) AS t(v, c)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = t.v AND ic.column_name = t.c
   );
  IF v_miss <> '' THEN
    RAISE EXCEPTION '[deploy_75] 以下视图列缺失：%', v_miss;
  END IF;

  -- 6.2 前 20 列不能被动过（CREATE OR REPLACE VIEW 的硬约束，这里做回归断言）
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_erp_ledger_detail'
     AND ordinal_position <= 20;
  IF v_cols <> 'id,period_id,subject_id,voucher_id,voucher_detail_id,voucher_no,voucher_date,summary,debit_amount,credit_amount,source_type,source_id,source_detail_id,posted_at,posted_by,corp_id,emp_id,is_deleted,created_at,updated_at' THEN
    RAISE EXCEPTION '[deploy_75] vw_erp_ledger_detail 的前 20 列被改动了：%', v_cols;
  END IF;

  -- 6.3 三个聚合视图必须真的按租户分组（指纹：定义里出现 tenant_id 的 GROUP BY）
  SELECT pg_get_viewdef('public.vw_erp_trial_balance'::regclass, true) INTO v_def;
  IF v_def NOT LIKE '%GROUP BY%tenant_id%' THEN
    RAISE EXCEPTION '[deploy_75] vw_erp_trial_balance 未按租户分组（跨租户相加会静默出错）';
  END IF;

  SELECT pg_get_viewdef('public.vw_erp_subject_balance'::regclass, true) INTO v_def;
  IF v_def NOT LIKE '%GROUP BY%tenant_id%' THEN
    RAISE EXCEPTION '[deploy_75] vw_erp_subject_balance 未按租户分组';
  END IF;

  SELECT pg_get_viewdef('public.vw_erp_gl_balance'::regclass, true) INTO v_def;
  IF v_def NOT LIKE '%GROUP BY%tenant_id%' THEN
    RAISE EXCEPTION '[deploy_75] vw_erp_gl_balance 未按租户分组';
  END IF;

  RAISE NOTICE '[deploy_75] 自检通过：3 个聚合视图已按租户分组，明细视图补齐双金额，外币余额视图就位。';
END $$;
