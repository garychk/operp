-- ============================================================================
-- deploy_50: 租户自助注册链路
--
--   目标流程（标准 SaaS 开通方式）：
--     1. 访客在登录页注册：填租户名称 / 租户编码 / 管理员信息 / 邮箱 / 密码
--     2. 系统建 auth 账号 -> 建租户 -> 在该租户下建默认管理员 -> 赋「租户管理员」角色
--     3. 用这个管理员账号登录，进入自己的租户
--     4. 管理员在「用户管理」里加人，新用户即可登录进同一租户
--
--   为什么必须引入 SECURITY DEFINER 函数：
--     deploy_41 给 sys_tenants 的 INSERT 策略是 `WITH CHECK (current_user_is_super_admin())`，
--     普通 authenticated 插不进租户表。自助注册时调用者刚注册、没有任何角色，
--     只有 definer 函数能在受控条件下代他建租户。
--
--   为什么不能拿 super_admin 当默认管理员：
--     super_admin 是基线行（tenant_id IS NULL），任何租户的管理员都能把它赋给自己的用户；
--     current_user_is_super_admin() 一旦为真，RLS 的租户谓词就整体放行 —— 等于发出一张
--     能看全部租户数据的全局通行证。所以这里新建独立的 tenant_admin 基线角色。
--
--   幂等：所有建角色/授权/建索引都带 IF NOT EXISTS 或 NOT EXISTS 判断，可重复执行。
-- ============================================================================


-- ============================================================================
-- 1. 基线角色：tenant_admin（租户管理员）
--
--    tenant_id IS NULL = 平台基线，所有租户可见可用（deploy_48 的模型）。
--    它拿不到 super_admin 的跨租户豁免，只在本租户内是最高权限。
-- ============================================================================

DO $$
DECLARE
    v_role_id INTEGER;
BEGIN
    SELECT id INTO v_role_id
    FROM public.sys_roles
    WHERE role_code = 'tenant_admin'
    LIMIT 1;

    IF v_role_id IS NOT NULL THEN
        RAISE NOTICE '角色 tenant_admin 已存在（id=%），跳过创建', v_role_id;
        RETURN;
    END IF;

    INSERT INTO public.sys_roles
        (role_code, role_name, description, sort_order, status, is_deleted, tenant_id)
    VALUES
        ('tenant_admin', '租户管理员',
         '租户内最高权限：可管理本租户的用户、角色、菜单、字典及全部业务数据；不能创建或查看其它租户。',
         6, '1', 'n', NULL)
    RETURNING id INTO v_role_id;

    RAISE NOTICE '已创建基线角色 tenant_admin（id=%）', v_role_id;
END $$;


-- ============================================================================
-- 2. 给 super_admin 补齐全量基线授权，再以它为模板授权 tenant_admin
--
--    为什么模板是 super_admin 而不是 finance_manager：
--    早期版本的库经过手工配置，finance_manager 恰好有 38 条菜单 / 89 条表权限，
--    当时以此为模板。但在全新 reset 的库里，业务菜单与业务表权限「只插了
--    sys_menus / sys_tables 元数据、从未授权给任何角色」，finance_manager 是
--    空的 —— 复制出来 tenant_admin 只有 /system 父节点，租户管理员登录后
--    「系统管理下没有子菜单」，业务表也全部 fail-closed。
--    所以这里先幂等地把 super_admin 补到全量（超管本就该有全部授权），再复制。
--
--    授权 tenant_admin 时仍排除 /system/tenants：租户管理员不能看租户列表。
-- ============================================================================

-- 2.0) super_admin 补齐全部基线菜单授权（幂等）
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
JOIN public.sys_menus m ON COALESCE(m.is_deleted, 'n') = 'n' AND m.tenant_id IS NULL
WHERE r.role_code = 'super_admin'
  AND r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
      SELECT 1 FROM public.sys_role_menus dup
      WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

-- 2.0b) super_admin 补齐全部基线表权限（全权限，幂等）
INSERT INTO public.sys_role_table_permissions
    (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
JOIN public.sys_tables t ON COALESCE(t.is_deleted, 'n') = 'n'
WHERE r.role_code = 'super_admin'
  AND r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
      SELECT 1 FROM public.sys_role_table_permissions dup
      WHERE dup.role_id = r.id AND dup.table_id = t.id
  );

-- 2a) 复制 super_admin 的菜单给 tenant_admin，排除租户管理
DO $$
DECLARE
    v_role_id     INTEGER;
    v_src_role_id INTEGER;
    v_count       INTEGER;
BEGIN
    SELECT id INTO v_role_id FROM public.sys_roles WHERE role_code = 'tenant_admin' AND tenant_id IS NULL LIMIT 1;
    SELECT id INTO v_src_role_id FROM public.sys_roles WHERE role_code = 'super_admin' AND tenant_id IS NULL LIMIT 1;

    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'tenant_admin 角色不存在，无法授权菜单';
    END IF;

    IF v_src_role_id IS NULL THEN
        RAISE WARNING '未找到 super_admin 角色，跳过菜单授权（tenant_admin 将无任何菜单）';
        RETURN;
    END IF;

    INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
    SELECT v_role_id, src.menu_id, 'n', NULL
    FROM public.sys_role_menus src
    JOIN public.sys_menus m ON m.id = src.menu_id
    WHERE src.role_id = v_src_role_id
      AND COALESCE(src.is_deleted, 'n') = 'n'
      AND COALESCE(m.is_deleted, 'n') = 'n'
      AND COALESCE(m.path, '') <> '/system/tenants'
      AND NOT EXISTS (
          SELECT 1
          FROM public.sys_role_menus dup
          WHERE dup.role_id = v_role_id
            AND dup.menu_id = src.menu_id
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'tenant_admin 复制菜单 % 条（已排除 /system/tenants）', v_count;

    -- 2b) 补 /system 父节点，否则侧边栏出不来「系统管理」分组
    INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
    SELECT v_role_id, m.id, 'n', NULL
    FROM public.sys_menus m
    WHERE COALESCE(m.path, '') = '/system'
      AND COALESCE(m.is_deleted, 'n') = 'n'
      AND NOT EXISTS (
          SELECT 1
          FROM public.sys_role_menus dup
          WHERE dup.role_id = v_role_id
            AND dup.menu_id = m.id
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'tenant_admin 补充父菜单 % 条', v_count;
END $$;


-- ============================================================================
-- 3. 给 tenant_admin 授权表权限（模板：super_admin 全量，见步骤 2 的说明）
--
--    菜单只决定「看得到入口」，真正能读写要靠 sys_role_table_permissions
--    （has_table_permission() 会查它）。缺了这块，用户管理页打开就是空白或报错。
--    3b/3c 把系统管理相关的几张表再显式提升到全权限，双保险。
-- ============================================================================

DO $$
DECLARE
    v_role_id     INTEGER;
    v_src_role_id INTEGER;
    v_count       INTEGER;
BEGIN
    SELECT id INTO v_role_id FROM public.sys_roles WHERE role_code = 'tenant_admin' AND tenant_id IS NULL LIMIT 1;
    SELECT id INTO v_src_role_id FROM public.sys_roles WHERE role_code = 'super_admin' AND tenant_id IS NULL LIMIT 1;

    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'tenant_admin 角色不存在，无法授权表权限';
    END IF;

    IF v_src_role_id IS NULL THEN
        RAISE WARNING '未找到 super_admin 角色，跳过表权限复制';
        RETURN;
    END IF;

    -- 3a) 复制 super_admin 的全部表权限（2.0b 已保证其全量）
    INSERT INTO public.sys_role_table_permissions
        (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
    SELECT v_role_id, src.table_id, src.can_select, src.can_insert,
           src.can_update, src.can_delete, 'n', NULL
    FROM public.sys_role_table_permissions src
    WHERE src.role_id = v_src_role_id
      AND COALESCE(src.is_deleted, 'n') = 'n'
      AND NOT EXISTS (
          SELECT 1
          FROM public.sys_role_table_permissions dup
          WHERE dup.role_id = v_role_id
            AND dup.table_id = src.table_id
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'tenant_admin 复制表权限 % 条', v_count;

    -- 3b) 系统管理相关表：确保有行
    INSERT INTO public.sys_role_table_permissions
        (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
    SELECT v_role_id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
    FROM public.sys_tables t
    WHERE t.table_name IN (
              'sys_users', 'sys_user_roles', 'sys_roles', 'sys_role_menus',
              'sys_menus', 'sys_dict_types', 'sys_dict_items',
              'sys_role_table_permissions'
          )
      AND NOT EXISTS (
          SELECT 1
          FROM public.sys_role_table_permissions dup
          WHERE dup.role_id = v_role_id
            AND dup.table_id = t.id
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'tenant_admin 补充系统管理表权限 % 条', v_count;

    -- 3c) 系统管理相关表：提升到全权限（模板里这几张是只读或半只读）
    UPDATE public.sys_role_table_permissions p
    SET can_select = TRUE,
        can_insert = TRUE,
        can_update = TRUE,
        can_delete = TRUE
    WHERE p.role_id = v_role_id
      AND p.table_id IN (
          SELECT t.id
          FROM public.sys_tables t
          WHERE t.table_name IN (
              'sys_users', 'sys_user_roles', 'sys_roles', 'sys_role_menus',
              'sys_menus', 'sys_dict_types', 'sys_dict_items',
              'sys_role_table_permissions'
          )
      );

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RAISE NOTICE 'tenant_admin 提升为全权限 % 条', v_count;
END $$;


-- ============================================================================
-- 4. sys_users.username 唯一键改成「租户内唯一」
--
--    原来 username 是 NOT NULL UNIQUE（全表唯一）。多租户下这直接不可用：
--    租户 A 的管理员叫 admin，租户 B 的管理员也叫 admin 就会撞唯一约束。
--    先确认过没有外键引用 sys_users(username)（只有 sys_user_roles.user_id 引 id），
--    所以可以安全拆成两条部分索引，与 deploy_48 的做法一致：
--       tenant_id IS NULL     -> 基线内唯一
--       tenant_id IS NOT NULL -> 租户内唯一
--    email 保持不设唯一：GoTrue 层一个邮箱本来就只能有一个 auth 账号，
--    在库里再加一条反而会和「换绑/回收」场景打架。
-- ============================================================================

DO $$
DECLARE
    v_col_attnum  SMALLINT;
    v_conname     TEXT;
    v_dropped     INTEGER := 0;
BEGIN
    SELECT attnum INTO v_col_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.sys_users'::regclass
      AND attname = 'username'
      AND attnum > 0
      AND NOT attisdropped;

    IF v_col_attnum IS NULL THEN
        RAISE WARNING 'sys_users 没有 username 列，跳过唯一键改造';
        RETURN;
    END IF;

    -- 只删「恰好只约束 username 这一列」的唯一约束，避免误伤复合键
    FOR v_conname IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.conrelid = 'public.sys_users'::regclass
          AND c.contype = 'u'
          AND c.conkey = ARRAY[v_col_attnum]
    LOOP
        EXECUTE format('ALTER TABLE public.sys_users DROP CONSTRAINT %I', v_conname);
        v_dropped := v_dropped + 1;
        RAISE NOTICE '已删除原唯一约束 %', v_conname;
    END LOOP;

    IF v_dropped = 0 THEN
        RAISE NOTICE '未发现 username 单列唯一约束（可能已改造过），跳过删除';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_users_username_baseline
    ON public.sys_users (username)
    WHERE tenant_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_users_username_tenant
    ON public.sys_users (tenant_id, username)
    WHERE tenant_id IS NOT NULL;


-- ============================================================================
-- 5. bootstrap_tenant()：注册链路的核心
--
--    SECURITY DEFINER：调用者刚注册、没有角色，插不进 sys_tenants（策略只放超管）。
--    但 definer 等于临时拿到 owner 权限，所以每一步都不能信任入参，必须自己校验：
--
--       a) auth.uid() 必须存在 —— 只认真实登录会话，anon 调不了
--       b) 该 auth_id 若已绑定 sys_users 且 tenant_id 非空 -> 拒绝，一个 auth 账号
--          只能开一个租户。这是防刷底线：想开第二个租户必须再注册一个 auth 账号
--          （受 GoTrue 的邮箱唯一性约束），不能靠反复调 RPC 刷库。
--          若已绑定但 tenant_id 为空 -> 放行并改为更新该行（见下方「竞态兜底」）。
--          若未绑定但 INSERT 时撞 auth_id 唯一键（loadAppUser 恰在检查与插入之间
--          抢先建档）-> 捕获 unique_violation 后同样收编该行，见 INSERT 的异常分支。
--       c) 租户编码格式白名单 + 占用检查
--       d) 管理员邮箱只从 JWT 取，不接受入参 —— 否则可以拿别人的邮箱建管理员
--
--    关于 tenant_id 必须显式写：
--      definer 函数里 DEFAULT current_tenant_id() 会去 sys_users 查调用者，
--      此刻该行还不存在 -> 解析成 NULL。不显式给就会把管理员建成「无租户」用户。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.bootstrap_tenant(
    p_tenant_code     TEXT,
    p_tenant_name     TEXT,
    p_admin_real_name TEXT DEFAULT NULL,
    p_admin_username  TEXT DEFAULT NULL,
    p_admin_phone     TEXT DEFAULT NULL,
    p_tenant_remark   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_auth_id    UUID := auth.uid();
    v_email      TEXT;
    v_username   TEXT;
    v_tenant_id  BIGINT;
    v_user_id    INTEGER;
    v_role_id    INTEGER;
    v_bound_id   INTEGER;
    v_bound_tid  BIGINT;
BEGIN
    -- a) 必须是真实登录会话
    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION '未登录：请先完成邮箱注册，再创建租户'
            USING ERRCODE = '28000';
    END IF;

    -- b) 一个 auth 账号只能开一个租户
    SELECT id, tenant_id INTO v_bound_id, v_bound_tid
    FROM public.sys_users
    WHERE auth_id = v_auth_id
    LIMIT 1;

    IF v_bound_id IS NOT NULL AND v_bound_tid IS NOT NULL THEN
        RAISE EXCEPTION '该账号已属于租户 %（sys_users.id=%），不能重复开通', v_bound_tid, v_bound_id
            USING ERRCODE = '23505';
    END IF;

    -- c) 租户编码：小写字母开头，只允许小写字母/数字/下划线/短横线，2~31 位
    IF p_tenant_code IS NULL OR btrim(p_tenant_code) = '' THEN
        RAISE EXCEPTION '租户编码不能为空' USING ERRCODE = '22023';
    END IF;

    IF btrim(p_tenant_code) !~ '^[a-z][a-z0-9_-]{1,30}$' THEN
        RAISE EXCEPTION '租户编码不合法（%）：需小写字母开头，仅含小写字母/数字/下划线/短横线，长度 2~31', p_tenant_code
            USING ERRCODE = '22023';
    END IF;

    IF p_tenant_name IS NULL OR btrim(p_tenant_name) = '' THEN
        RAISE EXCEPTION '租户名称不能为空' USING ERRCODE = '22023';
    END IF;

    -- d) 邮箱只认 JWT，不接受入参
    v_email := lower(btrim(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_email = '' THEN
        RAISE EXCEPTION '无法从登录凭证中获取邮箱，请重新注册后重试' USING ERRCODE = '28000';
    END IF;

    -- 用户名默认取邮箱；此时 username 唯一键已按租户拆分，不同租户可重名
    v_username := COALESCE(NULLIF(btrim(p_admin_username), ''), v_email);

    IF EXISTS (
        SELECT 1 FROM public.sys_tenants
        WHERE code = btrim(p_tenant_code)
          AND COALESCE(is_deleted, 'n') = 'n'
    ) THEN
        RAISE EXCEPTION '租户编码 % 已被占用，请换一个', btrim(p_tenant_code)
            USING ERRCODE = '23505';
    END IF;

    -- 建租户（sys_tenants 没有 tenant_id 列，它自己就是租户主表）
    INSERT INTO public.sys_tenants (code, name, remark, status, is_deleted)
    VALUES (btrim(p_tenant_code), btrim(p_tenant_name), p_tenant_remark, '1', 'n')
    RETURNING id INTO v_tenant_id;

    IF v_bound_id IS NOT NULL THEN
        -- 竞态兜底：前端 signUp 后，AuthProvider 的 onAuthStateChange 会立刻跑
        -- loadAppUser()，它发现没有 profile 就自动建一条 tenant_id 为空的记录。
        -- 这条记录可能先于本函数落库。此时不该报错（否则用户永远开通不了），
        -- 而是把这条空租户的 profile 收编进新租户。
        -- 副作用是意料之外的好处：存量里那些 tenant_id 为空的老账号，
        -- 登录后也能自助开通租户补上归属。
        UPDATE public.sys_users
        SET tenant_id    = v_tenant_id,
            username     = v_username,
            real_name    = COALESCE(NULLIF(btrim(COALESCE(p_admin_real_name, '')), ''), real_name),
            phone        = COALESCE(NULLIF(btrim(COALESCE(p_admin_phone, '')), ''), phone),
            email        = v_email,
            password_hash = '$supabase_auth$',
            status       = '1',
            is_deleted   = 'n',
            updated_at   = NOW()
        WHERE id = v_bound_id
        RETURNING id INTO v_user_id;

        RAISE NOTICE '复用已存在的空租户档案 sys_users.id=% 收编进新租户 %', v_user_id, v_tenant_id;
    ELSE
        -- TOCTOU 竞态兜底：上方的「是否已绑定」检查与下面的 INSERT 之间存在窗口，
        -- 注册后 onAuthStateChange 触发的 loadAppUser() 可能恰好在窗口内抢先插入
        -- 一条 tenant_id 为空的档案（auth_id 相同），INSERT 会撞 sys_users_auth_id_key。
        -- 撞上时不报错，重新找到那条抢先插入的行，走收编更新。
        BEGIN
            INSERT INTO public.sys_users
                (auth_id, tenant_id, username, real_name, email, phone,
                 password_hash, status, is_deleted)
            VALUES
                (v_auth_id, v_tenant_id, v_username,
                 NULLIF(btrim(COALESCE(p_admin_real_name, '')), ''),
                 v_email,
                 NULLIF(btrim(COALESCE(p_admin_phone, '')), ''),
                 '$supabase_auth$', '1', 'n')
            RETURNING id INTO v_user_id;
        EXCEPTION
            WHEN unique_violation THEN
                SELECT id, tenant_id INTO v_bound_id, v_bound_tid
                FROM public.sys_users
                WHERE auth_id = v_auth_id
                LIMIT 1;

                IF v_bound_id IS NULL OR v_bound_tid IS NOT NULL THEN
                    -- 冲突的不是 loadAppUser 抢先建档，而是别的问题：原样抛出
                    RAISE;
                END IF;

                UPDATE public.sys_users
                SET tenant_id    = v_tenant_id,
                    username     = v_username,
                    real_name    = COALESCE(NULLIF(btrim(COALESCE(p_admin_real_name, '')), ''), real_name),
                    phone        = COALESCE(NULLIF(btrim(COALESCE(p_admin_phone, '')), ''), phone),
                    email        = v_email,
                    password_hash = '$supabase_auth$',
                    status       = '1',
                    is_deleted   = 'n',
                    updated_at   = NOW()
                WHERE id = v_bound_id
                RETURNING id INTO v_user_id;

                RAISE NOTICE 'INSERT 撞 auth_id 唯一键（loadAppUser 竞态），已收编 sys_users.id=% 进新租户 %', v_user_id, v_tenant_id;
        END;
    END IF;

    -- 赋租户管理员角色（显式 tenant_id：这条是本租户私有数据，不是基线）
    SELECT id INTO v_role_id
    FROM public.sys_roles
    WHERE role_code = 'tenant_admin'
      AND COALESCE(is_deleted, 'n') = 'n'
    LIMIT 1;

    IF v_role_id IS NULL THEN
        RAISE WARNING '未找到 tenant_admin 角色，新管理员（sys_users.id=%）暂无任何角色', v_user_id;
    ELSE
        INSERT INTO public.sys_user_roles (user_id, role_id, is_deleted, tenant_id)
        VALUES (v_user_id, v_role_id, 'n', v_tenant_id);
    END IF;

    RETURN jsonb_build_object(
        'tenant_id',   v_tenant_id,
        'tenant_code', btrim(p_tenant_code),
        'tenant_name', btrim(p_tenant_name),
        'user_id',     v_user_id,
        'username',    v_username,
        'email',       v_email,
        'role_code',   CASE WHEN v_role_id IS NULL THEN NULL ELSE 'tenant_admin' END
    );
END;
$$;

COMMENT ON FUNCTION public.bootstrap_tenant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  '自助开通租户：建租户 + 在该租户下建默认管理员 + 赋 tenant_admin 角色。'
  '管理员邮箱只取自 JWT，租户编码做白名单校验，一个 auth 账号只能开一次。';

-- 只给 authenticated：注册流程是「先 signUp 拿到会话，再调本函数」，
-- 不给 anon 可以避免未验证身份的调用。
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
    TO authenticated;


-- ============================================================================
-- 6. 自检
-- ============================================================================

DO $$
DECLARE
    v_role_id     INTEGER;
    v_menu_count  INTEGER;
    v_perm_count  INTEGER;
    v_fn_count    INTEGER;
    v_idx_count   INTEGER;
    v_tenant_menu INTEGER;
BEGIN
    SELECT id INTO v_role_id FROM public.sys_roles WHERE role_code = 'tenant_admin' LIMIT 1;

    SELECT count(*) INTO v_menu_count
    FROM public.sys_role_menus
    WHERE role_id = v_role_id AND COALESCE(is_deleted, 'n') = 'n';

    SELECT count(*) INTO v_perm_count
    FROM public.sys_role_table_permissions
    WHERE role_id = v_role_id AND COALESCE(is_deleted, 'n') = 'n';

    SELECT count(*) INTO v_tenant_menu
    FROM public.sys_role_menus rm
    JOIN public.sys_menus m ON m.id = rm.menu_id
    WHERE rm.role_id = v_role_id
      AND COALESCE(rm.is_deleted, 'n') = 'n'
      AND COALESCE(m.path, '') = '/system/tenants';

    SELECT count(*) INTO v_fn_count
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'bootstrap_tenant';

    SELECT count(*) INTO v_idx_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('uq_sys_users_username_baseline', 'uq_sys_users_username_tenant');

    RAISE NOTICE '---- deploy_50 自检 ----';
    RAISE NOTICE 'tenant_admin 角色 id          : %', COALESCE(v_role_id::TEXT, '未创建(异常)');
    RAISE NOTICE 'tenant_admin 菜单数           : %', v_menu_count;
    RAISE NOTICE 'tenant_admin 表权限数         : %', v_perm_count;
    RAISE NOTICE '误授 /system/tenants 菜单数   : % (必须为 0)', v_tenant_menu;
    RAISE NOTICE 'bootstrap_tenant 函数数       : %', v_fn_count;
    RAISE NOTICE 'username 部分唯一索引数       : % (应为 2)', v_idx_count;
END $$;

SELECT
    r.id            AS role_id,
    r.role_code,
    r.role_name,
    r.tenant_id,
    (SELECT count(*) FROM public.sys_role_menus rm
      WHERE rm.role_id = r.id AND COALESCE(rm.is_deleted,'n')='n')        AS menu_count,
    (SELECT count(*) FROM public.sys_role_table_permissions p
      WHERE p.role_id = r.id AND COALESCE(p.is_deleted,'n')='n')          AS table_perm_count
FROM public.sys_roles r
WHERE r.role_code = 'tenant_admin';


-- ============================================================================
-- 回滚（仅在需要拆掉本脚本时使用，勿随意执行）
--
--   DROP FUNCTION IF EXISTS public.bootstrap_tenant(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT);
--   DELETE FROM public.sys_role_table_permissions WHERE role_id = (SELECT id FROM public.sys_roles WHERE role_code='tenant_admin');
--   DELETE FROM public.sys_role_menus             WHERE role_id = (SELECT id FROM public.sys_roles WHERE role_code='tenant_admin');
--   DELETE FROM public.sys_user_roles             WHERE role_id = (SELECT id FROM public.sys_roles WHERE role_code='tenant_admin');
--   DELETE FROM public.sys_roles                  WHERE role_code = 'tenant_admin';
--   DROP INDEX IF EXISTS public.uq_sys_users_username_baseline;
--   DROP INDEX IF EXISTS public.uq_sys_users_username_tenant;
--   -- username 的全表唯一需要手工重建：
--   ALTER TABLE public.sys_users ADD CONSTRAINT sys_users_username_key UNIQUE (username);
--   -- 注意：若已有多个租户存在同名 username，重建会失败，需要先人工去重。
-- ============================================================================
