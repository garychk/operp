-- Accounting period lifecycle controls.

ALTER TABLE public.erp_accounting_periods_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS enabled_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS enabled_by INTEGER,
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS locked_by INTEGER;

CREATE INDEX IF NOT EXISTS idx_erp_accounting_periods_enabled
  ON public.erp_accounting_periods_s_539dcf81_b(is_enabled, is_locked, is_closed);

CREATE OR REPLACE FUNCTION public.enable_accounting_period(
  p_period_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period RECORD;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_period_id IS NULL OR p_period_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive period ID and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = p_period_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  IF v_period.is_locked THEN
    RAISE EXCEPTION 'Locked period cannot be enabled' USING ERRCODE = '55000';
  END IF;

  UPDATE public.erp_accounting_periods_s_539dcf81_b
  SET is_enabled = TRUE,
      enabled_at = NOW(),
      enabled_by = v_actor_id,
      updated_at = NOW()
  WHERE id = p_period_id;

  RETURN jsonb_build_object('ok', TRUE, 'period_id', p_period_id, 'status', 'enabled');
END;
$$;

CREATE OR REPLACE FUNCTION public.close_accounting_period(
  p_period_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period RECORD;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_period_id IS NULL OR p_period_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive period ID and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = p_period_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_period.is_enabled THEN
    RAISE EXCEPTION 'Period must be enabled before closing' USING ERRCODE = '55000';
  END IF;

  IF v_period.is_locked THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'period_id', p_period_id, 'status', 'locked');
  END IF;

  UPDATE public.erp_accounting_periods_s_539dcf81_b
  SET is_closed = TRUE,
      closed_at = NOW(),
      updated_at = NOW()
  WHERE id = p_period_id;

  RETURN jsonb_build_object('ok', TRUE, 'period_id', p_period_id, 'status', 'closed');
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_accounting_period(
  p_period_id INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period RECORD;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_period_id IS NULL OR p_period_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive period ID and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_period
  FROM public.erp_accounting_periods_s_539dcf81_b
  WHERE id = p_period_id AND is_deleted = 'n'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_period.is_closed THEN
    RAISE EXCEPTION 'Period must be closed before locking' USING ERRCODE = '55000';
  END IF;

  UPDATE public.erp_accounting_periods_s_539dcf81_b
  SET is_locked = TRUE,
      locked_at = NOW(),
      locked_by = v_actor_id,
      updated_at = NOW()
  WHERE id = p_period_id;

  RETURN jsonb_build_object('ok', TRUE, 'period_id', p_period_id, 'status', 'locked');
END;
$$;

REVOKE ALL ON FUNCTION public.enable_accounting_period(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_accounting_period(INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_accounting_period(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enable_accounting_period(INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.close_accounting_period(INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_accounting_period(INTEGER, UUID) TO authenticated;
