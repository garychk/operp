-- ============================================================================
-- deploy_54: 种子超管的 GoTrue 建号 + auth_id 回填（幂等，可随时重跑）
--
--   背景：登录走 Supabase Auth（GoTrue），不读 sys_users.password_hash。
--   deploy_01 已在新部署时内嵌同样的种子逻辑（auth.users + auth.identities 成对
--   插入 + auth_id 回填）；本脚本用于两类场景：
--     1. 已部署的环境补齐超管登录账号（不需要重跑 deploy_01）；
--     2. 旧版本部署后升级到含种子逻辑的版本时兜底。
--
--   与 deploy_01 的差异：
--     - deploy_01 面向干净库（reset 后），直接 INSERT；
--     - 本脚本全部走「存在即跳过」判断，重复执行无副作用。
--
--   种子账号：
--     邮箱   admin@operp.com
--     密码   admin123（bcrypt，上线后请尽快修改）
--     角色   super_admin（由 deploy_01 的 sys_user_roles 种子行提供）
--
--   为什么必须成对插入 auth.users + auth.identities：
--     identities 缺失时 supabase-js 返回的 user.identities 是空数组，
--     前端注册流程（Login.tsx）会把它误判为「邮箱已注册」的混淆假 user。
-- ============================================================================

DO $$
DECLARE
    v_email       TEXT := 'admin@operp.com';
    v_password    TEXT := 'admin123';
    v_auth_id     UUID;
    v_row_count   INTEGER;
BEGIN
    -- 1) GoTrue 账号：存在即跳过
    SELECT id INTO v_auth_id
    FROM auth.users
    WHERE email = v_email;

    IF v_auth_id IS NULL THEN
        INSERT INTO auth.users (
            instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
            -- GoTrue 的 Go 代码按非空字符串扫描这些 token 列，SQL 直插必须给空串，
            -- 否则密码登录报 500「converting NULL to string is unsupported」
            confirmation_token, recovery_token, email_change, email_change_token_new
        )
        VALUES (
            '00000000-0000-0000-0000-000000000000',
            gen_random_uuid(),
            'authenticated',
            'authenticated',
            v_email,
            extensions.crypt(v_password, extensions.gen_salt('bf', 10)),
            NOW(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"username":"admin","real_name":"系统管理员"}'::jsonb,
            NOW(),
            NOW(),
            '', '', '', ''
        )
        RETURNING id INTO v_auth_id;

        RAISE NOTICE '已创建 GoTrue 账号 %（auth.users.id=%），初始密码 %', v_email, v_auth_id, v_password;
    ELSE
        RAISE NOTICE 'GoTrue 账号 % 已存在（auth.users.id=%），跳过建号', v_email, v_auth_id;
    END IF;

    -- 2) email identity：缺失则补（老环境可能只有 auth.users）
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    SELECT u.id, u.id,
           jsonb_build_object('sub', u.id, 'email', u.email,
                              'email_verified', true, 'phone_verified', false),
           'email', NOW(), NOW(), NOW()
    FROM auth.users u
    WHERE u.id = v_auth_id
      AND NOT EXISTS (
          SELECT 1 FROM auth.identities i
          WHERE i.user_id = u.id AND i.provider = 'email'
      );

    -- 3) 回填 sys_users.auth_id：
    --    只绑定 auth_id 为空的档案行；邮箱匹配优先，兼容旧种子邮箱 admin@erp.com，
    --    再兜底按用户名 admin 匹配（早期部署的库邮箱可能各不相同）。
    --    若超管档案已绑定其他 auth 账号，则不动它，只提示。
    IF EXISTS (SELECT 1 FROM public.sys_users WHERE auth_id = v_auth_id) THEN
        RAISE NOTICE '已存在绑定到该 auth 账号的 sys_users 行，跳过回填';
    ELSE
        UPDATE public.sys_users
        SET auth_id = v_auth_id,
            email = v_email
        WHERE auth_id IS NULL
          AND id = (
              SELECT id
              FROM public.sys_users
              WHERE auth_id IS NULL
                AND (email = v_email OR email = 'admin@erp.com' OR username = 'admin')
              ORDER BY id
              LIMIT 1
          );

        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        IF v_row_count = 0 THEN
            RAISE WARNING '未找到可绑定的 sys_users 行（auth_id 为空且 email/username 匹配），请人工核对';
        ELSE
            RAISE NOTICE '已回填 sys_users.auth_id = %（% 行）', v_auth_id, v_row_count;
        END IF;
    END IF;
END $$;

-- ============================================================================
-- 自检：确认绑定链完整（auth 账号 -> sys_users -> super_admin 角色）
-- ============================================================================

DO $$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT count(*) INTO v_count
    FROM auth.users a
    JOIN public.sys_users u ON u.auth_id = a.id
    JOIN public.sys_user_roles ur ON ur.user_id = u.id AND COALESCE(ur.is_deleted, 'n') = 'n'
    JOIN public.sys_roles r ON r.id = ur.role_id AND COALESCE(r.is_deleted, 'n') = 'n'
    WHERE a.email = 'admin@operp.com'
      AND r.role_code = 'super_admin';

    IF v_count > 0 THEN
        RAISE NOTICE '---- deploy_54 自检通过：admin@operp.com 已绑定 super_admin ----';
    ELSE
        RAISE WARNING '---- deploy_54 自检失败：admin@operp.com 未能绑定 super_admin，请人工核对 ----';
    END IF;
END $$;

SELECT
    u.id          AS sys_user_id,
    u.username,
    u.email,
    a.id          AS auth_id,
    r.role_code
FROM auth.users a
JOIN public.sys_users u ON u.auth_id = a.id
LEFT JOIN public.sys_user_roles ur ON ur.user_id = u.id AND COALESCE(ur.is_deleted, 'n') = 'n'
LEFT JOIN public.sys_roles r ON r.id = ur.role_id
WHERE a.email = 'admin@operp.com';

-- ============================================================================
-- 回滚（仅在需要拆掉本脚本时使用，勿随意执行）
--
--   DELETE FROM auth.identities WHERE user_id = (SELECT id FROM auth.users WHERE email='admin@operp.com');
--   DELETE FROM auth.users      WHERE email = 'admin@operp.com';
--   UPDATE public.sys_users SET auth_id = NULL WHERE email = 'admin@operp.com';
-- ============================================================================
