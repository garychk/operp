-- ============================================================================
-- deploy_59: 完工入库菜单注册 + 各租户副本补差
-- ============================================================================
--
-- 为什么要单独一个脚本（不能只插一行 sys_menus）：
--
--   菜单类表走的是**模板可见性**，与 doc_flow_* 那类「数据/引擎表」不同：
--     sys_menus / sys_role_menus 的 RLS 用 template_scope_visible(tenant_id)，
--     而 template_scope_visible(NULL) = platform_baseline_visible()
--                                  = current_user_is_super_admin()
--                                    OR NOT 该租户.metadata_materialized
--
--   → **已物化租户（metadata_materialized = t）看不到基线菜单**，
--     必须有自己的副本行。所以新增菜单要做三件事：
--       1. 插基线行（供未物化租户与平台自己用）；
--       2. 补基线角色授权（super_admin + tenant_admin，与 deploy_50 的模板一致）；
--       3. 给每个已物化租户**补差**：调 clone_platform_baseline_to_tenant(..., FALSE, TRUE)。
--          该函数按 menu_code 幂等、p_overwrite=FALSE 只补缺失，
--          正是 deploy_52 文档里写的「平台新增菜单后给老租户补差」用法。
--
--   漏掉第 3 步的后果是**静默的**：平台自己看得见菜单，存量租户看不见，
--   而且没有任何报错。
--
-- 幂等性：
--   ⚠️ sys_menus **没有** (tenant_id, menu_code) 唯一索引（只有 id 主键），
--   所以基线行必须用 NOT EXISTS 守卫，不能写 ON CONFLICT。
--   sys_role_menus 有 UNIQUE(role_id, menu_id)，但这里同样用 NOT EXISTS 以保持风格一致。
--
-- 依赖：deploy_01（sys_menus 种子）、deploy_50（租户注册与角色模板）、
--       deploy_52（clone_platform_baseline_to_tenant 与模板可见性函数）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 基线菜单行
--    父菜单取基线里的 mrp 分组；取不到时退到 0（根），否则菜单树拼不起来。
-- ----------------------------------------------------------------------------
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'mrp'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  '完工入库', 'mrp_production-receipts', 'C', 'ImportOutlined',
  '/mrp/production-receipts', './pages/mrp/ProductionReceipts', 10, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_production-receipts'
);


-- ----------------------------------------------------------------------------
-- 2. 基线角色授权
--    super_admin：超管本就该有全部授权
--    tenant_admin：deploy_50 以 super_admin 为模板授 tenant_admin（只排除 /system/tenants），
--                  这里同步补上，保证**将来新建的租户**通过 clone 也能拿到这个菜单。
-- ----------------------------------------------------------------------------
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'mrp_production-receipts'
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );


-- ----------------------------------------------------------------------------
-- 3. 给已物化租户补差
--    只对 metadata_materialized = TRUE 的租户做：未物化租户直接读基线，本来就能看到。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;


-- ----------------------------------------------------------------------------
-- 4. 自检：基线行 + 基线授权 + 每个已物化租户的副本与授权都要齐
--    这一步刻意 fail-loud —— 「菜单没补上」在界面上只表现为菜单消失，
--    没有任何报错，所以必须在脚本里挡住。
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  v_base_menu INTEGER;
  v_base_grants INTEGER;
  v_tenant RECORD;
  v_missing TEXT := '';
BEGIN
  SELECT id INTO v_base_menu FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_production-receipts'
    AND COALESCE(is_deleted, 'n') = 'n';
  IF v_base_menu IS NULL THEN
    RAISE EXCEPTION '完工入库基线菜单未写入';
  END IF;

  SELECT count(*) INTO v_base_grants
  FROM public.sys_role_menus rm
  JOIN public.sys_roles r ON r.id = rm.role_id
  WHERE rm.menu_id = v_base_menu AND rm.tenant_id IS NULL
    AND COALESCE(rm.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin');
  IF v_base_grants < 2 THEN
    RAISE EXCEPTION '基线角色授权不全（期望 super_admin + tenant_admin，实际 %）', v_base_grants;
  END IF;

  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_production-receipts'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format(' 租户%s无菜单副本;', v_tenant.id);
    ELSIF NOT EXISTS (
      SELECT 1
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
      JOIN public.sys_menus m ON m.id = rm.menu_id
      WHERE r.tenant_id = v_tenant.id AND r.role_code = 'tenant_admin'
        AND m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_production-receipts'
        AND COALESCE(rm.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format(' 租户%s的tenant_admin无授权;', v_tenant.id);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION '租户菜单补差不完整：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_59 OK：基线菜单 id=%，基线授权 % 条，已物化租户副本齐备', v_base_menu, v_base_grants;
END;
$$;
