-- ============================================================================
-- deploy_52：平台元数据 —— 基线归超管，租户各自持有一份副本
--
-- 背景
-- ----
-- deploy_48 给 24 张平台元数据表（菜单/角色/字典/DocType/工作流定义...）装的
-- 是「共享基线」模型：tenant_id IS NULL 的行是平台基线，所有租户可见；
-- 而且为了不让存量租户开箱即瞎，当时把其中 15 张设成了 baseline_writable = TRUE
-- —— 任何有菜单维护权限的人改的都是那条共享基线，一个租户改名，三个租户一起变。
--
-- 这个模型只在「租户之间互相可信」时成立，现在必须收紧。
--
-- 新模型
-- ------
--   基线（tenant_id IS NULL）
--       超管的地盘：只有超管能改，也只有超管一定能看到。
--       它是「新租户开箱模板」，不是任何租户的运行数据。
--
--   租户副本（tenant_id = 租户）
--       每个租户完整持有一份自己的角色/菜单/字典，随便改，互不影响。
--       租户开通时从基线复制一份出来（bootstrap_tenant 自动做）。
--
--   已物化的租户看不到基线
--       sys_tenants.metadata_materialized = TRUE 后，该租户只读自己的副本。
--       否则会「基线 + 自己的副本」两份一起显示（菜单/角色列表全翻倍）。
--       未物化的租户仍然能读基线 —— 这是迁移期的兜底，避免复制到一半时
--       某个租户突然没有菜单。
--
--   为什么不让"承载超管的租户"物化
--       超管目前落在 sys_tenants.id = 1（sys_users.id=7, tenant_id=1）。
--       一旦把租户 1 也物化，基线就对超管不可见了，超管再也没法维护基线。
--       所以脚本里加了守护：租户下有 super_admin 绑定就拒绝物化。
--       租户 1 里的普通用户会变成"只读基线"，这是刻意的 —— 它就是平台租户。
--
-- 涉及的表（7 张，全部走新策略）
--   sys_roles / sys_menus / sys_dict_types / sys_dict_items
--   sys_role_menus / sys_role_table_permissions   ← 跟着角色走，一起复制
--   sys_user_roles                                ← 只收紧权限，不复制
--
--   两个必须一起做的配套改动，漏了会出事：
--   a) 超管判定收紧成「只认基线 super_admin 角色」（3b）。
--      否则克隆出来的租户本地 super_admin 是一条提权路径。
--      同时基线 super_admin 角色本身不参与复制（第 5 节）。
--   b) 6 张模板表的 tenant_id 默认值改成「超管 -> NULL，其它 -> 自己租户」（3c）。
--      前端表单从不传 tenant_id，不改的话超管新建的菜单会落进租户 1 的私有
--      空间，其它租户永远同步不到。
--
--   其余 17 张平台元数据表（sys_document_types、doc_flow_*、wf_process_definitions...）
--   保持 deploy_48 的共享基线模型不动 —— 它们不参与复制，套新策略会立刻让
--   所有租户读不到数据。
--
-- 唯一键：已确认不需要改造
--   sys_roles.role_code、sys_dict_types.code  → deploy_48 已改成「基线唯一 + 租户内唯一」
--   sys_menus                                  → 没有唯一键
--   sys_dict_items UNIQUE(type_id, code)       → type_id 复制后是新 id，不会撞
--
--   ⚠ 但下面两个是【全表唯一】，deploy_48 没改过它们（它只改了单列业务键）：
--       sys_role_menus              UNIQUE(role_id, menu_id)
--       sys_role_table_permissions  UNIQUE(role_id, table_id)
--     纯克隆时两个 id 都是新 id，不会撞；但第 4 节要把租户行搬回基线时，
--     如果写成「INSERT 基线行 + DELETE 租户行」，插入那一刻租户行还在，
--     立刻 23505。所以第 4 节一律用「原地 UPDATE tenant_id」。
--
-- 执行
--   建议先干跑看 NOTICE：把文件粘进 SQL Editor，开头加 BEGIN; 结尾加 ROLLBACK;
--   确认无误后改成 COMMIT; 再跑一次。
-- ============================================================================


-- ============================================================================
-- 1. 自检：改造前的分布
-- ============================================================================

DO $$
DECLARE
    r     RECORD;
    v_tbl TEXT;
    n     BIGINT;
BEGIN
    RAISE NOTICE '=== 改造前：基线(NULL) 行数 ===';
    FOREACH v_tbl IN ARRAY ARRAY[
        'sys_roles','sys_menus','sys_dict_types','sys_dict_items',
        'sys_role_menus','sys_role_table_permissions','sys_user_roles'
    ]
    LOOP
        EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id IS NULL', v_tbl) INTO n;
        RAISE NOTICE '  % : % 行基线', v_tbl, n;
    END LOOP;

    RAISE NOTICE '=== 租户清单 ===';
    FOR r IN SELECT id, code, name FROM public.sys_tenants
             WHERE COALESCE(is_deleted,'n')='n' ORDER BY id
    LOOP
        RAISE NOTICE '  租户 % : % (%)', r.id, r.name, r.code;
    END LOOP;

    -- tenant_id 为空的用户：本来就 fail-closed 看不到任何数据，这里只提示
    FOR r IN SELECT u.id, u.username FROM public.sys_users u
             WHERE u.tenant_id IS NULL AND COALESCE(u.is_deleted,'n')='n' ORDER BY u.id
    LOOP
        RAISE WARNING 'sys_users.id=% (%) 的 tenant_id 为空，登录后看不到任何角色/菜单，请回填租户或停用',
            r.id, r.username;
    END LOOP;
END $$;


-- ============================================================================
-- 2. sys_tenants 加物化标记
-- ============================================================================

ALTER TABLE public.sys_tenants
    ADD COLUMN IF NOT EXISTS metadata_materialized BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.sys_tenants.metadata_materialized IS
  'TRUE = 该租户已复制过平台基线（角色/菜单/字典），此后只能看到自己的副本，看不到基线。'
  'FALSE = 仍在使用共享基线（迁移期兜底 / 平台租户）。承载 super_admin 的租户必须保持 FALSE。';


-- ============================================================================
-- 3. 模板表专用的可见性/可写性判定
--
--    为什么不直接改 tenant_scope_visible()：那个函数还服务着另外 17 张平台
--    元数据表（DocType、单据转换、工作流定义...），它们不参与复制，一旦基线
--    对它们隐藏，所有租户立刻读不到数据。所以模板表单独一套。
-- ============================================================================

-- 基线是否对当前会话可见
CREATE OR REPLACE FUNCTION public.platform_baseline_visible()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.current_user_is_super_admin()
      OR NOT COALESCE(
             (SELECT t.metadata_materialized
              FROM public.sys_tenants t
              WHERE t.id = public.current_tenant_id()),
             FALSE);
$$;

-- 模板表：可见 = 自己的副本，或（基线且基线可见）
CREATE OR REPLACE FUNCTION public.template_scope_visible(p_tenant_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_tenant_id = public.current_tenant_id()
      OR (p_tenant_id IS NULL AND public.platform_baseline_visible());
$$;

-- 模板表：可写 = 自己的副本；基线只有超管能改（这一条与是否物化无关）
CREATE OR REPLACE FUNCTION public.template_scope_writable(p_tenant_id BIGINT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_tenant_id IS NOT NULL THEN p_tenant_id = public.current_tenant_id()
    ELSE public.current_user_is_super_admin()
  END;
$$;

-- 装模板表租户范围（与 install_tenant_scope 同构，只是换成 template_* 函数）
CREATE OR REPLACE FUNCTION public.install_template_scope(target_table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name=target_table_name AND column_name='tenant_id'
    ) THEN
        RAISE EXCEPTION 'public.% has no tenant_id column', target_table_name;
    END IF;

    -- 表上一个 permissive 都没有时，RESTRICTIVE 会让整表读不到，先补兜底
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname='public' AND tablename=target_table_name AND permissive='PERMISSIVE'
    ) THEN
        EXECUTE format(
            'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE)',
            'tenant_base_' || target_table_name, target_table_name);
        RAISE NOTICE '  added fallback permissive policy on %', target_table_name;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',
        'tenant_scope_' || target_table_name, target_table_name);
    EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
        'USING (public.template_scope_visible(tenant_id)) '
        'WITH CHECK (public.template_scope_writable(tenant_id))',
        'tenant_scope_' || target_table_name, target_table_name);
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_baseline_visible() TO authenticated;
GRANT EXECUTE ON FUNCTION public.template_scope_visible(BIGINT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.template_scope_writable(BIGINT) TO authenticated;


-- ============================================================================
-- 3b. 【安全】超管判定必须认「基线角色」，不能只认 role_code
--
--     deploy_03 的 current_user_is_super_admin() 只看 role_code = 'super_admin'。
--     一旦把基线角色复制给租户，租户里就会出现一份本地的 super_admin 角色，
--     租户管理员把它赋给自己 -> current_user_role_codes() 返回 super_admin ->
--     has_table_permission() 的 super_admin 快捷通道直接放行 = 提权到全库。
--
--     根治办法：判定加上 r.tenant_id IS NULL，只有基线那份 super_admin 算数。
--     角色复制时也会跳过 super_admin（见第 5 节），两条一起堵。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.sys_users u
    JOIN public.sys_user_roles ur ON ur.user_id = u.id
    JOIN public.sys_roles r ON r.id = ur.role_id
    WHERE u.auth_id = auth.uid()
      AND u.is_deleted = 'n'
      AND u.status = '1'
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND r.role_code = 'super_admin'
      AND r.tenant_id IS NULL          -- ← 新增：只认平台基线那份超管角色
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;


-- ============================================================================
-- 3c. 让「超管新建的东西」落在基线上
--
--     deploy_48 给这 6 张表装的 DEFAULT 是 current_tenant_id()，前端表单又
--     从不传 tenant_id（Menus.tsx / Roles.tsx / Dictionaries.tsx 都是直接
--     insert(values)）。超管自己属于租户 1，于是他在界面上新建的菜单/角色/
--     字典会写进 tenant_id = 1 —— 那是租户 1 的私有行，其它租户永远同步不到。
--
--     改成：超管 -> NULL（基线），普通租户 -> 自己的租户。
--     这样超管在界面上加一条菜单 = 往模板里加，老租户跑一次补差就能拿到。
--
--     sys_user_roles 不在列表里：它是「用户 -> 角色」的真实绑定，永远属于
--     具体某个租户，写进基线就成了全局绑定，反而危险。
-- ============================================================================

DO $$
DECLARE
    v_tbl TEXT;
BEGIN
    FOREACH v_tbl IN ARRAY ARRAY[
        'sys_roles','sys_menus','sys_dict_types','sys_dict_items',
        'sys_role_menus','sys_role_table_permissions'
    ]
    LOOP
        EXECUTE format(
            'ALTER TABLE public.%I ALTER COLUMN tenant_id SET DEFAULT '
            'CASE WHEN public.current_user_is_super_admin() THEN NULL::BIGINT '
            '     ELSE public.current_tenant_id() END', v_tbl);
        RAISE NOTICE 'baseline default installed: %', v_tbl;
    END LOOP;
END $$;


-- ============================================================================
-- 4. 修 deploy_50 的遗留：tenant_admin 的菜单/权限被写成了租户 3 私有
--
--    deploy_50 建 tenant_admin 基线角色时，把它的 39 条菜单、92 条表权限
--    写成了 tenant_id = 3。这些是"模板"，必须在基线上，否则新租户复制基线后
--    拿不到任何管理员菜单。这里搬回基线并删掉租户私有行。
--    只搬「角色和菜单都是基线」的行；租户自建菜单的绑定原样留下。
--
--    ⚠ 实现方式必须是「原地 UPDATE tenant_id = NULL」，不能 INSERT + DELETE：
--      sys_role_menus 的 UNIQUE(role_id, menu_id) 是全表唯一（deploy_48 没改它），
--      INSERT 一条基线行时同键的租户行还在，必然 23505。
--      同理，基线上已经有这一条时直接删掉租户行，不要搬。
-- ============================================================================

DO $$
DECLARE
    base_role_ids INT[];
    base_menu_ids INT[];
    v_dup         INTEGER;
    v_drop        INTEGER;
    v_moved       INTEGER;
BEGIN
    SELECT array_agg(id) INTO base_role_ids FROM public.sys_roles    WHERE tenant_id IS NULL;
    SELECT array_agg(id) INTO base_menu_ids FROM public.sys_menus    WHERE tenant_id IS NULL;

    IF base_role_ids IS NULL OR base_menu_ids IS NULL THEN
        RAISE WARNING '基线上没有角色或菜单，跳过本节';
        RETURN;
    END IF;

    ------------------------------------------------------------- sys_role_menus
    -- A) 同一 (role_id, menu_id) 在租户行里重复：只保留 id 最小的一条
    WITH dup AS (
        SELECT rm.id,
               row_number() OVER (PARTITION BY rm.role_id, rm.menu_id ORDER BY rm.id) AS rn
        FROM public.sys_role_menus rm
        WHERE rm.tenant_id IS NOT NULL
          AND rm.role_id = ANY(base_role_ids)
          AND rm.menu_id = ANY(base_menu_ids)
    )
    DELETE FROM public.sys_role_menus d USING dup
     WHERE d.id = dup.id AND dup.rn > 1;
    GET DIAGNOSTICS v_dup = ROW_COUNT;

    -- B) 基线上已经有了：租户行是多余的，删掉
    DELETE FROM public.sys_role_menus d
     WHERE d.tenant_id IS NOT NULL
       AND d.role_id = ANY(base_role_ids)
       AND d.menu_id = ANY(base_menu_ids)
       AND EXISTS (
           SELECT 1 FROM public.sys_role_menus b
           WHERE b.tenant_id IS NULL
             AND b.role_id = d.role_id
             AND b.menu_id = d.menu_id);
    GET DIAGNOSTICS v_drop = ROW_COUNT;

    -- C) 剩下的原地搬回基线（不产生新行，不可能撞唯一键）
    UPDATE public.sys_role_menus d
       SET tenant_id = NULL
     WHERE d.tenant_id IS NOT NULL
       AND d.role_id = ANY(base_role_ids)
       AND d.menu_id = ANY(base_menu_ids);
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    RAISE NOTICE 'sys_role_menus：搬回基线 % 条，删除重复 % 条，删除基线已有 % 条',
        v_moved, v_dup, v_drop;

    --------------------------------------------------- sys_role_table_permissions
    WITH dup AS (
        SELECT p.id,
               row_number() OVER (PARTITION BY p.role_id, p.table_id ORDER BY p.id) AS rn
        FROM public.sys_role_table_permissions p
        WHERE p.tenant_id IS NOT NULL
          AND p.role_id = ANY(base_role_ids)
    )
    DELETE FROM public.sys_role_table_permissions d USING dup
     WHERE d.id = dup.id AND dup.rn > 1;
    GET DIAGNOSTICS v_dup = ROW_COUNT;

    DELETE FROM public.sys_role_table_permissions d
     WHERE d.tenant_id IS NOT NULL
       AND d.role_id = ANY(base_role_ids)
       AND EXISTS (
           SELECT 1 FROM public.sys_role_table_permissions b
           WHERE b.tenant_id IS NULL
             AND b.role_id = d.role_id
             AND b.table_id = d.table_id);
    GET DIAGNOSTICS v_drop = ROW_COUNT;

    UPDATE public.sys_role_table_permissions d
       SET tenant_id = NULL
     WHERE d.tenant_id IS NOT NULL
       AND d.role_id = ANY(base_role_ids);
    GET DIAGNOSTICS v_moved = ROW_COUNT;

    RAISE NOTICE 'sys_role_table_permissions：搬回基线 % 条，删除重复 % 条，删除基线已有 % 条',
        v_moved, v_dup, v_drop;
END $$;


-- ============================================================================
-- 5. 复制基线给一个租户
--
--    幂等：按业务键判断目标租户里是否已有对应行
--        sys_roles                  role_code
--        sys_menus                  menu_code
--        sys_dict_types             code
--        sys_dict_items             (type_id, code)
--        sys_role_menus             (role_id, menu_id)
--        sys_role_table_permissions (role_id, table_id)
--
--    p_overwrite = FALSE（默认）：只补缺失的，不动租户已有的行。
--                 用于「平台新增了菜单，给老租户补差」。
--    p_overwrite = TRUE          ：已存在的行也用基线值覆盖，丢掉租户的自定义。
--                 只在明确要"跟平台对齐"时用。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.clone_platform_baseline_to_tenant(
    p_tenant_id   BIGINT,
    p_overwrite   BOOLEAN DEFAULT FALSE,
    p_materialize BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    src        RECORD;
    v_exist_id INTEGER;
    v_new_id   INTEGER;
    v_role_map JSONB := '{}'::JSONB;
    v_menu_map JSONB := '{}'::JSONB;
    v_type_map JSONB := '{}'::JSONB;
    v_new_menu INTEGER[] := '{}';   -- 本次真正新插的菜单，只有它们需要重映射 parent_id
    v_counts   JSONB := '{}'::JSONB;
    v_n        INTEGER;
    v_super    INTEGER;
    v_ctx      BIGINT;
BEGIN
    IF p_tenant_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.sys_tenants WHERE id = p_tenant_id) THEN
        RAISE EXCEPTION '租户 % 不存在', p_tenant_id USING ERRCODE = '22023';
    END IF;

    -- 调用权限：只能给自己的租户复制，超管不限。
    -- current_tenant_id() 为 NULL 时也放行 —— bootstrap_tenant 刚建完租户、
    -- 租户上下文还没落到 JWT（deploy_43 未安装）时就是这个状态。
    v_ctx := public.current_tenant_id();
    IF v_ctx IS NOT NULL
       AND v_ctx <> p_tenant_id
       AND NOT public.current_user_is_super_admin() THEN
        RAISE EXCEPTION '不允许给租户 % 复制基线：当前会话属于租户 %', p_tenant_id, v_ctx
            USING ERRCODE = '42501';
    END IF;

    -- 守护：物化承载超管的租户会让超管再也看不到基线
    IF p_materialize THEN
        SELECT count(*) INTO v_super
        FROM public.sys_user_roles ur
        JOIN public.sys_roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = p_tenant_id
          AND COALESCE(ur.is_deleted,'n') = 'n'
          AND r.role_code = 'super_admin';

        IF v_super > 0 THEN
            RAISE EXCEPTION '租户 % 下有 % 条 super_admin 绑定，物化后超管将看不到基线，拒绝执行'
                  '（如确需复制，用 p_materialize := FALSE）', p_tenant_id, v_super
                USING ERRCODE = '23514';
        END IF;
    END IF;

    ---------------------------------------------------------------- 1) 角色
    -- super_admin 不复制：它是平台级角色，租户里有一份本地副本就等于给了
    -- 租户管理员一条提权路径。第 3b 节已经把超管判定收紧成「只认基线角色」，
    -- 这里再不复制，双保险。它对应的 role_menus / 表权限也会因为映射表里
    -- 没有它而自动跳过。
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_roles s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
          AND s.role_code <> 'super_admin'
        ORDER BY s.id
    LOOP
        SELECT d.id INTO v_exist_id
        FROM public.sys_roles d
        WHERE d.tenant_id = p_tenant_id AND d.role_code = src.role_code
        LIMIT 1;

        IF v_exist_id IS NOT NULL THEN
            IF p_overwrite THEN
                UPDATE public.sys_roles d
                   SET role_name = src.role_name, description = src.description,
                       sort_order = src.sort_order, status = src.status,
                       is_deleted = src.is_deleted, updated_at = NOW()
                 WHERE d.id = v_exist_id;
            END IF;
            v_new_id := v_exist_id;
        ELSE
            INSERT INTO public.sys_roles
                (corp_id, emp_id, role_code, role_name, description, sort_order, status, is_deleted, tenant_id)
            VALUES
                (src.corp_id, src.emp_id, src.role_code, src.role_name, src.description,
                 src.sort_order, src.status, src.is_deleted, p_tenant_id)
            RETURNING id INTO v_new_id;
            v_n := v_n + 1;
        END IF;

        v_role_map := v_role_map || jsonb_build_object(src.id::TEXT, v_new_id);
    END LOOP;
    v_counts := v_counts || jsonb_build_object('sys_roles', v_n);

    ---------------------------------------------------------------- 2) 菜单
    -- 先照原样插入（parent_id 暂时还是基线的 id），插完再统一重映射
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_menus s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
        ORDER BY s.id
    LOOP
        SELECT d.id INTO v_exist_id
        FROM public.sys_menus d
        WHERE d.tenant_id = p_tenant_id AND d.menu_code = src.menu_code
        LIMIT 1;

        IF v_exist_id IS NOT NULL THEN
            IF p_overwrite THEN
                UPDATE public.sys_menus d
                   SET menu_name = src.menu_name, menu_type = src.menu_type, icon = src.icon,
                       path = src.path, component = src.component, sort_order = src.sort_order,
                       status = src.status, is_deleted = src.is_deleted, updated_at = NOW()
                 WHERE d.id = v_exist_id;
            END IF;
            v_new_id := v_exist_id;
        ELSE
            INSERT INTO public.sys_menus
                (corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
                 path, component, sort_order, status, is_deleted, tenant_id)
            VALUES
                (src.corp_id, src.emp_id, src.parent_id, src.menu_name, src.menu_code, src.menu_type,
                 src.icon, src.path, src.component, src.sort_order, src.status, src.is_deleted, p_tenant_id)
            RETURNING id INTO v_new_id;
            v_n := v_n + 1;
            v_new_menu := v_new_menu || v_new_id;
        END IF;

        v_menu_map := v_menu_map || jsonb_build_object(src.id::TEXT, v_new_id);
    END LOOP;

    -- parent_id 重映射：只动本次新插的行。
    -- 不能按 "parent_id 在基线映射表里" 来判断 —— 重跑补差时老行的 parent_id
    -- 是本租户的本地 id，很可能恰好等于某个基线菜单 id，会被误改。
    IF array_length(v_new_menu, 1) > 0 THEN
        UPDATE public.sys_menus d
           SET parent_id = (v_menu_map ->> d.parent_id::TEXT)::INTEGER
         WHERE d.id = ANY(v_new_menu)
           AND d.parent_id IS NOT NULL
           AND v_menu_map ? d.parent_id::TEXT;

        -- 基线父菜单被删/被跳过时 parent_id 会悬空，退回根节点（0），
        -- 否则菜单树拼不起来，整棵子树都不显示。
        UPDATE public.sys_menus d
           SET parent_id = 0
         WHERE d.id = ANY(v_new_menu)
           AND d.parent_id IS NOT NULL
           AND d.parent_id <> 0
           AND NOT EXISTS (
               SELECT 1 FROM public.sys_menus p
               WHERE p.id = d.parent_id AND p.tenant_id = d.tenant_id
           );
    END IF;

    v_counts := v_counts || jsonb_build_object('sys_menus', v_n);

    ------------------------------------------------------------ 3) 字典类型
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_dict_types s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
        ORDER BY s.id
    LOOP
        SELECT d.id INTO v_exist_id
        FROM public.sys_dict_types d
        WHERE d.tenant_id = p_tenant_id AND d.code = src.code
        LIMIT 1;

        IF v_exist_id IS NOT NULL THEN
            IF p_overwrite THEN
                UPDATE public.sys_dict_types d
                   SET name = src.name, description = src.description, sort_order = src.sort_order,
                       status = src.status, is_deleted = src.is_deleted, updated_at = NOW()
                 WHERE d.id = v_exist_id;
            END IF;
            v_new_id := v_exist_id;
        ELSE
            INSERT INTO public.sys_dict_types (code, name, description, sort_order, status, is_deleted, tenant_id)
            VALUES (src.code, src.name, src.description, src.sort_order, src.status, src.is_deleted, p_tenant_id)
            RETURNING id INTO v_new_id;
            v_n := v_n + 1;
        END IF;

        v_type_map := v_type_map || jsonb_build_object(src.id::TEXT, v_new_id);
    END LOOP;
    v_counts := v_counts || jsonb_build_object('sys_dict_types', v_n);

    ------------------------------------------------------------ 4) 字典项
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_dict_items s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
        ORDER BY s.id
    LOOP
        IF NOT (v_type_map ? src.type_id::TEXT) THEN
            CONTINUE;   -- 所属字典类型没复制过来（已被删除），跳过
        END IF;

        SELECT d.id INTO v_exist_id
        FROM public.sys_dict_items d
        WHERE d.tenant_id = p_tenant_id
          AND d.type_id = (v_type_map ->> src.type_id::TEXT)::INTEGER
          AND d.code = src.code
        LIMIT 1;

        IF v_exist_id IS NOT NULL THEN
            IF p_overwrite THEN
                UPDATE public.sys_dict_items d
                   SET label = src.label, description = src.description, sort_order = src.sort_order,
                       status = src.status, is_deleted = src.is_deleted, updated_at = NOW()
                 WHERE d.id = v_exist_id;
            END IF;
        ELSE
            INSERT INTO public.sys_dict_items
                (type_id, code, label, description, sort_order, status, is_deleted, tenant_id)
            VALUES
                ((v_type_map ->> src.type_id::TEXT)::INTEGER, src.code, src.label, src.description,
                 src.sort_order, src.status, src.is_deleted, p_tenant_id);
            v_n := v_n + 1;
        END IF;
    END LOOP;
    v_counts := v_counts || jsonb_build_object('sys_dict_items', v_n);

    ---------------------------------------------------------- 5) 角色-菜单
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_role_menus s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
        ORDER BY s.id
    LOOP
        IF NOT (v_role_map ? src.role_id::TEXT) OR NOT (v_menu_map ? src.menu_id::TEXT) THEN
            CONTINUE;   -- 基线里挂着已删除的角色/菜单，跳过
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.sys_role_menus d
            WHERE d.tenant_id = p_tenant_id
              AND d.role_id = (v_role_map ->> src.role_id::TEXT)::INTEGER
              AND d.menu_id = (v_menu_map ->> src.menu_id::TEXT)::INTEGER
        ) THEN
            INSERT INTO public.sys_role_menus (corp_id, emp_id, role_id, menu_id, is_deleted, tenant_id)
            VALUES (src.corp_id, src.emp_id,
                    (v_role_map ->> src.role_id::TEXT)::INTEGER,
                    (v_menu_map ->> src.menu_id::TEXT)::INTEGER,
                    src.is_deleted, p_tenant_id);
            v_n := v_n + 1;
        END IF;
    END LOOP;
    v_counts := v_counts || jsonb_build_object('sys_role_menus', v_n);

    ---------------------------------------------------------- 6) 角色-表权限
    v_n := 0;
    FOR src IN
        SELECT * FROM public.sys_role_table_permissions s
        WHERE s.tenant_id IS NULL AND COALESCE(s.is_deleted,'n') = 'n'
        ORDER BY s.id
    LOOP
        IF NOT (v_role_map ? src.role_id::TEXT) THEN
            CONTINUE;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.sys_role_table_permissions d
            WHERE d.tenant_id = p_tenant_id
              AND d.role_id  = (v_role_map ->> src.role_id::TEXT)::INTEGER
              AND d.table_id = src.table_id
        ) THEN
            INSERT INTO public.sys_role_table_permissions
                (corp_id, emp_id, role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
            VALUES
                (src.corp_id, src.emp_id, (v_role_map ->> src.role_id::TEXT)::INTEGER, src.table_id,
                 src.can_select, src.can_insert, src.can_update, src.can_delete, src.is_deleted, p_tenant_id);
            v_n := v_n + 1;
        END IF;
    END LOOP;
    v_counts := v_counts || jsonb_build_object('sys_role_table_permissions', v_n);

    ------------------------------------------- 7) 已有角色绑定改指副本角色
    -- 租户里已有的 sys_user_roles 指向的是基线角色 id。不重映射的话，用户
    -- 拿到的还是基线角色 -> 基线菜单，自己改副本不生效。
    --
    -- ⚠ sys_user_roles 有全表 UNIQUE(user_id, role_id)。如果用户已经绑了
    --   副本角色、同时又绑着基线角色，直接 UPDATE 会撞成两条一模一样的绑定。
    --   先删掉这类「改完就重复」的行，再改剩下的。

    DELETE FROM public.sys_user_roles d
     WHERE d.tenant_id = p_tenant_id
       AND v_role_map ? d.role_id::TEXT
       AND (v_role_map ->> d.role_id::TEXT)::INTEGER <> d.role_id
       AND EXISTS (
           SELECT 1 FROM public.sys_user_roles x
           WHERE x.tenant_id = d.tenant_id
             AND x.user_id  = d.user_id
             AND x.role_id  = (v_role_map ->> d.role_id::TEXT)::INTEGER
             AND x.id <> d.id);

    UPDATE public.sys_user_roles ur
       SET role_id = (v_role_map ->> ur.role_id::TEXT)::INTEGER
     WHERE ur.tenant_id = p_tenant_id
       AND COALESCE(ur.is_deleted,'n') = 'n'
       AND v_role_map ? ur.role_id::TEXT
       AND (v_role_map ->> ur.role_id::TEXT)::INTEGER <> ur.role_id;

    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('sys_user_roles_remapped', v_n);

    ------------------------------------------------------------ 8) 标记物化
    IF p_materialize THEN
        UPDATE public.sys_tenants
           SET metadata_materialized = TRUE, updated_at = NOW()
         WHERE id = p_tenant_id;
    END IF;

    RETURN v_counts;
END;
$$;

COMMENT ON FUNCTION public.clone_platform_baseline_to_tenant(BIGINT, BOOLEAN, BOOLEAN) IS
  '把平台基线（角色/菜单/字典及其关联）复制一份给指定租户，并把该租户标记为已物化。'
  '按业务键幂等，p_overwrite=FALSE 时只补缺失（用于平台新增菜单后给老租户补差）。';

GRANT EXECUTE ON FUNCTION public.clone_platform_baseline_to_tenant(BIGINT, BOOLEAN, BOOLEAN)
    TO authenticated;


-- ============================================================================
-- 6. 给现有租户复制一份
--
--    承载 super_admin 的租户（目前是 id=1）跳过 —— 它继续用基线，超管维护基线。
-- ============================================================================

DO $$
DECLARE
    t      RECORD;
    v_res  JSONB;
    v_sup  INTEGER;
BEGIN
    FOR t IN
        SELECT id, code, name FROM public.sys_tenants
        WHERE COALESCE(is_deleted,'n') = 'n'
        ORDER BY id
    LOOP
        SELECT count(*) INTO v_sup
        FROM public.sys_user_roles ur
        JOIN public.sys_roles r ON r.id = ur.role_id
        WHERE ur.tenant_id = t.id
          AND COALESCE(ur.is_deleted,'n') = 'n'
          AND r.role_code = 'super_admin';

        IF v_sup > 0 THEN
            RAISE NOTICE '跳过租户 % (%)：它承载 super_admin，继续使用共享基线（平台租户）', t.id, t.code;
            CONTINUE;
        END IF;

        v_res := public.clone_platform_baseline_to_tenant(t.id, FALSE, TRUE);
        RAISE NOTICE '租户 % (%) 已复制基线：%', t.id, t.code, v_res::TEXT;
    END LOOP;
END $$;


-- ============================================================================
-- 6b. 兜底：不管租户是怎么建出来的，都自动复制一份基线
--
--     bootstrap_tenant 里已经显式调了 clone，但超管在「系统 > 租户管理」里
--     是直接 INSERT sys_tenants（Tenants.tsx 第 83 行），那条路径不走 RPC。
--     挂个 AFTER INSERT 触发器，两条路都覆盖。
--
--     失败只告警不阻断：租户已经建好了，因为复制失败让开通整个回滚更糟。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trg_sys_tenants_clone_baseline()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_res JSONB;
BEGIN
    BEGIN
        v_res := public.clone_platform_baseline_to_tenant(NEW.id, FALSE, TRUE);
        RAISE NOTICE '新租户 % 自动复制基线：%', NEW.id, v_res::TEXT;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '租户 % 自动复制基线失败（%），请手工执行 SELECT public.clone_platform_baseline_to_tenant(%);',
            NEW.id, SQLERRM, NEW.id;
    END;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sys_tenants_clone_baseline ON public.sys_tenants;
CREATE TRIGGER trg_sys_tenants_clone_baseline
    AFTER INSERT ON public.sys_tenants
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_sys_tenants_clone_baseline();


-- ============================================================================
-- 7. 给 7 张模板表装新策略
-- ============================================================================

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY[
        'sys_roles', 'sys_menus', 'sys_dict_types', 'sys_dict_items',
        'sys_role_menus', 'sys_role_table_permissions', 'sys_user_roles'
    ]
    LOOP
        PERFORM public.install_template_scope(tbl);
        RAISE NOTICE 'template scope installed: %', tbl;
    END LOOP;
END $$;


-- ============================================================================
-- 8. 同步 SECURITY DEFINER 函数里的谓词
--
--    这三个函数以 owner 身份执行，绕开所有 RLS —— 策略改了它们照样读基线，
--    物化后的租户用户会拿到基线菜单而不是自己的副本。谓词必须写进函数体，
--    并且跟策略用同一套 template_scope_visible()。
-- ============================================================================

-- 8.1 菜单路径
CREATE OR REPLACE FUNCTION public.current_user_menu_paths()
RETURNS TABLE(path TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH current_roles AS (
    SELECT DISTINCT ur.role_id
    FROM public.sys_users u
    JOIN public.sys_user_roles ur ON ur.user_id = u.id
    WHERE u.auth_id = auth.uid()
      AND u.is_deleted = 'n'
      AND u.status = '1'
      AND ur.is_deleted = 'n'
      AND ur.role_id IS NOT NULL
      AND public.template_scope_visible(ur.tenant_id)
  )
  SELECT DISTINCT m.path::TEXT
  FROM current_roles cr
  JOIN public.sys_roles r ON r.id = cr.role_id
  JOIN public.sys_role_menus rm ON rm.role_id = r.id
  JOIN public.sys_menus m ON m.id = rm.menu_id
  WHERE r.is_deleted = 'n'
    AND r.status = '1'
    AND rm.is_deleted = 'n'
    AND m.is_deleted = 'n'
    AND m.status = '1'
    AND m.path IS NOT NULL
    AND m.path <> ''
    AND public.template_scope_visible(r.tenant_id)
    AND public.template_scope_visible(rm.tenant_id)
    AND public.template_scope_visible(m.tenant_id);
$$;


-- 8.2 角色代码
CREATE OR REPLACE FUNCTION public.current_user_role_codes()
RETURNS TABLE(role_code TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT r.role_code::TEXT
  FROM public.sys_users u
  JOIN public.sys_user_roles ur ON ur.user_id = u.id
  JOIN public.sys_roles r ON r.id = ur.role_id
  WHERE u.auth_id = auth.uid()
    AND u.is_deleted = 'n'
    AND u.status = '1'
    AND ur.is_deleted = 'n'
    AND r.is_deleted = 'n'
    AND r.status = '1'
    AND public.template_scope_visible(ur.tenant_id)
    AND public.template_scope_visible(r.tenant_id);
$$;


-- 8.3 表权限判定（被几乎所有 RLS 策略调用，除租户谓词外逐字保持 deploy_02 原样）
CREATE OR REPLACE FUNCTION public.has_table_permission(target_table_name TEXT, action_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id INTEGER;
BEGIN
  current_user_id := public.current_sys_user_id();

  IF current_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND r.role_code = 'super_admin'
      AND r.tenant_id IS NULL          -- 只认平台基线那份超管，租户副本不算
      AND public.template_scope_visible(ur.tenant_id)
      AND public.template_scope_visible(r.tenant_id)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    JOIN public.sys_role_table_permissions rp ON rp.role_id = r.id
    JOIN public.sys_tables t ON t.id = rp.table_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND rp.is_deleted = 'n'
      AND t.is_deleted = 'n'
      AND t.status = '1'
      AND t.table_name = target_table_name
      AND public.template_scope_visible(ur.tenant_id)
      AND public.template_scope_visible(r.tenant_id)
      AND public.template_scope_visible(rp.tenant_id)
      AND CASE action_name
        WHEN 'select' THEN rp.can_select
        WHEN 'insert' THEN rp.can_insert
        WHEN 'update' THEN rp.can_update
        WHEN 'delete' THEN rp.can_delete
        ELSE FALSE
      END
  );
END;
$$;


-- ============================================================================
-- 9. 新租户开通时自动复制基线
--    （bootstrap_tenant 原样照抄 deploy_50，只在末尾多一步 clone）
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
    v_cloned     JSONB;
BEGIN
    IF v_auth_id IS NULL THEN
        RAISE EXCEPTION '未登录：请先完成邮箱注册，再创建租户'
            USING ERRCODE = '28000';
    END IF;

    SELECT id, tenant_id INTO v_bound_id, v_bound_tid
    FROM public.sys_users
    WHERE auth_id = v_auth_id
    LIMIT 1;

    IF v_bound_id IS NOT NULL AND v_bound_tid IS NOT NULL THEN
        RAISE EXCEPTION '该账号已属于租户 %（sys_users.id=%），不能重复开通', v_bound_tid, v_bound_id
            USING ERRCODE = '23505';
    END IF;

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

    v_email := lower(btrim(COALESCE(auth.jwt() ->> 'email', '')));
    IF v_email = '' THEN
        RAISE EXCEPTION '无法从登录凭证中获取邮箱，请重新注册后重试' USING ERRCODE = '28000';
    END IF;

    v_username := COALESCE(NULLIF(btrim(p_admin_username), ''), v_email);

    IF EXISTS (
        SELECT 1 FROM public.sys_tenants
        WHERE code = btrim(p_tenant_code)
          AND COALESCE(is_deleted, 'n') = 'n'
    ) THEN
        RAISE EXCEPTION '租户编码 % 已被占用，请换一个', btrim(p_tenant_code)
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.sys_tenants (code, name, remark, status, is_deleted)
    VALUES (btrim(p_tenant_code), btrim(p_tenant_name), p_tenant_remark, '1', 'n')
    RETURNING id INTO v_tenant_id;

    IF v_bound_id IS NOT NULL THEN
        -- 竞态兜底：前端 signUp 后 AuthProvider 会抢先建一条 tenant_id 为空的
        -- profile，这里收编它而不是报错。
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
    END IF;

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

    -- 新增：从平台基线复制一套角色/菜单/字典给新租户，并标记为已物化。
    -- 这一步会顺带把上面那条 tenant_admin 绑定从基线角色改指成本租户的副本角色。
    BEGIN
        v_cloned := public.clone_platform_baseline_to_tenant(v_tenant_id, FALSE, TRUE);
        RAISE NOTICE '新租户 % 已从基线复制：%', v_tenant_id, v_cloned::TEXT;
    EXCEPTION WHEN OTHERS THEN
        -- 复制失败不能让租户开通失败（租户和账号已经建好了），
        -- 但必须让运维看见：此时该租户没有菜单，需要手工补跑一次。
        RAISE WARNING '新租户 % 复制基线失败（%），请手工执行 SELECT public.clone_platform_baseline_to_tenant(%);',
            v_tenant_id, SQLERRM, v_tenant_id;
        v_cloned := jsonb_build_object('error', SQLERRM);
    END;

    RETURN jsonb_build_object(
        'tenant_id',   v_tenant_id,
        'tenant_code', btrim(p_tenant_code),
        'tenant_name', btrim(p_tenant_name),
        'user_id',     v_user_id,
        'username',    v_username,
        'email',       v_email,
        'role_code',   CASE WHEN v_role_id IS NULL THEN NULL ELSE 'tenant_admin' END,
        'cloned',      v_cloned
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.bootstrap_tenant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
    TO authenticated;


-- ============================================================================
-- 10. 改造后自检
-- ============================================================================

DO $$
DECLARE
    r RECORD;
    n BIGINT;
    p BIGINT;
BEGIN
    RAISE NOTICE '=== 改造后：各租户私有副本行数 ===';
    FOR r IN SELECT id, code, metadata_materialized FROM public.sys_tenants
             WHERE COALESCE(is_deleted,'n')='n' ORDER BY id
    LOOP
        SELECT count(*) INTO n FROM public.sys_menus      WHERE tenant_id = r.id;
        SELECT count(*) INTO p FROM public.sys_roles      WHERE tenant_id = r.id;
        RAISE NOTICE '  租户 % (%) 物化=% : menus=% roles=%',
            r.id, r.code, r.metadata_materialized, n, p;

        IF r.metadata_materialized AND (n = 0 OR p = 0) THEN
            RAISE WARNING '租户 % 已标记物化但没有菜单/角色副本，登录后将是空菜单！', r.id;
        END IF;
    END LOOP;

    -- 菜单 parent_id 必须指向同租户的菜单
    FOR r IN
        SELECT d.id, d.menu_code, d.parent_id
        FROM public.sys_menus d
        WHERE d.tenant_id IS NOT NULL
          AND d.parent_id IS NOT NULL
          AND d.parent_id <> 0
          AND NOT EXISTS (
              SELECT 1 FROM public.sys_menus p2
              WHERE p2.id = d.parent_id AND p2.tenant_id = d.tenant_id
          )
        LIMIT 10
    LOOP
        RAISE WARNING 'sys_menus.id=% (%) 的 parent_id=% 指向了别的租户/不存在的菜单',
            r.id, r.menu_code, r.parent_id;
    END LOOP;

    -- 角色绑定必须指向同租户的角色
    -- 只看已物化的租户：未物化的（平台租户）本来就指向基线角色，那是设计如此
    FOR r IN
        SELECT ur.id, ur.user_id, ur.role_id, ur.tenant_id
        FROM public.sys_user_roles ur
        JOIN public.sys_tenants tt ON tt.id = ur.tenant_id AND tt.metadata_materialized
        WHERE COALESCE(ur.is_deleted,'n') = 'n'
          AND NOT EXISTS (
              SELECT 1 FROM public.sys_roles rr
              WHERE rr.id = ur.role_id AND rr.tenant_id = ur.tenant_id
          )
        LIMIT 10
    LOOP
        RAISE WARNING 'sys_user_roles.id=% (user=% -> role=%) 的 role_id 不在本租户内',
            r.id, r.user_id, r.role_id;
    END LOOP;
END $$;


NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 回滚
--   1) 策略退回共享基线模型：
--        DO $$ DECLARE t TEXT; BEGIN
--          FOREACH t IN ARRAY ARRAY['sys_roles','sys_menus','sys_dict_types','sys_dict_items',
--                                   'sys_role_menus','sys_role_table_permissions','sys_user_roles']
--          LOOP PERFORM public.install_tenant_scope(t, TRUE); END LOOP; END $$;
--   2) 三个 definer 函数里的 template_scope_visible 改回 tenant_scope_visible
--      （把第 8 节的三段 SQL 里的 template_ 换成 tenant_ 再跑一次）
--   3) 清掉副本（谨慎，会删掉租户在这几张表上的全部私有数据）：
--        DELETE FROM public.sys_role_table_permissions WHERE tenant_id IS NOT NULL;
--        DELETE FROM public.sys_role_menus             WHERE tenant_id IS NOT NULL;
--        DELETE FROM public.sys_dict_items             WHERE tenant_id IS NOT NULL;
--        DELETE FROM public.sys_dict_types             WHERE tenant_id IS NOT NULL;
--        DELETE FROM public.sys_menus                  WHERE tenant_id IS NOT NULL;
--        DELETE FROM public.sys_roles                  WHERE tenant_id IS NOT NULL;
--        UPDATE public.sys_tenants SET metadata_materialized = FALSE;
--      （sys_user_roles 的私有行是真实绑定，不要删；只把 role_id 指回基线角色）
--
-- 日常运维
--   平台新增菜单/字典后，给老租户补差（只补缺失，不动租户自定义）：
--     SELECT public.clone_platform_baseline_to_tenant(2);
--     SELECT public.clone_platform_baseline_to_tenant(3);
--   强制用基线覆盖租户的自定义：
--     SELECT public.clone_platform_baseline_to_tenant(3, p_overwrite := TRUE);
-- ============================================================================
