-- ============================================================================
-- deploy_118 —— 员工「岗位」字典（sys_dict_types.code = 'Jobs'）
-- ============================================================================
--
-- 为什么需要：
--   员工管理页面的「岗位」由手输文本框改为字典选择（<DictSelect dictType="Jobs" />），
--   但全库字典表是空的 —— sys_dict_types / sys_dict_items 目前都是 0 行。
--   不建这本字典，岗位下拉就是恒空的（与历史上 dictType="uom" 是同一个坑：
--   引用了一本不存在的字典，界面上只能手输）。
--   本脚本补上字典类型 + 一组常见岗位作为**初始值**，管理员可随时在
--   「系统 → 数据字典」里增删改。
--
-- 可见性（关键）：
--   字典表在 deploy_52 第 7 节被换成**模板可见性**（install_template_scope）：
--     · 未物化租户（metadata_materialized = FALSE，如 id=1）→ 看基线行（tenant_id IS NULL）；
--     · 已物化租户（如 id=3 operp）      → **看不到基线**，必须有自己的租户副本。
--   所以必须三步；漏掉第 2 步对已物化租户是静默的（下拉恒空）→ 第 3 步 fail-loud 自检。
--     1. 插基线行；
--     2. 遍历已物化租户调 clone_platform_baseline_to_tenant(id, FALSE, TRUE) 补差；
--     3. 自检。
--
-- 幂等：
--   类型按 uq_sys_dict_types_code_global（(code) WHERE tenant_id IS NULL）守卫，
--   项按 sys_dict_items 的 (type_id, code) 唯一键守卫；守卫一律写 NOT EXISTS
--   （部分唯一索引的 ON CONFLICT 推断不直观，且 sys_dict_types 没有可 ON CONFLICT 的命名约束）。
--   重复执行不产生重复行、不覆盖管理员已经改过的 label/sort_order。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================

-- 1. 基线字典类型
INSERT INTO public.sys_dict_types (
  code, name, description, sort_order, status, is_deleted, tenant_id
)
SELECT
  'Jobs', '岗位',
  '员工主数据的岗位来源（员工管理 → 岗位下拉）',
  10, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_dict_types t
  WHERE t.code = 'Jobs' AND t.tenant_id IS NULL
);

-- 2. 基线字典项（初始岗位清单）
INSERT INTO public.sys_dict_items (
  type_id, code, label, description, sort_order, status, is_deleted, tenant_id
)
SELECT
  dt.id, v.code, v.label, NULL, v.sort_order, '1', 'n', NULL
FROM public.sys_dict_types dt
CROSS JOIN (
  VALUES
    ('GM',               '总经理',      10),
    ('PROD_MGR',         '生产经理',    20),
    ('PROD_PLANNER',     '生产计划员',  30),
    ('SUPERVISOR',       '班组长',      40),
    ('OPERATOR',         '操作工',      50),
    ('FITTER',           '装配工',      60),
    ('WELDER',           '焊工',        70),
    ('CNC_OPERATOR',     '数控操作工',  80),
    ('QC_INSPECTOR',     '质检员',      90),
    ('EQUIP_MAINT',      '设备维修工',  100),
    ('WAREHOUSE_KEEPER', '仓管员',      110),
    ('PURCHASER',        '采购员',      120),
    ('SALES',            '销售员',      130),
    ('ACCOUNTANT',       '会计',        140),
    ('HR',               '人事专员',    150),
    ('IT_ADMIN',         '信息管理员',  160),
    ('RND_ENGINEER',     '研发工程师',  170),
    ('DRIVER',           '司机',        180)
) AS v(code, label, sort_order)
WHERE dt.code = 'Jobs'
  AND dt.tenant_id IS NULL
  AND COALESCE(dt.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_dict_items i
    WHERE i.type_id = dt.id AND i.code = v.code
  );

-- 3. 已物化租户补差（它们看不到基线字典，必须有租户副本）
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
  RAISE NOTICE '已给 % 个已物化租户补差（含 Jobs 字典）', v_count;
END;
$$;

-- 4. 自检（fail-loud）
DO $$
DECLARE
  v_type_id   INTEGER;
  v_items     INTEGER;
  v_status    TEXT;
  v_tenant    RECORD;
  v_t_type    INTEGER;
  v_t_items   INTEGER;
  v_t_status  TEXT;
  v_missing   TEXT := '';
BEGIN
  SELECT id, status INTO v_type_id, v_status
  FROM public.sys_dict_types
  WHERE code = 'Jobs' AND tenant_id IS NULL
    AND COALESCE(is_deleted, 'n') = 'n';

  IF v_type_id IS NULL THEN
    RAISE EXCEPTION 'deploy_118：基线字典类型 Jobs 未写入';
  END IF;

  IF v_status <> '1' THEN
    RAISE EXCEPTION 'deploy_118：基线字典类型 Jobs 未启用（status=%）', v_status;
  END IF;

  SELECT count(*) INTO v_items
  FROM public.sys_dict_items
  WHERE type_id = v_type_id AND tenant_id IS NULL
    AND COALESCE(is_deleted, 'n') = 'n' AND status = '1';

  IF v_items < 10 THEN
    RAISE EXCEPTION 'deploy_118：基线岗位字典项过少（实际 %）', v_items;
  END IF;

  -- 已物化租户必须有等量副本，否则该租户的岗位下拉是空的
  FOR v_tenant IN
    SELECT t.id, t.code FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    SELECT d.id, d.status INTO v_t_type, v_t_status
    FROM public.sys_dict_types d
    WHERE d.tenant_id = v_tenant.id AND d.code = 'Jobs'
      AND COALESCE(d.is_deleted, 'n') = 'n';

    IF v_t_type IS NULL THEN
      v_missing := v_missing || format(' 租户%s(%)缺 Jobs 字典副本;', v_tenant.id, v_tenant.code);
      CONTINUE;
    END IF;

    IF v_t_status <> '1' THEN
      v_missing := v_missing || format(' 租户%s的 Jobs 副本未启用;', v_tenant.id);
    END IF;

    SELECT count(*) INTO v_t_items
    FROM public.sys_dict_items i
    WHERE i.type_id = v_t_type AND i.tenant_id = v_tenant.id
      AND COALESCE(i.is_deleted, 'n') = 'n' AND i.status = '1';

    IF v_t_items <> v_items THEN
      v_missing := v_missing || format(' 租户%s岗位项数(%s)与基线(%s)不一致;',
        v_tenant.id, v_t_items, v_items);
    END IF;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_118 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_118 OK：Jobs 字典基线 % 项，已物化租户副本齐备', v_items;
END;
$$;
