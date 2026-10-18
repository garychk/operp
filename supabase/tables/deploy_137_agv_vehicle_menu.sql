-- ============================================================================
-- deploy_137 —— AGV小车 / 货车 两个主数据菜单注册（挂在 mrp 下，紧邻「员工管理」）
-- ============================================================================
--
-- 为什么需要这两张菜单：
--   deploy_136 新增了 `erp_agvs` / `erp_vehicles` 两张主数据表，作为 3D 驾驶舱
--   「AGV 小车」「货车」场景对象的绑定源。表建好了但系统里没有维护入口，
--   菜单里也没有 —— 绑定下拉永远是空的。本脚本补上入口，把链路走通。
--
-- 与 deploy_117 完全同构（单菜单版升级为双菜单版）。菜单类表走**模板可见性**
-- （template_scope_visible），已物化租户看不到基线菜单，必须三步：
--   1. 插基线行（NOT EXISTS 守卫 —— sys_menus 没有 (tenant_id, menu_code) 唯一索引）；
--   2. 补基线角色授权（super_admin + tenant_admin）；
--   3. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差。
--   漏第 3 步是静默的 → 第 5 步 fail-loud 自检。
--
-- 位置：主数据类页面聚在 mrp 目录最上方。员工管理占 sort_order=2，
--       所以给 AGV 取 3、货车取 4，并把原本占用 3..7 的
--       BOM/工艺路线/工作中心/工序/生产订单 整体右移两格（8 与 9 为空位）。
--       腾位动作**只在两菜单尚未落位时执行一次**，否则重复执行会叠加。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================

-- 1. 基线腾位：mrp 下 sort_order 3..7 右移两格
DO $$
DECLARE
  v_parent INTEGER;
  v_missing BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.sys_menus
    WHERE tenant_id IS NULL
      AND menu_code IN ('mrp_agvs', 'mrp_vehicles')
      AND COALESCE(is_deleted, 'n') = 'n'
  ) INTO v_missing;

  IF v_missing THEN
    RAISE NOTICE 'deploy_137：AGV/货车菜单已存在，跳过基线腾位';
    RETURN;
  END IF;

  SELECT id INTO v_parent FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp'
    AND COALESCE(is_deleted, 'n') = 'n'
  LIMIT 1;

  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'deploy_137：找不到 mrp 父菜单，无法注册 AGV/货车';
  END IF;

  UPDATE public.sys_menus
  SET sort_order = sort_order + 2, updated_at = NOW()
  WHERE tenant_id IS NULL
    AND parent_id = v_parent
    AND COALESCE(is_deleted, 'n') = 'n'
    AND sort_order BETWEEN 3 AND 7;

  RAISE NOTICE 'deploy_137：基线 mrp 下 sort_order 3..7 已右移两格';
END;
$$;

-- 2. 基线菜单行（AGV + 货车）
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
  v.menu_name, v.menu_code, 'C', v.icon,
  v.path, v.component, v.sort_order, '1', 'n', NULL
FROM (VALUES
  ('AGV小车', 'mrp_agvs',     'RobotOutlined', '/mrp/agvs',     './pages/mrp/Agvs',     3),
  ('货车管理', 'mrp_vehicles', 'TruckOutlined', '/mrp/vehicles', './pages/mrp/Vehicles', 4)
) AS v(menu_name, menu_code, icon, path, component, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = v.menu_code
);

-- 3. 基线角色授权
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND m.tenant_id IS NULL
  AND m.menu_code IN ('mrp_agvs', 'mrp_vehicles')
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

-- 4. 已物化租户：先腾位、再补差
DO $$
DECLARE
  v_tenant  RECORD;
  v_parent  INTEGER;
  v_result  JSONB;
  v_count   INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id, t.code
    FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    -- 租户还没有任一菜单副本 → 先把该租户的 3..7 右移两格
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id
        AND m.menu_code IN ('mrp_agvs', 'mrp_vehicles')
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      SELECT id INTO v_parent FROM public.sys_menus
      WHERE tenant_id = v_tenant.id AND menu_code = 'mrp'
        AND COALESCE(is_deleted, 'n') = 'n'
      LIMIT 1;

      IF v_parent IS NOT NULL THEN
        UPDATE public.sys_menus
        SET sort_order = sort_order + 2, updated_at = NOW()
        WHERE tenant_id = v_tenant.id
          AND parent_id = v_parent
          AND COALESCE(is_deleted, 'n') = 'n'
          AND sort_order BETWEEN 3 AND 7;
      END IF;
    END IF;

    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    RAISE NOTICE '租户 % (%) 元数据补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差', v_count;
END;
$$;

-- 5. 自检（fail-loud）
DO $$
DECLARE
  v_agv_id  INTEGER;
  v_veh_id  INTEGER;
  v_parent  INTEGER;
  v_sort    INTEGER;
  v_path    TEXT;
  v_comp    TEXT;
  v_icon    TEXT;
  v_emp     INTEGER;
  v_grants  INTEGER;
  v_tenant  RECORD;
  v_t_sort  INTEGER;
  v_missing TEXT := '';
BEGIN
  SELECT id, sort_order INTO v_agv_id, v_sort
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_agvs'
    AND COALESCE(is_deleted, 'n') = 'n';
  SELECT id, sort_order INTO v_veh_id, v_t_sort
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_vehicles'
    AND COALESCE(is_deleted, 'n') = 'n';

  IF v_agv_id IS NULL OR v_veh_id IS NULL THEN
    RAISE EXCEPTION 'deploy_137：基线菜单未写入（agv=% / vehicles=%）',
      v_agv_id, v_veh_id;
  END IF;

  -- AGV 路径/组件/图标
  SELECT path, component, icon, parent_id INTO v_path, v_comp, v_icon, v_parent
  FROM public.sys_menus WHERE id = v_agv_id;
  IF v_path <> '/mrp/agvs' OR v_comp <> './pages/mrp/Agvs' OR v_icon <> 'RobotOutlined' THEN
    RAISE EXCEPTION 'deploy_137：AGV 菜单路径/组件/图标不一致（path=%, component=%, icon=%）',
      v_path, v_comp, v_icon;
  END IF;

  -- 货车路径/组件/图标
  SELECT path, component, icon INTO v_path, v_comp, v_icon
  FROM public.sys_menus WHERE id = v_veh_id;
  IF v_path <> '/mrp/vehicles' OR v_comp <> './pages/mrp/Vehicles' OR v_icon <> 'TruckOutlined' THEN
    RAISE EXCEPTION 'deploy_137：货车菜单路径/组件/图标不一致（path=%, component=%, icon=%）',
      v_path, v_comp, v_icon;
  END IF;

  -- 必须紧邻「员工管理」之后
  SELECT sort_order INTO v_emp
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_employees'
    AND COALESCE(is_deleted, 'n') = 'n';
  IF v_emp IS NULL THEN
    RAISE EXCEPTION 'deploy_137：找不到「员工管理」菜单，无法校验相邻位置';
  END IF;
  IF v_emp >= v_sort THEN
    RAISE EXCEPTION 'deploy_137：AGV(=%) 未排在员工管理(=%) 之后', v_sort, v_emp;
  END IF;
  IF v_sort >= v_t_sort THEN
    RAISE EXCEPTION 'deploy_137：货车(=%) 未排在 AGV(=%) 之后', v_t_sort, v_sort;
  END IF;

  -- 基线角色授权
  SELECT count(*) INTO v_grants
  FROM public.sys_role_menus rm
  JOIN public.sys_roles r ON r.id = rm.role_id
  WHERE rm.menu_id IN (v_agv_id, v_veh_id) AND rm.tenant_id IS NULL
    AND COALESCE(rm.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin');
  IF v_grants < 4 THEN
    RAISE EXCEPTION 'deploy_137：基线角色授权不全（期望两菜单 × 两角色 = 4，实际 %）', v_grants;
  END IF;

  -- 已物化租户副本
  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    SELECT sort_order INTO v_t_sort
    FROM public.sys_menus m
    WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_agvs'
      AND COALESCE(m.is_deleted, 'n') = 'n';
    IF v_t_sort IS NULL THEN
      v_missing := v_missing || format(' 租户%s缺AGV菜单副本;', v_tenant.id);
    ELSIF v_t_sort <> v_sort THEN
      v_missing := v_missing || format(' 租户%s AGV副本 sort_order=%s 与基线 %s 不一致;',
        v_tenant.id, v_t_sort, v_sort);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_137 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_137 OK：AGV/货车菜单已挂在 mrp 下（sort_order=% 与 %）', v_sort, v_t_sort;
END;
$$;
