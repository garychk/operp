-- Accounting period creation and annual generation.

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_accounting_period_year_month
  ON public.erp_accounting_periods_s_539dcf81_b(year, month)
  WHERE is_deleted = 'n';

CREATE OR REPLACE FUNCTION public.generate_accounting_periods(
  p_year INTEGER,
  p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  v_month INTEGER;
  v_period_id INTEGER;
  v_created INTEGER := 0;
  v_existing INTEGER := 0;
  v_actor_id INTEGER := public.current_sys_user_id();
BEGIN
  IF p_year IS NULL OR p_year < 1900 OR p_year > 2999 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A valid year and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  FOR v_month IN 1..12 LOOP
    SELECT id INTO v_period_id
    FROM public.erp_accounting_periods_s_539dcf81_b
    WHERE year = p_year AND month = v_month AND is_deleted = 'n'
    FOR UPDATE;

    IF v_period_id IS NOT NULL THEN
      v_existing := v_existing + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.erp_accounting_periods_s_539dcf81_b (
      year, month, start_date, end_date, is_enabled, is_closed, is_locked,
      is_deleted, created_at, updated_at
    ) VALUES (
      p_year,
      v_month,
      make_date(p_year, v_month, 1),
      (make_date(p_year, v_month, 1) + INTERVAL '1 month - 1 day')::date,
      FALSE, FALSE, FALSE, 'n', NOW(), NOW()
    )
    ON CONFLICT (year, month) WHERE is_deleted = 'n' DO NOTHING;

    IF FOUND THEN
      v_created := v_created + 1;
    ELSE
      v_existing := v_existing + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'idempotent', v_created = 0,
    'year', p_year,
    'created_count', v_created,
    'existing_count', v_existing,
    'actor_id', v_actor_id,
    'idempotency_key', p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_accounting_periods(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_accounting_periods(INTEGER, UUID) TO authenticated;
