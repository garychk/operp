-- Financial reporting views for general ledger queries.

CREATE OR REPLACE VIEW public.vw_erp_gl_balance AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS period_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS period_credit
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id;

CREATE OR REPLACE VIEW public.vw_erp_trial_balance AS
SELECT
  e.period_id,
  SUM(COALESCE(e.debit_amount, 0)) AS total_debit,
  SUM(COALESCE(e.credit_amount, 0)) AS total_credit,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS balance_diff
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id;

CREATE OR REPLACE VIEW public.vw_erp_subject_balance AS
SELECT
  e.period_id,
  e.subject_id,
  SUM(COALESCE(e.debit_amount, 0)) AS debit_total,
  SUM(COALESCE(e.credit_amount, 0)) AS credit_total,
  SUM(COALESCE(e.debit_amount, 0)) - SUM(COALESCE(e.credit_amount, 0)) AS net_amount
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n'
GROUP BY e.period_id, e.subject_id;

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
  e.updated_at
FROM public.erp_gl_entries e
WHERE e.is_deleted = 'n';
