-- ============================================================================
-- deploy_44_tenant_menu.sql
--
-- 给「租户管理」页面注册菜单，并授权给 super_admin。
-- 前置：deploy_41 已执行；前端 Tenants.tsx 已上线。
--
-- 为什么单独一个脚本而不是自动执行：sys_menus / sys_role_menus 属于权限表，
-- 按本项目的写权限边界，AI 不代为写入，交给你确认后执行。
--
-- 执行方式：建议在 Studio 里 BEGIN; ... 看 NOTICE ... COMMIT;
-- ============================================================================


-- ============================================================================
-- 1. 插入菜单项（挂在「系统管理」下，排在用户管理之后）
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.sys_menus
        WHERE menu_code = 'tenant' AND is_deleted = 'n'
    ) THEN
        RAISE NOTICE '租户管理菜单已存在，跳过插入';
        RETURN;
    END IF;

    -- 把同级里 sort_order >= 2 的菜单往后挪一位，腾出位置
    UPDATE public.sys_menus
       SET sort_order = sort_order + 1
     WHERE parent_id = 1
       AND sort_order >= 2
       AND is_deleted = 'n';

    INSERT INTO public.sys_menus (
        parent_id, menu_name, menu_code, menu_type,
        icon, path, component, sort_order, status, is_deleted
    )
    VALUES (
        1, '租户管理', 'tenant', 'C',
        'ApartmentOutlined', '/system/tenants', './pages/system/Tenants',
        2, '1', 'n'
    );

    RAISE NOTICE '已插入租户管理菜单（sort_order=2，排在用户管理之后）';
END;
$$;


-- ============================================================================
-- 2. 授权给 super_admin
--
--    只给超管。原因：deploy_41 给 sys_tenants 的写策略就是「仅 super_admin」，
--    把菜单开放给普通角色只会让他们点进去看到一堆禁用按钮。
--    如果以后要让别的角色也能看到（只读），把 role_code 换成对应值即可，
--    但请注意他们只能看到自己所属的那一条。
-- ============================================================================

DO $$
DECLARE
    v_menu_id BIGINT;
    v_role_id BIGINT;
BEGIN
    SELECT id INTO v_menu_id
      FROM public.sys_menus
     WHERE menu_code = 'tenant' AND is_deleted = 'n';

    SELECT id INTO v_role_id
      FROM public.sys_roles
     WHERE role_code = 'super_admin' AND is_deleted = 'n';

    IF v_menu_id IS NULL THEN
        RAISE WARNING '未找到租户管理菜单，跳过授权';
        RETURN;
    END IF;

    IF v_role_id IS NULL THEN
        RAISE WARNING '未找到 super_admin 角色，跳过授权';
        RETURN;
    END IF;

    INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted)
    SELECT v_role_id, v_menu_id, 'n'
     WHERE NOT EXISTS (
        SELECT 1 FROM public.sys_role_menus
         WHERE role_id = v_role_id AND menu_id = v_menu_id
     );

    RAISE NOTICE '已将租户管理菜单授权给 super_admin（role_id=%, menu_id=%）', v_role_id, v_menu_id;
END;
$$;


-- 刷新目录缓存，否则新菜单可能不会立刻出现在侧边栏
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'refresh_sys_tables'
    ) THEN
        PERFORM public.refresh_sys_tables();
        RAISE NOTICE '已调用 refresh_sys_tables()';
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 3. 验证
-- ============================================================================
--
--   SELECT id, menu_name, menu_code, path, component, sort_order
--   FROM public.sys_menus
--   WHERE menu_code = 'tenant' AND is_deleted = 'n';
--
--   SELECT r.role_code, m.menu_name
--   FROM public.sys_role_menus rm
--   JOIN public.sys_roles r ON r.id = rm.role_id
--   JOIN public.sys_menus  m ON m.id = rm.menu_id
--   WHERE m.menu_code = 'tenant' AND rm.is_deleted = 'n';
--
-- 验证通过后：用 super_admin 登录 → 系统管理 → 租户管理。
-- 普通管理员进去会看到只读提示（deploy_41 的 sys_tenants 策略决定的）。


-- ============================================================================
-- 4. 重要提醒：新租户是空的
-- ============================================================================
--
-- 新建出来的租户没有任何业务基础数据 —— 没有会计科目、没有仓库、
-- 没有单据编号规则，erp 表全是空的，开不了单。
--
-- 后台开通模式下这可以接受：管理员建好租户后，再手工配置基础数据。
-- 但如果要批量开通，就需要一套「租户初始化模板」，把 default 租户的
-- 科目体系 / 仓库 / 编号规则复制过去。那是独立的一块工作，本脚本不涉及。
