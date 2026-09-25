-- ============================================================================
-- deploy_43_custom_access_token_hook.sql
--
-- Custom Access Token Hook：登录签发 JWT 时把 tenant_id 写进 app_metadata，
-- 让 RLS 策略里的 current_tenant_id() 不再每行查一次 sys_users。
--
-- 依赖：deploy_41 已执行（sys_users.tenant_id / current_tenant_id() 已存在）
--
-- ---------------------------------------------------------------------------
-- 【先读这段：风险与回滚】
--
-- 1) hook 一旦启用，任何 token 签发（登录 / refresh）都会调用本函数。
--    函数报错 = 用户登不进去。所以函数体加了 EXCEPTION 兜底：出错时
--    放行原始 claims，由 current_tenant_id() 的查库分支兜底判定租户。
--
-- 2) pg-functions:// 这种 URI 需要较新的 GoTrue（约 2024-11 之后）。
--    本脚本无法从 SQL 侧探测 GoTrue 版本。若启用后登录整体报错，立刻回滚：
--
--        DELETE FROM auth.hooks WHERE hook = 'custom_access_token';
--        NOTIFY pgrst, 'reload schema';
--
-- 3) 老版本 GoTrue 只支持 HTTP hook（Edge Function）。此时不要用本脚本的
--    第 3 节启用，改为部署 Edge Function 并在 Dashboard 配 HTTPS URI。
--    判定方法：本脚本第 3 节会 NOTICE 是否找到 auth.hooks 表 —— 没有这张
--    表就说明 GoTrue 版本太老，pg-functions 与 auth.hooks 都不可用。
--
-- 4) 渐进式切换，不会中断现有会话：老 token 里没有 tenant_id，
--    current_tenant_id() 自动退回到查 sys_users 的分支，结果一致。
--    用户下次登录 / token 刷新后自然切换到零查库路径。
--
-- 5) 不需要重刷 RLS 策略。策略里存的是表达式文本 public.current_tenant_id()，
--    本脚本 CREATE OR REPLACE 该函数后，236 条策略自动用上新版实现。
--
-- 如何执行（建议先在测试库）：
--   在文件最前面加 BEGIN;，末尾加 ROLLBACK; 即为干跑，RAISE NOTICE 照常输出。
--   确认无误后把 ROLLBACK; 换成 COMMIT; 再跑一次。
--   注意：auth.hooks 的写入建议单独提交并立即验证一次登录，
--   不要和业务 DDL 混在同一个大事务里 —— 出问题影响面太大。
-- ============================================================================


-- ============================================================================
-- 1. Hook 函数
--
--    为什么必须 SECURITY DEFINER：
--      GoTrue 以 supabase_auth_admin 身份调用本函数去读 public.sys_users。
--      sys_users 的 RLS 策略是 TO authenticated（deploy_03），
--      supabase_auth_admin 不匹配任何策略 → 默认全部拒绝 → 永远查不到行。
--      用 SECURITY DEFINER 以 owner（postgres，带 BYPASSRLS）身份执行，
--      绕开这个递归。这一条是本项目本地化的关键点，官方示例里没有。
--
--    STABLE：一次 token 签发只求值一次。
--    SET search_path：防 search_path 劫持。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    claims JSONB;
    v_user_id UUID;
    v_tenant_id BIGINT;
BEGIN
    v_user_id := NULLIF(event ->> 'user_id', '')::UUID;
    IF v_user_id IS NULL THEN
        RETURN event;
    END IF;

    -- 只认有效用户。已删除 / 停用用户查不到记录 → 不写 tenant_id
    -- → current_tenant_id() 解析为 NULL → 策略 fail-closed。
    SELECT u.tenant_id
      INTO v_tenant_id
      FROM public.sys_users u
     WHERE u.auth_id = v_user_id
       AND u.is_deleted = 'n'
       AND u.status = '1'
     LIMIT 1;

    claims := COALESCE(event -> 'claims', '{}'::JSONB);

    IF v_tenant_id IS NOT NULL THEN
        -- app_metadata 是服务端可控区，用户无法自行改写。
        -- 绝不能写 raw_user_meta_data —— 那个用户自己能改，等于自己给自己提权。
        IF COALESCE(jsonb_typeof(claims -> 'app_metadata'), 'null') <> 'object' THEN
            claims := jsonb_set(claims, '{app_metadata}', '{}'::JSONB, true);
        END IF;
        claims := jsonb_set(claims, '{app_metadata,tenant_id}', to_jsonb(v_tenant_id), true);
        -- 顶层也写一份：第三方脚本 / 未来直接读 auth.jwt()->>'tenant_id' 时不用改
        claims := jsonb_set(claims, '{tenant_id}', to_jsonb(v_tenant_id), true);
    ELSE
        -- 防御：确保不会残留上一次的租户声明
        -- 不用 jsonb 的 ? 运算符，避免部分客户端把它当参数占位符
        IF jsonb_typeof(claims -> 'tenant_id') IS NOT NULL THEN
            claims := claims - 'tenant_id';
        END IF;
    END IF;

    RETURN jsonb_set(event, '{claims}', claims);
EXCEPTION
    WHEN OTHERS THEN
        -- 宁可放行、由 RLS 的查库分支裁决，也不能让登录整体失败
        RAISE WARNING '[custom_access_token_hook] 失败，已放行原始 claims: %', SQLERRM;
        RETURN event;
END;
$$;


-- ============================================================================
-- 2. 授权
-- ============================================================================

-- 任何情况下都不允许普通角色直接调用
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO supabase_auth_admin';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB) TO supabase_auth_admin';
        RAISE NOTICE '已授予 supabase_auth_admin 执行权限';
    ELSE
        RAISE NOTICE '未找到 supabase_auth_admin 角色 —— 非标准自托管部署。'
                     '请手动把 EXECUTE 授予 GoTrue 实际使用的数据库角色，否则 hook 会调用失败。';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        -- 给 service_role 是为了能用 REST 直接调函数做验证：
        --   POST /rest/v1/rpc/custom_access_token_hook  {"event": {...}}
        -- 函数只读、不写库，service_role 本就是全权角色，无额外暴露面。
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB) TO service_role';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB) FROM authenticated';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(JSONB) FROM anon';
    END IF;
END;
$$;


-- ============================================================================
-- 3. 启用 hook
--
--    条件执行：auth.hooks 表不存在就只提示，不硬失败（兼容老 GoTrue）。
-- ============================================================================

DO $$
DECLARE
    v_hook_value TEXT := 'pg-functions://postgres/public/custom_access_token_hook';
    v_current TEXT;
BEGIN
    IF to_regclass('auth.hooks') IS NULL THEN
        RAISE NOTICE '------------------------------------------------------------';
        RAISE NOTICE '未找到 auth.hooks 表：当前 GoTrue 版本不支持 pg-functions hook。';
        RAISE NOTICE 'hook 函数已建好但未启用。请改用以下任一方式：';
        RAISE NOTICE '  a) 升级 GoTrue 到支持 pg-functions:// 的版本后重跑本脚本';
        RAISE NOTICE '  b) 部署 HTTP Edge Function，在 Dashboard 的';
        RAISE NOTICE '     Authentication > Hooks > Custom Access Token 配 HTTPS URI';
        RAISE NOTICE '不启用也能正常工作：current_tenant_id() 会走查 sys_users 的分支。';
        RAISE NOTICE '------------------------------------------------------------';
        RETURN;
    END IF;

    SELECT value INTO v_current FROM auth.hooks WHERE hook = 'custom_access_token';

    INSERT INTO auth.hooks (hook, value) VALUES ('custom_access_token', v_hook_value);
    RAISE NOTICE '已启用 custom_access_token hook: %', v_hook_value;

    RAISE NOTICE '验证：SELECT hook, value FROM auth.hooks;';
    RAISE NOTICE '若启用后登录报 500，立即回滚：DELETE FROM auth.hooks WHERE hook = ''custom_access_token'';';
EXCEPTION
    WHEN OTHERS THEN
        -- auth.hooks 的表结构在不同 GoTrue 版本间有差异（列名 / NOT NULL 约束）。
        -- 这里失败只影响启用，不影响函数本身，也不该让整个迁移事务 aborted。
        RAISE WARNING '写入 auth.hooks 失败（%）。hook 函数已建好但未启用，请到 Dashboard 的 '
                      'Authentication > Hooks > Custom Access Token 手动配置: %', SQLERRM, v_hook_value;
        RAISE WARNING '未启用也能正常工作：current_tenant_id() 会走查 sys_users 的分支。';
END;
$$;


-- ============================================================================
-- 4. 更新 current_tenant_id()：兼容顶层 tenant_id
--
--    与 deploy_41 的差异只在 b) 分支多读一层顶层声明，其余保持不变。
--    优先级：GUC 逃生口（仅限无 JWT 上下文）> app_metadata > 顶层 > 查 sys_users。
--    前三者都来自 GoTrue 签名，用户伪造不了。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    -- a) 逃生口：只在没有用户 JWT 时生效（service_role / psql / 后台脚本）。
    --    带 JWT 的真实用户请求不走这条，避免有人伪造 GUC 跨租户。
    CASE
      WHEN NULLIF(current_setting('request.jwt.claims', true), '') IS NULL
        THEN NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
      ELSE NULL
    END,
    -- b) JWT：Custom Access Token Hook 写入，零查库
    NULLIF(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::BIGINT,
    NULLIF(auth.jwt() ->> 'tenant_id', '')::BIGINT,
    -- c) 查 sys_users：hook 未启用 / 老 token 的兜底
    (
      SELECT u.tenant_id
      FROM public.sys_users u
      WHERE u.auth_id = auth.uid()
        AND u.is_deleted = 'n'
      LIMIT 1
    )
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO service_role;


-- ============================================================================
-- 5. 验证（把下面块复制到 SQL Editor 单独跑，不要和业务 DDL 同事务）
-- ============================================================================
--
-- 5.1 hook 是否已启用
--   SELECT hook, value FROM auth.hooks;
--
-- 5.2 不开登录也能验证函数逻辑：拿一个真实 auth_id 试算
--   SELECT public.custom_access_token_hook(
--            jsonb_build_object('user_id', '<auth.users.id>'::text, 'claims', '{}'::jsonb)
--          );
--   期望：claims.app_metadata.tenant_id 等于该用户在 sys_users 里的 tenant_id
--
-- 5.3 找一个有租户的用户做 5.2 的入参
--   SELECT id, username, tenant_id, auth_id FROM public.sys_users
--   WHERE is_deleted = 'n' AND status = '1' AND tenant_id IS NOT NULL LIMIT 5;
--
-- 5.4 登录后（用有租户的账号重新登录，不要用老 token）确认零查库路径生效
--   SELECT auth.jwt()->'app_metadata'->>'tenant_id' AS jwt_tenant,
--          public.current_tenant_id()              AS resolved_tenant;
--   两列应相等且非空。jwt_tenant 为 NULL 说明用的是启用前签发的 token，
--   重新登录即可（不重新登录也安全，会走查库分支）。
--
-- 5.5 策略无需重刷 —— 策略存的是表达式文本，自动指向新版函数。抽查一条：
--   SELECT tablename, qual FROM pg_policies
--   WHERE schemaname='public' AND tablename LIKE 'erp\_%' ESCAPE '\' AND cmd='select'
--   LIMIT 1;


-- ============================================================================
-- 6. 运维备忘（不执行，按需手动）
-- ============================================================================
--
-- 6.1 用户换租户 / 撤销租户后，JWT 里的旧值最长存活到 token 过期（默认 1 小时）。
--     立即生效的办法是吊销其 refresh token，强制重新登录：
--       DELETE FROM auth.refresh_tokens WHERE user_id = '<auth.users.id>';
--
-- 6.2 完全停用一个租户（先备份）：
--       UPDATE public.sys_users SET status = '0' WHERE tenant_id = <id>;
--       -- 下一步才会重新签发不带 tenant_id 的 token；存量 refresh token 按 6.1 清掉
--
-- 6.3 回滚 hook（保留函数）：
--       DELETE FROM auth.hooks WHERE hook = 'custom_access_token';
--       NOTIFY pgrst, 'reload schema';
--
-- 6.4 彻底移除：
--       DROP FUNCTION IF EXISTS public.custom_access_token_hook(JSONB);


NOTIFY pgrst, 'reload schema';
