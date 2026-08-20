
CREATE OR REPLACE FUNCTION public.finance_subject_id(p_codes TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public
AS $$
DECLARE v_id INTEGER;
BEGIN
  SELECT id INTO v_id FROM public.erp_account_subjects_s_539dcf81_b
  WHERE code = ANY(p_codes) AND is_deleted = 'n' AND status = 'active'
  ORDER BY array_position(p_codes, code) LIMIT 1;
  RETURN v_id;
END;
$$;
-- Step 7: fixed-asset depreciation and receivable/payable settlement.
-- 应收/应付账款核销（结算）记录表
CREATE TABLE IF NOT EXISTS public.erp_ar_ap_settlements (
  id BIGSERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settlement_type VARCHAR(20) NOT NULL CHECK (settlement_type IN ('receivable', 'payable')),
  source_id INTEGER NOT NULL,
  period_id INTEGER NOT NULL REFERENCES public.erp_accounting_periods_s_539dcf81_b(id),
  amount NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
  settlement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  remark TEXT,
  idempotency_key UUID NOT NULL,
  settled_by INTEGER,
  voucher_id INTEGER REFERENCES public.erp_vouchers_s_539dcf81_b(id),
  UNIQUE (settlement_type, source_id, idempotency_key)
);

ALTER TABLE public.erp_ar_ap_settlements
  ADD COLUMN IF NOT EXISTS voucher_id INTEGER REFERENCES public.erp_vouchers_s_539dcf81_b(id);

CREATE INDEX IF NOT EXISTS idx_erp_ar_ap_settlements_source
  ON public.erp_ar_ap_settlements(settlement_type, source_id, is_deleted);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_depreciation_active_period
  ON public.erp_depreciation_records_s_539dcf81_b(asset_id, period_id)
  WHERE is_deleted = 'n';

CREATE OR REPLACE FUNCTION public.accrue_asset_depreciation(
  p_asset_id INTEGER,
  p_period_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  a RECORD;
  p RECORD;
  amount NUMERIC(18, 2);
  new_accum NUMERIC(18, 2);
  new_net NUMERIC(18, 2);
  v_voucher_id INTEGER;
  debit_subject_id INTEGER;
  credit_subject_id INTEGER;
  actor INTEGER := public.current_sys_user_id();
BEGIN
  IF p_asset_id IS NULL OR p_period_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Asset, period and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM public.erp_fixed_assets_s_539dcf81_b
    WHERE id = p_asset_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Asset does not exist or is deleted' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO p FROM public.erp_accounting_periods_s_539dcf81_b
    WHERE id = p_period_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002'; END IF;
  IF COALESCE(p.is_locked, FALSE) OR COALESCE(p.is_closed, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is closed or locked' USING ERRCODE = '55000';
  END IF;
  IF NOT COALESCE(p.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not enabled' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_depreciation_records_s_539dcf81_b
             WHERE asset_id = p_asset_id AND period_id = p_period_id AND is_deleted = 'n') THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'asset_id', p_asset_id, 'period_id', p_period_id);
  END IF;
  IF COALESCE(a.useful_life_months, 0) <= 0 OR COALESCE(a.original_value, 0) <= 0 THEN
    RAISE EXCEPTION 'Asset useful life and original value must be positive' USING ERRCODE = '23514';
  END IF;
  amount := ROUND(GREATEST(
    (COALESCE(a.original_value, 0) * (1 - CASE WHEN COALESCE(a.residual_rate, 0) > 1 THEN COALESCE(a.residual_rate, 0) / 100 ELSE COALESCE(a.residual_rate, 0) END)) /
      a.useful_life_months,
    0
  ), 2);
  amount := LEAST(amount, GREATEST(COALESCE(a.net_value, a.original_value, 0), 0));
  IF amount <= 0 THEN RAISE EXCEPTION 'Asset has no depreciable net value' USING ERRCODE = '23514'; END IF;
  new_accum := COALESCE(a.accumulated_depreciation, 0) + amount;
  new_net := GREATEST(COALESCE(a.original_value, 0) - new_accum, 0);
  debit_subject_id := public.finance_subject_id(ARRAY['6602', '6601']);
  credit_subject_id := public.finance_subject_id(ARRAY['1602']);
  IF debit_subject_id IS NULL OR credit_subject_id IS NULL THEN
    RAISE EXCEPTION 'Depreciation subjects are missing: expense 6602/6601 and accumulated depreciation 1602 are required' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.erp_depreciation_records_s_539dcf81_b
    (corp_id, emp_id, asset_id, period_id, depreciation_amount, accumulated_depreciation, net_value)
  VALUES (a.corp_id, a.emp_id, p_asset_id, p_period_id, amount, new_accum, new_net);
  UPDATE public.erp_fixed_assets_s_539dcf81_b
    SET accumulated_depreciation = new_accum, net_value = new_net, updated_at = NOW()
    WHERE id = p_asset_id;
  INSERT INTO public.erp_vouchers_s_539dcf81_b
    (corp_id, emp_id, voucher_no, voucher_date, period_id, type, source_doc_no, total_amount, remark, status)
  VALUES (a.corp_id, a.emp_id, format('DEP-%s-%s', p_asset_id, p_period_id), p.end_date, p_period_id, 'general', a.asset_no, amount, '固定资产折旧', 'draft')
  RETURNING id INTO v_voucher_id;
  INSERT INTO public.erp_voucher_details_s_539dcf81_b
    (corp_id, emp_id, voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
  VALUES
    (a.corp_id, a.emp_id, v_voucher_id, 1, debit_subject_id, '计提固定资产折旧', amount, 0),
    (a.corp_id, a.emp_id, v_voucher_id, 2, credit_subject_id, '计提固定资产折旧', 0, amount);
  PERFORM public.post_voucher_document(v_voucher_id, p_idempotency_key);
  UPDATE public.erp_depreciation_records_s_539dcf81_b SET voucher_id = v_voucher_id
    WHERE asset_id = p_asset_id AND period_id = p_period_id AND is_deleted = 'n';
  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE, 'asset_id', p_asset_id,
    'period_id', p_period_id, 'depreciation_amount', amount, 'net_value', new_net);
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_ar_ap(
  p_settlement_type VARCHAR,
  p_source_id INTEGER,
  p_period_id INTEGER,
  p_amount NUMERIC,
  p_settlement_date DATE,
  p_remark TEXT,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  r RECORD;
  p RECORD;
  balance NUMERIC;
  v_voucher_id INTEGER;
  debit_subject_id INTEGER;
  credit_subject_id INTEGER;
  actor INTEGER := public.current_sys_user_id();
BEGIN
  IF p_settlement_type NOT IN ('receivable', 'payable') OR p_source_id IS NULL OR
     p_period_id IS NULL OR p_amount IS NULL OR p_amount <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Settlement parameters are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM public.erp_accounting_periods_s_539dcf81_b
    WHERE id = p_period_id AND is_deleted = 'n' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002'; END IF;
  IF COALESCE(p.is_locked, FALSE) OR COALESCE(p.is_closed, FALSE) OR NOT COALESCE(p.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not open for settlement' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.erp_ar_ap_settlements
             WHERE settlement_type = p_settlement_type AND source_id = p_source_id
               AND idempotency_key = p_idempotency_key AND is_deleted = 'n') THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'source_id', p_source_id);
  END IF;
  IF p_settlement_type = 'receivable' THEN
    SELECT * INTO r FROM public.erp_receivables_s_539dcf81_b WHERE id = p_source_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT * INTO r FROM public.erp_payables_s_539dcf81_b WHERE id = p_source_id AND is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Settlement source does not exist or is deleted' USING ERRCODE = 'P0002'; END IF;
  balance := COALESCE(r.balance, COALESCE(r.amount, 0) - COALESCE(r.paid_amount, 0));
  IF p_amount > balance + 0.005 THEN RAISE EXCEPTION 'Settlement amount exceeds outstanding balance' USING ERRCODE = '23514'; END IF;
  IF p_settlement_type = 'receivable' THEN
    debit_subject_id := public.finance_subject_id(ARRAY['1002', '1001']);
    credit_subject_id := public.finance_subject_id(ARRAY['1122']);
  ELSE
    debit_subject_id := public.finance_subject_id(ARRAY['2202']);
    credit_subject_id := public.finance_subject_id(ARRAY['1002', '1001']);
  END IF;
  IF debit_subject_id IS NULL OR credit_subject_id IS NULL THEN
    RAISE EXCEPTION 'Settlement subjects are missing: AR 1122, AP 2202, bank 1002 or cash 1001 are required' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.erp_ar_ap_settlements
    (corp_id, emp_id, settlement_type, source_id, period_id, amount, settlement_date, remark, idempotency_key, settled_by)
  VALUES (r.corp_id, r.emp_id, p_settlement_type, p_source_id, p_period_id, p_amount,
    COALESCE(p_settlement_date, CURRENT_DATE), p_remark, p_idempotency_key, actor);
  IF p_settlement_type = 'receivable' THEN
    UPDATE public.erp_receivables_s_539dcf81_b ar SET paid_amount = COALESCE(ar.paid_amount, 0) + p_amount,
      balance = COALESCE(ar.balance, 0) - p_amount,
      status = CASE WHEN COALESCE(ar.balance, 0) - p_amount <= 0.005 THEN 'closed' ELSE 'partially_paid' END,
      updated_at = NOW() WHERE ar.id = p_source_id;
  ELSE
    UPDATE public.erp_payables_s_539dcf81_b ap SET paid_amount = COALESCE(ap.paid_amount, 0) + p_amount,
      balance = COALESCE(ap.balance, 0) - p_amount,
      status = CASE WHEN COALESCE(ap.balance, 0) - p_amount <= 0.005 THEN 'closed' ELSE 'partially_paid' END,
      updated_at = NOW() WHERE ap.id = p_source_id;
  END IF;
  INSERT INTO public.erp_vouchers_s_539dcf81_b
    (corp_id, emp_id, voucher_no, voucher_date, period_id, type, source_doc_no, total_amount, remark, status)
  VALUES (r.corp_id, r.emp_id, format('SET-%s-%s-%s', p_settlement_type, p_source_id, p_period_id), COALESCE(p_settlement_date, CURRENT_DATE), p_period_id, 'general', r.doc_no, p_amount, CASE WHEN p_settlement_type = 'receivable' THEN '应收账款核销' ELSE '应付账款核销' END, 'draft')
  RETURNING id INTO v_voucher_id;
  INSERT INTO public.erp_voucher_details_s_539dcf81_b
    (corp_id, emp_id, voucher_id, line_no, subject_id, summary, debit_amount, credit_amount)
  VALUES
    (r.corp_id, r.emp_id, v_voucher_id, 1, debit_subject_id, '往来核销', CASE WHEN p_settlement_type = 'receivable' THEN p_amount ELSE p_amount END, 0),
    (r.corp_id, r.emp_id, v_voucher_id, 2, credit_subject_id, '往来核销', 0, p_amount);
  PERFORM public.post_voucher_document(v_voucher_id, p_idempotency_key);
  UPDATE public.erp_ar_ap_settlements SET voucher_id = v_voucher_id
    WHERE settlement_type = p_settlement_type AND source_id = p_source_id AND idempotency_key = p_idempotency_key;
  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE, 'source_id', p_source_id, 'settled_amount', p_amount, 'voucher_id', v_voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.accrue_asset_depreciation(INTEGER, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accrue_asset_depreciation(INTEGER, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID) TO authenticated;
