-- ============================================================================
-- deploy_84_tenant_subscription.sql
-- 租户订阅（Waffo Pancake）· 使用期限 + 订阅流水 + 幂等续租 RPC
--
-- 业务流：
--   1. 租户管理员在前端点「订阅/续费」→ ai-server 调 Waffo Pancake
--      checkout.createSession 生成收银台链接（metadata 带 tenant_id + months）；
--   2. 用户在新标签页完成支付；
--   3. Waffo 回调 POST /api/subscription/webhook（RSA-SHA256 验签），
--      subscription.activated / subscription.payment_succeeded 事件
--      → 调本脚本的 service_extend_tenant_subscription：
--        记一条订阅流水 + 把 sys_tenants.expires_at 顺延 N 个月。
--
-- 期限规则：
--   · expires_at 为 NULL 表示不过期（未启用订阅管控 / 平台自有租户）；
--   · 续租起点 = max(now, expires_at)——未到期续费从到期日顺延，
--     已到期/首次订阅从当前时间起算；
--   · 幂等以 Waffo 的投递 ID（event.id）为唯一键，重放/重试不会重复续租。
--
-- 安全边界（沿用 deploy_76 口径）：
--   · service_extend_tenant_subscription 仅限 service_role / postgres 调用
--     （webhook 是服务端到服务端，不经过浏览器）；
--   · 容器默认权限会给新函数/新表白送 anon/authenticated 权限 →
--     必须 REVOKE 点名 PUBLIC, anon, authenticated，只留 service_role；
--   · 本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

\echo '[deploy_84] 租户订阅：使用期限 + 流水表 + 续租 RPC...'

-- ---------------------------------------------------------------------------
-- 1) sys_tenants.expires_at：租户使用期限
-- ---------------------------------------------------------------------------
ALTER TABLE public.sys_tenants
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

COMMENT ON COLUMN public.sys_tenants.expires_at IS
  '租户使用期限（到期后停止服务）；NULL 表示不限制';

-- ---------------------------------------------------------------------------
-- 2) sys_tenant_subscriptions：订阅/续费流水（幂等表）
--    sys_* 平台表，不带租户后缀（与 sys_tenants 同族）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sys_tenant_subscriptions (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL REFERENCES public.sys_tenants(id) ON DELETE CASCADE,
    event_id      VARCHAR(64)  NOT NULL,
    event_type    VARCHAR(64)  NOT NULL,
    order_id      VARCHAR(64),
    session_id    VARCHAR(64),
    product_id    VARCHAR(64),
    product_name  VARCHAR(200),
    buyer_email   VARCHAR(200),
    currency      VARCHAR(3),
    amount        NUMERIC(12, 2),
    mode          VARCHAR(4),            -- Waffo 环境：test / prod
    months        INTEGER NOT NULL DEFAULT 1,
    period_start  TIMESTAMPTZ NOT NULL,  -- 本次续租的起算点
    period_end    TIMESTAMPTZ NOT NULL,  -- 本次续租后的新到期时间
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 幂等唯一键：Waffo 投递 ID。重复回调直接命中唯一冲突 → 按 duplicate 返回。
CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_tenant_subscriptions_event_id
    ON public.sys_tenant_subscriptions (event_id);

CREATE INDEX IF NOT EXISTS idx_sys_tenant_subscriptions_tenant
    ON public.sys_tenant_subscriptions (tenant_id, created_at DESC);

COMMENT ON TABLE public.sys_tenant_subscriptions IS
  '租户订阅流水（Waffo Pancake 回调驱动，event_id 幂等）';

-- 收紧表权限：新表默认权限会白送 anon/authenticated（同 deploy_76 3.5 节的坑）
REVOKE ALL ON public.sys_tenant_subscriptions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sys_tenant_subscriptions TO service_role;

-- ---------------------------------------------------------------------------
-- 3) service_extend_tenant_subscription：幂等续租
--    SECURITY INVOKER（service_role 自带 BYPASSRLS + 表授权），
--    守卫挡住浏览器侧（anon/authenticated）调用。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_extend_tenant_subscription(
  p_tenant_id    BIGINT,
  p_event_id     VARCHAR,
  p_event_type   VARCHAR,
  p_order_id     VARCHAR DEFAULT NULL,
  p_session_id   VARCHAR DEFAULT NULL,
  p_product_id   VARCHAR DEFAULT NULL,
  p_product_name VARCHAR DEFAULT NULL,
  p_buyer_email  VARCHAR DEFAULT NULL,
  p_currency     VARCHAR DEFAULT NULL,
  p_amount       NUMERIC DEFAULT NULL,
  p_mode         VARCHAR DEFAULT NULL,
  p_months       INTEGER DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_tenant        RECORD;
  v_base          TIMESTAMPTZ;
  v_new_expiry    TIMESTAMPTZ;
  v_existing_id   BIGINT;
BEGIN
  IF NOT (current_user IN ('service_role', 'postgres', 'supabase_admin')
          OR pg_has_role(current_user, 'service_role', 'member')) THEN
    RAISE EXCEPTION
      'service_extend_tenant_subscription is restricted to the service role (current_user = %)',
      current_user
      USING ERRCODE = '42501';
  END IF;

  IF p_tenant_id IS NULL OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'p_tenant_id and p_event_id are required' USING ERRCODE = '22023';
  END IF;

  IF p_months IS NULL OR p_months < 1 OR p_months > 36 THEN
    RAISE EXCEPTION 'p_months must be between 1 and 36' USING ERRCODE = '22023';
  END IF;

  -- 幂等：同一投递 ID 已处理过 → 原样返回，不再续租
  SELECT id INTO v_existing_id
    FROM public.sys_tenant_subscriptions
   WHERE event_id = p_event_id;
  IF v_existing_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'duplicate', TRUE,
      'subscription_id', v_existing_id
    );
  END IF;

  SELECT * INTO v_tenant
    FROM public.sys_tenants
   WHERE id = p_tenant_id AND COALESCE(is_deleted, 'n') = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant % does not exist or is deleted', p_tenant_id USING ERRCODE = 'P0002';
  END IF;

  -- 续租起点：未到期从到期日顺延；已到期/无期限从当前时间起算
  v_base := GREATEST(COALESCE(v_tenant.expires_at, NOW()), NOW());
  v_new_expiry := v_base + make_interval(months => p_months);

  UPDATE public.sys_tenants
     SET expires_at = v_new_expiry,
         updated_at = NOW()
   WHERE id = p_tenant_id;

  INSERT INTO public.sys_tenant_subscriptions (
    tenant_id, event_id, event_type, order_id, session_id, product_id,
    product_name, buyer_email, currency, amount, mode, months,
    period_start, period_end
  ) VALUES (
    p_tenant_id, p_event_id, COALESCE(p_event_type, 'unknown'), p_order_id,
    p_session_id, p_product_id, p_product_name, p_buyer_email, p_currency,
    p_amount, p_mode, p_months, v_base, v_new_expiry
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'duplicate', FALSE,
    'tenant_id', p_tenant_id,
    'previous_expiry', v_tenant.expires_at,
    'period_start', v_base,
    'new_expiry', v_new_expiry,
    'order_id', p_order_id
  );
END;
$$;

-- 函数默认权限白送 anon/authenticated（deploy_76 同款坑）→ 点名收回
REVOKE EXECUTE ON FUNCTION public.service_extend_tenant_subscription(
  BIGINT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, NUMERIC, VARCHAR, INTEGER
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_extend_tenant_subscription(
  BIGINT, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, VARCHAR, NUMERIC, VARCHAR, INTEGER
) TO service_role;

\echo '[deploy_84] OK：sys_tenants.expires_at + sys_tenant_subscriptions + service_extend_tenant_subscription'
