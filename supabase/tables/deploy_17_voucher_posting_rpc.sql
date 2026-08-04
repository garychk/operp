-- Voucher posting RPCs.
-- This keeps voucher posting, reversal, idempotency, and audit trail in one transaction.

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_gl_entries_voucher_detail_active
  ON public.erp_gl_entries(voucher_detail_id)
  WHERE is_deleted = 'n';

CREATE OR REPLACE FUNCTION public.post_voucher_document(
  p_voucher_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_voucher RECORD;
  v_period RECORD;
  v_detail RECORD;
  v_total_debit NUMERIC := 0;
  v_total_credit NUMERIC := 0;
  v_line_count INTEGER := 0;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_voucher_id IS NULL OR p_voucher_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive voucher ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_voucher
  FROM public.erp_vouchers_s_539dcf81_b
  WHERE id = p_voucher_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_voucher.status = 'posted' THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'status', 'posted');
  END IF;

  IF v_voucher.status = 'cancelled' THEN
    RAISE EXCEPTION 'Cancelled voucher cannot be posted'
      USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = v_voucher.period_id AND is_deleted = 'n';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_period.is_locked, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is locked'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(v_period.is_closed, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is closed'
      USING ERRCODE = '55000';
  END IF;

  IF NOT COALESCE(v_period.is_enabled, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is not enabled'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0)
  INTO v_total_debit, v_total_credit
  FROM public.erp_voucher_details_s_539dcf81_b
  WHERE voucher_id = p_voucher_id AND is_deleted = 'n';

  IF v_total_debit <= 0 OR v_total_credit <= 0 THEN
    RAISE EXCEPTION 'Voucher debit and credit totals must both be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  IF ABS(v_total_debit - v_total_credit) >= 0.005 THEN
    RAISE EXCEPTION 'Voucher is not balanced: debit %, credit %',
      v_total_debit, v_total_credit USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.erp_gl_entries e
    WHERE e.voucher_id = p_voucher_id AND e.is_deleted = 'n'
  ) THEN
    DELETE FROM public.erp_gl_entries
    WHERE voucher_id = p_voucher_id;
  END IF;

  FOR v_detail IN
    SELECT *
    FROM public.erp_voucher_details_s_539dcf81_b
    WHERE voucher_id = p_voucher_id AND is_deleted = 'n'
    ORDER BY line_no, id
  LOOP
    v_line_count := v_line_count + 1;
    INSERT INTO public.erp_gl_entries (
      corp_id, emp_id, is_deleted, voucher_id, voucher_detail_id,
      period_id, subject_id, voucher_no, voucher_date, summary,
      debit_amount, credit_amount, source_type, source_id, source_detail_id,
      posted_at, posted_by
    ) VALUES (
      v_voucher.corp_id, v_voucher.emp_id, 'n', v_voucher.id, v_detail.id,
      v_voucher.period_id, v_detail.subject_id, v_voucher.voucher_no, v_voucher.voucher_date,
      v_detail.summary, COALESCE(v_detail.debit_amount, 0), COALESCE(v_detail.credit_amount, 0),
      'voucher', v_voucher.id, v_detail.id, NOW(), v_actor_id
    );
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Voucher has no active details'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.erp_vouchers_s_539dcf81_b
  SET status = 'posted',
      total_amount = v_total_debit,
      posted_at = NOW(),
      posted_by = v_actor_id,
      updated_at = NOW()
  WHERE id = p_voucher_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', FALSE,
    'voucher_id', p_voucher_id,
    'status', 'posted',
    'debit_total', v_total_debit,
    'credit_total', v_total_credit,
    'line_count', v_line_count,
    'idempotency_key', p_idempotency_key
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_voucher_document(
  p_voucher_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_voucher RECORD;
  v_period RECORD;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_voucher_id IS NULL OR p_voucher_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive voucher ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
  INTO v_voucher
  FROM public.erp_vouchers_s_539dcf81_b
  WHERE id = p_voucher_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted vouchers can be reversed; current status: %',
      COALESCE(v_voucher.status, '<null>') USING ERRCODE = '55000';
  END IF;

  SELECT *
  INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = v_voucher.period_id AND is_deleted = 'n';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  IF COALESCE(v_period.is_locked, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is locked'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(v_period.is_closed, FALSE) THEN
    RAISE EXCEPTION 'Accounting period is closed'
      USING ERRCODE = '55000';
  END IF;

  DELETE FROM public.erp_gl_entries
  WHERE voucher_id = p_voucher_id AND is_deleted = 'n';

  UPDATE public.erp_vouchers_s_539dcf81_b
  SET status = 'draft',
      posted_at = NULL,
      posted_by = NULL,
      updated_at = NOW()
  WHERE id = p_voucher_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', FALSE,
    'voucher_id', p_voucher_id,
    'status', 'draft',
    'idempotency_key', p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_voucher_document(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_voucher_document(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_voucher_document(INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_voucher_document(INTEGER, UUID) TO authenticated;

