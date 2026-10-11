-- ============================================================================
-- 缺陷修复：会计期间唯一键缺少 tenant_id（多租户串锁）
-- ============================================================================
--
-- 现象（可复现）：
--   租户 3 已有 2026-10 期间，租户 1 想建同一期间 → 23505
--   `duplicate key value violates unique constraint "uq_erp_accounting_period_year_month"`。
--   连带后果：ai-server 的 `costRollupService.ensurePeriod()` 在期间缺失时会自动补一行，
--   于是**第二个及以后的租户「成本卷算」必然失败**（当月期间已被别的租户占用）。
--
-- 根因：
--   deploy_22 建的是 `UNIQUE (year, month) WHERE is_deleted='n'` —— **全局唯一**，
--   没有 tenant_id。本项目其余唯一键一律「跟租户走」，这个漏了。
--
-- 影响面核查（改前逐个确认过）：
--   * 所有期间查询都按 `id` 定位（deploy_17 过账/反过账、deploy_19 启用/关账/锁定），
--     没有「按 year+month 找期间」的调用 —— 放宽唯一键不会让谁挑错租户的期间。
--   * 前端 finance/* 页面读期间全部经 PostgREST + RLS，本就按租户过滤。
--   * 唯一受影响的是 `generate_accounting_periods()`：它的 `ON CONFLICT (year, month)`
--     必须跟着改成新索引目标，否则 Postgres 会报「no unique or exclusion constraint
--     matching the ON CONFLICT specification」。本脚本一并重定义。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================


-- ============================================================================
-- 1. 前置自检：新索引必须能建起来（同租户同月重复才冲突，跨租户不算）
-- ============================================================================
DO $$
DECLARE
  v_dup TEXT;
BEGIN
  SELECT string_agg(format('%s 租户 %s 的 %s-%s 有 %s 行', tenant_id, tenant_id, year, month, n), '; ')
    INTO v_dup
    FROM (
      SELECT tenant_id, year, month, count(*) AS n
        FROM public.erp_accounting_periods_s_539dcf81_b
       WHERE COALESCE(is_deleted, 'n') = 'n'
       GROUP BY tenant_id, year, month
      HAVING count(*) > 1
    ) d;

  IF v_dup IS NOT NULL THEN
    RAISE EXCEPTION '存在同租户同月重复的会计期间，请先清理再执行本脚本：%', v_dup;
  END IF;

  RAISE NOTICE '前置检查通过：各租户 (year, month) 无重复';
END;
$$;


-- ============================================================================
-- 2. 唯一键改为「跟租户走」
-- ============================================================================
DROP INDEX IF EXISTS public.uq_erp_accounting_period_year_month;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_accounting_period_tenant_year_month
  ON public.erp_accounting_periods_s_539dcf81_b (tenant_id, year, month)
  WHERE is_deleted = 'n';

COMMENT ON INDEX public.uq_erp_accounting_period_tenant_year_month IS
  '会计期间按租户唯一：同租户同月只能有一行（软删后允许重建）。原 (year, month) 全局唯一索引是缺陷，已由 deploy_113 替换。';


-- ============================================================================
-- 3. 重定义 generate_accounting_periods（ON CONFLICT 目标同步）
-- ============================================================================
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
  -- 期间一律落到调用者租户；解析不出租户时抛错（不静默落到某个租户）
  v_tenant BIGINT := public.current_tenant_id();
BEGIN
  IF p_year IS NULL OR p_year < 1900 OR p_year > 2999 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A valid year and idempotency key are required' USING ERRCODE = '22023';
  END IF;

  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Cannot resolve tenant for accounting period generation'
      USING ERRCODE = '22023';
  END IF;

  FOR v_month IN 1..12 LOOP
    SELECT id INTO v_period_id
    FROM public.erp_accounting_periods_s_539dcf81_b
    WHERE tenant_id = v_tenant AND year = p_year AND month = v_month AND is_deleted = 'n'
    FOR UPDATE;

    IF v_period_id IS NOT NULL THEN
      v_existing := v_existing + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.erp_accounting_periods_s_539dcf81_b (
      year, month, start_date, end_date, is_enabled, is_closed, is_locked,
      is_deleted, created_at, updated_at, tenant_id
    ) VALUES (
      p_year,
      v_month,
      make_date(p_year, v_month, 1),
      (make_date(p_year, v_month, 1) + INTERVAL '1 month - 1 day')::date,
      FALSE, FALSE, FALSE, 'n', NOW(), NOW(), v_tenant
    )
    ON CONFLICT (tenant_id, year, month) WHERE is_deleted = 'n' DO NOTHING;

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
    'tenant_id', v_tenant,
    'idempotency_key', p_idempotency_key
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generate_accounting_periods(INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_accounting_periods(INTEGER, UUID) TO authenticated;


-- ============================================================================
-- 4. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
BEGIN
  -- 4.1 旧的全局唯一索引必须已消失
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_accounting_periods_s_539dcf81_b'
     AND indexname = 'uq_erp_accounting_period_year_month';
  IF COALESCE(v_n, 0) <> 0 THEN
    v_missing := v_missing || '旧的全局唯一索引 uq_erp_accounting_period_year_month 仍存在;';
  END IF;

  -- 4.2 新索引必须含 tenant_id
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_accounting_periods_s_539dcf81_b'
     AND indexname = 'uq_erp_accounting_period_tenant_year_month'
     AND indexdef ILIKE '%tenant_id%' AND indexdef ILIKE '%year%'
     AND indexdef ILIKE '%month%' AND indexdef ILIKE '%is_deleted%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 (tenant_id, year, month) 部分唯一索引;';
  END IF;

  -- 4.3 ON CONFLICT 目标必须跟着改（否则运行时报 no unique constraint matching）
  IF (SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'generate_accounting_periods')
     NOT ILIKE '%ON CONFLICT (tenant_id, year, month)%' THEN
    v_missing := v_missing || 'generate_accounting_periods 的 ON CONFLICT 目标没跟着改;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_113 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_113 OK：会计期间唯一键已改为「跟租户走」，期间生成函数已同步';
END;
$$;
