-- ============================================================================
-- deploy_76_service_role_finance_entry.sql
-- 多币别改造 · 第 3 期（财务）· 补充：让 ai-server（service_role）能触发财务动作
--
-- 依赖 deploy_73（settle_ar_ap）、deploy_74（run_fx_revaluation / reverse_fx_revaluation）。
--
-- ── 要解决的问题 ──────────────────────────────────────────────────────────
-- ai-server 用 supabase-js（PostgREST）+ service_role key 连库。此时：
--   · current_tenant_id() 返回 **NULL**
--       它的第一分支条件是 `request.jwt.claims IS NULL` 才读 app.tenant_id，
--       而 PostgREST 对 service_role 请求同样会设 request.jwt.claims
--       （`{"role":"service_role"}`）→ 逃生口被短路，后面几条回退也都拿不到
--       租户 → NULL。而 run_fx_revaluation 的第一件事就是 `v_tenant IS NULL`
--       → 报 `No tenant context`。**调汇在 ai-server 上根本起不来。**
--       （ai-server/src/config/tenantContext.ts 的注释里已经记着同一件事：
--        连 current_user_is_super_admin() 都不能复用，因为 auth.uid() 恒为 NULL。）
--   · current_sys_user_id() 返回 NULL（它只认 auth.uid()）
--       → 凭证的 posted_by、调汇记录的 created_by 全是空，审计断链。
--   · service_role 带 BYPASSRLS → RLS 不再兜底，所有租户过滤必须显式写死。
--
-- ── 做法 ──────────────────────────────────────────────────────────────────
--   service_finance_identity(p_user_id, p_tenant_id)
--     ① 守卫调用者必须是 service_role / postgres；
--     ② 按 p_user_id 查 sys_users 拿 auth_id 与自身租户；
--     ③ 越权校验：p_tenant_id 与用户自身租户不一致时，只有 super_admin 放行
--        （正好对齐 resolveTenantContext() 在 TS 侧的同一条规则）；
--     ④ 用 set_config(..., is_local := TRUE) 在**当前事务内**写
--        app.tenant_id 与 request.jwt.claims。
--   三个 service_* 包装函数先 PERFORM 它，再原样调用既有 RPC。
--   这样 current_tenant_id() / current_sys_user_id() / auth.uid() 全部恢复
--   正常语义，**被包住的业务函数一行都不用改**，也不会出现"SQL 里一套租户
--   逻辑、TS 里又一套"的双实现。
--
-- ── 安全边界（重要）──────────────────────────────────────────────────────
--   1. 必须是 SECURITY INVOKER —— DEFINER 会让 current_user 变成 owner
--      (postgres)，守卫就永远通过，等于没有守卫。
--   2. ⚠️ 本项目容器配了
--        `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS
--         TO anon, authenticated, service_role`
--      → **新建函数自带 anon 与 authenticated 的 EXECUTE**，
--        `REVOKE ALL ... FROM PUBLIC` **拦不住 anon**（anon 是显式 ACL 条目，
--        不是从 PUBLIC 继承的）。所以 REVOKE 必须点名 PUBLIC, anon, authenticated。
--      （与本项目既有的「新表自动获 arwdDxtm → 表级权限盖过列级 GRANT」
--        是同一类坑，只是对象换成了函数。见 3.5 节。）
--   3. 守卫同时接受 postgres / supabase_admin，方便本机 psql 排障。
--   4. 被包住的 RPC 自身也补了租户守卫（deploy_73 / deploy_74 的 42501），
--      所以即使 service_role key 泄露，也只能在"用户所属租户"内动作。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_76] service_role 财务动作入口...'

-- ---------------------------------------------------------------------------
-- 0) 清掉早期版本（签名里补了 p_tenant_id，属于签名变更，必须 DROP 而非 REPLACE；
--    CREATE OR REPLACE 无法改参数列表，会留下一个旧签名的重载）
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.service_run_fx_revaluation(BIGINT, INTEGER, DATE, UUID, VARCHAR);
DROP FUNCTION IF EXISTS public.service_reverse_fx_revaluation(BIGINT, INTEGER, UUID);
DROP FUNCTION IF EXISTS public.service_settle_ar_ap(BIGINT, VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC);

-- ---------------------------------------------------------------------------
-- 1) service_finance_identity：解析身份并在事务内注入
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_finance_identity(
  p_user_id   BIGINT,
  p_tenant_id BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor     RECORD;
  v_tenant    BIGINT;
  v_is_super  BOOLEAN;
BEGIN
  IF NOT (current_user IN ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin')
          OR pg_has_role(current_user, 'service_role', 'member')) THEN
    RAISE EXCEPTION
      'service_finance_identity is restricted to the service role (current_user = %)', current_user
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required' USING ERRCODE = '22023';
  END IF;

  SELECT u.id, u.tenant_id, u.auth_id
    INTO v_actor
    FROM public.sys_users u
   WHERE u.id = p_user_id AND u.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'User % does not exist or is deleted', p_user_id USING ERRCODE = 'P0002';
  END IF;

  v_tenant := COALESCE(p_tenant_id, v_actor.tenant_id);
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant for user % (sys_users.tenant_id is empty)', p_user_id
      USING ERRCODE = '28000';
  END IF;

  -- 跨租户代操作：只有 super_admin 可以（与 TS 侧 resolveTenantContext 同规则）
  IF v_actor.tenant_id IS DISTINCT FROM v_tenant THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.sys_user_roles ur
        JOIN public.sys_roles r ON r.id = ur.role_id
       WHERE ur.user_id = p_user_id
         AND COALESCE(ur.is_deleted, 'n') = 'n'
         AND COALESCE(r.is_deleted, 'n') = 'n'
         AND r.role_code = 'super_admin'
    ) INTO v_is_super;
    IF NOT COALESCE(v_is_super, FALSE) THEN
      RAISE EXCEPTION
        'User % (tenant %) is not allowed to act on tenant %',
        p_user_id, v_actor.tenant_id, v_tenant
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 事务级注入身份（is_local := TRUE → 随事务结束自动失效）
  PERFORM set_config('app.tenant_id', v_tenant::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor.auth_id,
      'role', 'authenticated',
      'app_metadata', jsonb_build_object('tenant_id', v_tenant)
    )::TEXT,
    TRUE
  );

  RETURN jsonb_build_object(
    'user_id', v_actor.id,
    'tenant_id', v_tenant,
    'auth_id', v_actor.auth_id,
    'cross_tenant', (v_actor.tenant_id IS DISTINCT FROM v_tenant)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.service_finance_identity(BIGINT, BIGINT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_finance_identity(BIGINT, BIGINT) TO service_role;

-- ---------------------------------------------------------------------------
-- 2) service_run_fx_revaluation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_run_fx_revaluation(
  p_user_id          BIGINT,
  p_tenant_id        BIGINT,
  p_period_id        INTEGER,
  p_revaluation_date DATE,
  p_idempotency_key  UUID,
  p_currency         VARCHAR DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  v_identity := public.service_finance_identity(p_user_id, p_tenant_id);
  v_result := public.run_fx_revaluation(
    p_period_id, p_revaluation_date, p_idempotency_key, p_currency);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

REVOKE ALL ON FUNCTION public.service_run_fx_revaluation(BIGINT, BIGINT, INTEGER, DATE, UUID, VARCHAR)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_run_fx_revaluation(BIGINT, BIGINT, INTEGER, DATE, UUID, VARCHAR)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3) service_reverse_fx_revaluation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_reverse_fx_revaluation(
  p_user_id         BIGINT,
  p_tenant_id       BIGINT,
  p_revaluation_id  INTEGER,
  p_idempotency_key UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  v_identity := public.service_finance_identity(p_user_id, p_tenant_id);
  v_result := public.reverse_fx_revaluation(p_revaluation_id, p_idempotency_key);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

REVOKE ALL ON FUNCTION public.service_reverse_fx_revaluation(BIGINT, BIGINT, INTEGER, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_reverse_fx_revaluation(BIGINT, BIGINT, INTEGER, UUID)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 4) service_settle_ar_ap：核销同理（ai-server 侧可做"到期自动核销"）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.service_settle_ar_ap(
  p_user_id          BIGINT,
  p_tenant_id        BIGINT,
  p_settlement_type  VARCHAR,
  p_source_id        INTEGER,
  p_period_id        INTEGER,
  p_amount           NUMERIC,
  p_settlement_date  DATE,
  p_remark           TEXT,
  p_idempotency_key  UUID,
  p_settlement_rate  NUMERIC DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_identity jsonb;
  v_result   jsonb;
BEGIN
  v_identity := public.service_finance_identity(p_user_id, p_tenant_id);
  v_result := public.settle_ar_ap(
    p_settlement_type, p_source_id, p_period_id, p_amount,
    p_settlement_date, p_remark, p_idempotency_key, p_settlement_rate);
  RETURN v_result || jsonb_build_object('identity', v_identity);
END;
$$;

REVOKE ALL ON FUNCTION public.service_settle_ar_ap(BIGINT, BIGINT, VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_settle_ar_ap(BIGINT, BIGINT, VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 5) 顺带收紧本期三个业务函数对 anon 的可执行性
--    见文件头第 2 条：容器的默认函数权限白送 anon EXECUTE，
--    REVOKE FROM PUBLIC 拦不住。anon 调用实际会 fail-closed（无 JWT →
--    current_tenant_id() 为 NULL，RLS 策略又都是 TO authenticated），
--    不是可被利用的越权，但属于权限面过宽。这三张函数是本期新增/重写的，
--    顺手撤掉，不扩散改动到其他历史函数。
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.run_fx_revaluation(INTEGER, DATE, UUID, VARCHAR) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reverse_fx_revaluation(INTEGER, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.settle_ar_ap(VARCHAR, INTEGER, INTEGER, NUMERIC, DATE, TEXT, UUID, NUMERIC) FROM anon;

-- ---------------------------------------------------------------------------
-- 6) fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_rec  RECORD;
  v_acl  TEXT;
  v_cnt  INTEGER;
  v_bad  TEXT := '';
BEGIN
  -- 6.1 三个包装函数 + identity 都必须是 INVOKER 且只留给 service_role
  FOR v_rec IN
    SELECT p.proname, p.prosecdef, COALESCE(p.proacl::TEXT, '') AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('service_finance_identity',
                         'service_run_fx_revaluation',
                         'service_reverse_fx_revaluation',
                         'service_settle_ar_ap')
  LOOP
    IF v_rec.prosecdef THEN
      v_bad := v_bad || v_rec.proname || '(应为 INVOKER) ';
    END IF;
    v_acl := v_rec.acl;
    IF v_acl LIKE '%anon=X%' OR v_acl LIKE '%authenticated=X%' OR v_acl = '' THEN
      v_bad := v_bad || v_rec.proname || '(anon/authenticated 可执行或 ACL 为空) ';
    END IF;
    IF v_acl NOT LIKE '%service_role=X%' THEN
      v_bad := v_bad || v_rec.proname || '(service_role 无 EXECUTE) ';
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_cnt
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('service_finance_identity',
                       'service_run_fx_revaluation',
                       'service_reverse_fx_revaluation',
                       'service_settle_ar_ap');
  IF v_cnt <> 4 THEN
    v_bad := v_bad || format('(服务端入口数 %s ≠ 4) ', v_cnt);
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION '[deploy_76] 服务端入口不合规：%', v_bad;
  END IF;

  -- 6.2 指纹：identity 必须真的注入 JWT claims，且带跨租户守卫
  SELECT p.prosrc INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'service_finance_identity';
  IF v_acl IS NULL
     OR v_acl NOT LIKE '%request.jwt.claims%'
     OR v_acl NOT LIKE '%app.tenant_id%'
     OR v_acl NOT LIKE '%42501%'
     OR v_acl NOT LIKE '%super_admin%' THEN
    RAISE EXCEPTION '[deploy_76] service_finance_identity 未生效（缺身份注入或跨租户守卫）';
  END IF;

  -- 6.3 本期三个业务函数也必须对 anon 关闭
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('settle_ar_ap', 'run_fx_revaluation', 'reverse_fx_revaluation')
       AND COALESCE(p.proacl::TEXT, '') LIKE '%anon=X%'
  ) THEN
    RAISE EXCEPTION '[deploy_76] 仍有本期财务函数对 anon 开放 EXECUTE';
  END IF;

  -- 6.4 被包住的两个函数必须带租户守卫（否则 service_role 路径就是跨租户后门）
  SELECT p.prosrc INTO v_acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_ar_ap';
  IF v_acl IS NULL OR v_acl NOT LIKE '%42501%' THEN
    RAISE EXCEPTION '[deploy_76] settle_ar_ap 缺少租户守卫';
  END IF;

  RAISE NOTICE '[deploy_76] 自检通过：4 个服务端入口均为 INVOKER，仅 service_role 可执行，身份注入与租户守卫齐备。';
END $$;
