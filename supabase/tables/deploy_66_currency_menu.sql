-- ============================================================================
-- 多币别改造 · 第 1 期 —— 币别管理菜单注册 + 各租户副本补差（deploy_66）
-- ============================================================================
--
-- 与 deploy_59/62/64 完全同构（单菜单版）。菜单类表走**模板可见性**
-- （template_scope_visible），已物化租户看不到基线菜单，必须三步：
--   1. 插基线行（NOT EXISTS 守卫 —— sys_menus 没有 (tenant_id, menu_code) 唯一索引，
--      不能写 ON CONFLICT）；
--   2. 补基线角色授权（super_admin + tenant_admin + finance_manager）；
--   3. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差。
-- 漏第 3 步是静默的 → 第 4 步 fail-loud 自检。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_65（币别/汇率表与表权限基线）、deploy_52（clone 函数）。
-- ============================================================================

-- 1. 基线菜单行（挂 系统管理 /system 下，紧随计量单位 sort_order 65）
INSERT INTO public.sys_menus (
  corp_id, emp_id, parent_id, menu_name, menu_code, menu_type, icon,
  path, component, sort_order, status, is_deleted, tenant_id
)
SELECT
  NULL, NULL,
  COALESCE((
    SELECT p.id FROM public.sys_menus p
    WHERE p.tenant_id IS NULL AND p.menu_code = 'system'
      AND COALESCE(p.is_deleted, 'n') = 'n'
    LIMIT 1
  ), 0),
  '币别管理', 'currencies', 'C', 'DollarOutlined',
  '/system/currencies', './pages/system/Currencies', 66, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'currencies'
);

-- 2. 基线角色授权
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager')
  AND m.tenant_id IS NULL
  AND m.menu_code = 'currencies'
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

-- 4. 自检
DO $$
DECLARE
  v_base_menu INTEGER;
  v_base_grants INTEGER;
  v_tenant RECORD;
  v_missing TEXT := '';
BEGIN
  SELECT id INTO v_base_menu FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'currencies'
    AND COALESCE(is_deleted, 'n') = 'n';
  IF v_base_menu IS NULL THEN
    RAISE EXCEPTION '基线菜单未写入：currencies';
  END IF;

  SELECT count(*) INTO v_base_grants
  FROM public.sys_role_menus rm
  JOIN public.sys_roles r ON r.id = rm.role_id
  WHERE rm.menu_id = v_base_menu AND rm.tenant_id IS NULL
    AND COALESCE(rm.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin', 'finance_manager');
  IF v_base_grants < 3 THEN
    RAISE EXCEPTION 'currencies 的基线角色授权不全（期望 super_admin + tenant_admin + finance_manager，实际 %）',
      v_base_grants;
  END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'currencies'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format(' 租户%s缺菜单副本;', v_tenant.id);
    ELSIF NOT EXISTS (
      SELECT 1
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
      JOIN public.sys_menus m ON m.id = rm.menu_id
      WHERE r.tenant_id = v_tenant.id AND r.role_code = 'tenant_admin'
        AND m.tenant_id = v_tenant.id AND m.menu_code = 'currencies'
        AND COALESCE(rm.is_deleted, 'n') = 'n'
    ) THEN
      v_missing := v_missing || format(' 租户%s的tenant_admin无菜单授权;', v_tenant.id);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION '租户菜单补差不完整：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_66 OK：币别管理菜单基线与租户副本齐备';
END;
$$;
