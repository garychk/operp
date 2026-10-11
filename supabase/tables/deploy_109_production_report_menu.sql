-- ============================================================================
-- deploy_109 —— P0-5：生产报表菜单注册（挂在 mrp 下，排在最下方 sort_order=74）
-- ============================================================================
--
-- 与 deploy_64/59 完全同构（单菜单版）。菜单类表走**模板可见性**
-- （template_scope_visible），已物化租户看不到基线菜单，必须三步：
--   1. 插基线行（NOT EXISTS 守卫 —— sys_menus 没有 (tenant_id, menu_code) 唯一索引，
--      不能写 ON CONFLICT）；
--   2. 补基线角色授权（super_admin + tenant_admin）；
--   3. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差。
-- 漏第 3 步是静默的 → 第 4 步 fail-loud 自检。
--
-- 位置：用户要求「报表菜单放 mrp 目录里面的最下面」——
--       现有 mrp 子菜单最大 sort_order = 73（委外结算），本菜单取 74；
--       自检里断言「mrp 下没有比它更大的 sort_order」，防止被后人插队。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================

-- 1. 基线菜单行
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
  '生产报表', 'mrp_production-analytics', 'C', 'BarChartOutlined',
  '/mrp/production-analytics', './pages/mrp/ProductionAnalytics', 74, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_production-analytics'
);

-- 2. 基线角色授权
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'mrp_production-analytics'
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

-- 3. 给已物化租户补差
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

-- 4. 自检（fail-loud）
DO $$
DECLARE
  v_base_menu   INTEGER;
  v_base_grants INTEGER;
  v_parent      INTEGER;
  v_sort        INTEGER;
  v_larger      INTEGER;
  v_tenant      RECORD;
  v_missing     TEXT := '';
BEGIN
  SELECT id, parent_id, sort_order INTO v_base_menu, v_parent, v_sort
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_production-analytics'
    AND COALESCE(is_deleted, 'n') = 'n';
  IF v_base_menu IS NULL THEN
    RAISE EXCEPTION '基线菜单未写入：mrp_production-analytics';
  END IF;

  -- 父必须是 mrp
  IF NOT EXISTS (
    SELECT 1 FROM public.sys_menus p
    WHERE p.id = v_parent AND p.menu_code = 'mrp' AND p.tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION '生产报表菜单未挂在 mrp 下（parent_id=%）', v_parent;
  END IF;

  -- 必须排在 mrp 子菜单最下方
  SELECT count(*) INTO v_larger
  FROM public.sys_menus s
  WHERE s.parent_id = v_parent AND s.tenant_id IS NULL
    AND COALESCE(s.is_deleted, 'n') = 'n'
    AND s.sort_order > v_sort;
  IF v_larger > 0 THEN
    RAISE EXCEPTION '生产报表菜单不在 mrp 最下方（有 % 个子菜单 sort_order 更大）', v_larger;
  END IF;

  SELECT count(*) INTO v_base_grants
  FROM public.sys_role_menus rm
  JOIN public.sys_roles r ON r.id = rm.role_id
  WHERE rm.menu_id = v_base_menu AND rm.tenant_id IS NULL
    AND COALESCE(rm.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin');
  IF v_base_grants < 2 THEN
    RAISE EXCEPTION '生产报表菜单的基线角色授权不全（期望 super_admin + tenant_admin，实际 %）', v_base_grants;
  END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_production-analytics'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format(' 租户%s缺菜单副本;', v_tenant.id);
    ELSIF NOT EXISTS (
      SELECT 1
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
      JOIN public.sys_menus m ON m.id = rm.menu_id
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_production-analytics'
        AND rm.tenant_id = v_tenant.id AND COALESCE(rm.is_deleted, 'n') = 'n'
        AND r.role_code IN ('super_admin', 'tenant_admin')
    ) THEN
      v_missing := v_missing || format(' 租户%s菜单副本缺角色授权;', v_tenant.id);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_109 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_109 OK：生产报表菜单已挂在 mrp 最下方（sort_order=%）', v_sort;
END;
$$;
