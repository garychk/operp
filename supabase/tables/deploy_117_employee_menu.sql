-- ============================================================================
-- deploy_117 —— 员工管理菜单注册（挂在 mrp 下，紧邻「部门管理」）
-- ============================================================================
--
-- 为什么需要这张菜单：
--   `erp_employees` 一直被「消费」但从来没地方「维护」——
--     · 生产订单 → 工序页签的**派工对象**（assignee_id）
--     · 生产报工 → **操作工**（operator_id）
--     · 仓库管理 → **负责人**（manager_id）
--   三个下拉都读它，页面里却没有入口、菜单里也没有入口，表本身还是空的
--   → 派工/报工的操作工下拉永远是空的。补上入口才能把这条链路走通。
--
-- 与 deploy_64/59/109 完全同构（单菜单版）。菜单类表走**模板可见性**
-- （template_scope_visible），已物化租户看不到基线菜单，必须三步：
--   1. 插基线行（NOT EXISTS 守卫 —— sys_menus 没有 (tenant_id, menu_code) 唯一索引，
--      不能写 ON CONFLICT）；
--   2. 补基线角色授权（super_admin + tenant_admin）；
--   3. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差。
--   漏第 3 步是静默的 → 第 5 步 fail-loud 自检。
--
-- 位置：主数据类页面应聚在 mrp 目录最上方（部门管理 sort_order=1 起）。
--       所以给本菜单取 **2**，并把原本占用 2..7 的
--       BOM管理/工艺路线/工作中心/工序管理/生产订单/领料单 整体右移一格
--       （8 与 9 为空位，右移后不与完工入库的 10 冲突）。
--       腾位动作**只在员工菜单尚未落位时执行一次**，否则重复执行会叠加。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================

-- 1. 基线腾位：mrp 下 sort_order 2..7 右移一格
DO $$
DECLARE
  v_parent INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sys_menus
    WHERE tenant_id IS NULL AND menu_code = 'mrp_employees'
      AND COALESCE(is_deleted, 'n') = 'n'
  ) THEN
    RAISE NOTICE 'deploy_117：员工菜单已存在，跳过基线腾位';
    RETURN;
  END IF;

  SELECT id INTO v_parent FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp'
    AND COALESCE(is_deleted, 'n') = 'n'
  LIMIT 1;

  IF v_parent IS NULL THEN
    RAISE EXCEPTION 'deploy_117：找不到 mrp 父菜单，无法注册员工管理';
  END IF;

  UPDATE public.sys_menus
  SET sort_order = sort_order + 1, updated_at = NOW()
  WHERE tenant_id IS NULL
    AND parent_id = v_parent
    AND COALESCE(is_deleted, 'n') = 'n'
    AND sort_order BETWEEN 2 AND 7;

  RAISE NOTICE 'deploy_117：基线 mrp 下 sort_order 2..7 已右移一格';
END;
$$;

-- 2. 基线菜单行
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
  '员工管理', 'mrp_employees', 'C', 'IdcardOutlined',
  '/mrp/employees', './pages/mrp/Employees', 2, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_employees'
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
  AND m.menu_code = 'mrp_employees'
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
    -- 租户自己还没有员工菜单副本 → 先把该租户的 2..7 右移一格
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus m
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_employees'
        AND COALESCE(m.is_deleted, 'n') = 'n'
    ) THEN
      SELECT id INTO v_parent FROM public.sys_menus
      WHERE tenant_id = v_tenant.id AND menu_code = 'mrp'
        AND COALESCE(is_deleted, 'n') = 'n'
      LIMIT 1;

      IF v_parent IS NOT NULL THEN
        UPDATE public.sys_menus
        SET sort_order = sort_order + 1, updated_at = NOW()
        WHERE tenant_id = v_tenant.id
          AND parent_id = v_parent
          AND COALESCE(is_deleted, 'n') = 'n'
          AND sort_order BETWEEN 2 AND 7;
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
  v_menu_id INTEGER;
  v_parent  INTEGER;
  v_sort    INTEGER;
  v_path    TEXT;
  v_comp    TEXT;
  v_icon    TEXT;
  v_dept    INTEGER;
  v_bom     INTEGER;
  v_grants  INTEGER;
  v_tenant  RECORD;
  v_t_sort  INTEGER;
  v_missing TEXT := '';
BEGIN
  SELECT id, parent_id, sort_order, path, component, icon
    INTO v_menu_id, v_parent, v_sort, v_path, v_comp, v_icon
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_employees'
    AND COALESCE(is_deleted, 'n') = 'n';

  IF v_menu_id IS NULL THEN
    RAISE EXCEPTION 'deploy_117：基线菜单未写入（mrp_employees）';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sys_menus p
    WHERE p.id = v_parent AND p.menu_code = 'mrp' AND p.tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION 'deploy_117：员工管理未挂在 mrp 下（parent_id=%）', v_parent;
  END IF;

  IF v_path <> '/mrp/employees'
     OR v_comp <> './pages/mrp/Employees'
     OR v_icon <> 'IdcardOutlined' THEN
    RAISE EXCEPTION 'deploy_117：菜单路径/组件/图标与前端路由不一致（path=%, component=%, icon=%）',
      v_path, v_comp, v_icon;
  END IF;

  -- 必须紧邻「部门管理」：部门 sort_order 更小，且下方仍存在更大的 sort_order
  SELECT sort_order INTO v_dept
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_departments'
    AND COALESCE(is_deleted, 'n') = 'n';
  IF v_dept IS NULL THEN
    RAISE EXCEPTION 'deploy_117：找不到「部门管理」菜单，无法校验相邻位置';
  END IF;
  IF v_dept >= v_sort THEN
    RAISE EXCEPTION 'deploy_117：员工管理(=%) 未排在部门管理(=%) 之后', v_sort, v_dept;
  END IF;

  SELECT min(sort_order) INTO v_bom
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND parent_id = v_parent
    AND COALESCE(is_deleted, 'n') = 'n'
    AND sort_order > v_sort;
  IF v_bom IS NULL OR v_bom <= v_sort THEN
    RAISE EXCEPTION 'deploy_117：员工管理不在主数据区段内（下方最小 sort_order=%）', v_bom;
  END IF;

  SELECT count(*) INTO v_grants
  FROM public.sys_role_menus rm
  JOIN public.sys_roles r ON r.id = rm.role_id
  WHERE rm.menu_id = v_menu_id AND rm.tenant_id IS NULL
    AND COALESCE(rm.is_deleted, 'n') = 'n'
    AND r.role_code IN ('super_admin', 'tenant_admin');
  IF v_grants < 2 THEN
    RAISE EXCEPTION 'deploy_117：基线角色授权不全（期望 super_admin + tenant_admin，实际 %）', v_grants;
  END IF;

  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    SELECT sort_order INTO v_t_sort
    FROM public.sys_menus m
    WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_employees'
      AND COALESCE(m.is_deleted, 'n') = 'n';

    IF v_t_sort IS NULL THEN
      v_missing := v_missing || format(' 租户%s缺菜单副本;', v_tenant.id);
      CONTINUE;
    END IF;
    IF v_t_sort <> v_sort THEN
      v_missing := v_missing || format(' 租户%s副本 sort_order=%s 与基线 %s 不一致;',
        v_tenant.id, v_t_sort, v_sort);
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
      JOIN public.sys_menus m ON m.id = rm.menu_id
      WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_employees'
        AND rm.tenant_id = v_tenant.id AND COALESCE(rm.is_deleted, 'n') = 'n'
        AND r.role_code IN ('super_admin', 'tenant_admin')
    ) THEN
      v_missing := v_missing || format(' 租户%s菜单副本缺角色授权;', v_tenant.id);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_117 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_117 OK：员工管理菜单已挂在 mrp 下 sort_order=%', v_sort;
END;
$$;
