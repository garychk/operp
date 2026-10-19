-- ============================================================================
-- deploy_135 —— 3D 工厂数字驾驶舱（factory-3d 组件数据源）
-- ============================================================================
--
-- ⚠️ 本文件是**可选增强件**，未登记进 000_run_all_* 执行清单：
--    ERP 主线不依赖它，需要 3D 驾驶舱时手动单独执行（幂等，可重复跑）：
--      node ./scripts/verify/run-migration.cjs supabase/tables/deploy_135_factory_3d_dashboard.sql
--    不想要时直接 DROP 视图 + 表即可，对现有业务零影响。
--
-- 为前端 3D 工厂组件（React + three.js，组件库 factory-3d）提供数据底座。
-- 全部读现有表，不新建业务语义，只补两类东西：
--
--   1. factory_3d_device_layout —— 设备（工作中心）在 3D 场景中的坐标。
--      这是纯展示配置，3D 布局信息在既有任何表中都不存在，只能新落一张表。
--      一行 = 一个工作中心在车间平面图上的位置（scene_x / scene_z）。
--
--   2. 四个 security_invoker 视图（不提升权限，走底层 erp_* 的租户 RLS）：
--      · vw_factory_3d_devices          设备视图：坐标 + 当班工单/工序 + 运行状态
--      · vw_factory_3d_orders           在制工单视图：进度 + 物料齐套汇总
--      · vw_factory_3d_order_operations 工序明细视图：活儿跑到哪一道
--      · vw_factory_3d_order_materials  材料明细视图：BOM 展开后的材料行（领料/需求）
--
-- 状态推导口径（不引入人工维护的状态字段，全部从业务事实推导）：
--   · 设备 running   = 该工作中心上存在「已指派到本工作中心且订单已 in_progress」的工序
--                     （开工 = 订单头 in_progress，工序可能仍 pending，故按订单头判定，
--                       与「开工」动作对齐，避免开工后设备仍显示待机）
--   · 设备 idle      = 工作中心 active 但当前无在制订单工序
--   · 设备 offline   = 工作中心非 active
--   · 物料齐套       = 工单材料行 issued_quantity >= planned_quantity
--     （口径与 erp_production_order_details 一致：领料过账回写 issued_quantity）
--
-- 依赖：deploy_01（erp_work_centers / erp_production_orders / erp_products）、
--       deploy_108（vw_erp_production_progress 的完工口径复用同一套 join）、
--       deploy_115（erp_production_order_operations）、
--       deploy_41（install_role_table_rls）、deploy_52（clone_platform_baseline_to_tenant）。
-- ============================================================================


-- ============================================================================
-- 1. 设备 3D 布局表（纯展示配置）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.factory_3d_device_layout_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    work_center_id INTEGER NOT NULL REFERENCES public.erp_work_centers_s_539dcf81_b(id),
    -- 车间平面坐标（米），原点在车间中心，x 向右 / z 向下（three.js 惯例）
    scene_x NUMERIC(10,3) NOT NULL DEFAULT 0,
    scene_z NUMERIC(10,3) NOT NULL DEFAULT 0,
    -- 3D 场景显示名，空则回退工作中心 name
    label VARCHAR(100),
    remark TEXT,
    tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
    CONSTRAINT fk_factory_3d_layout_work_center_tenant
      FOREIGN KEY (work_center_id, tenant_id)
      REFERENCES public.erp_work_centers_s_539dcf81_b (id, tenant_id) ON DELETE CASCADE
);

-- 工作中心 (id, tenant_id) 复合外键目标（deploy_115 已给工单建过同款索引）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_centers_id_tenant
  ON public.erp_work_centers_s_539dcf81_b (id, tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_3d_layout_wc
  ON public.factory_3d_device_layout_s_539dcf81_b (tenant_id, work_center_id)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_factory_3d_layout_tenant
  ON public.factory_3d_device_layout_s_539dcf81_b (tenant_id)
  WHERE is_deleted = 'n';

-- owner 接管守卫：若表先前被其它角色建过（如 supabase_admin），先尝试接管，
-- 无权接管时给出可执行的补救指引，而不是让 install_role_table_rls 裸报 42501
DO $$
DECLARE
  v_owner TEXT;
BEGIN
  SELECT tableowner INTO v_owner FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename  = 'factory_3d_device_layout_s_539dcf81_b';
  IF v_owner IS NOT NULL AND v_owner <> current_user THEN
    BEGIN
      EXECUTE format('ALTER TABLE public.factory_3d_device_layout_s_539dcf81_b OWNER TO %I', current_user);
      RAISE NOTICE '已将 factory_3d_device_layout 的 owner 从 % 接管为 %', v_owner, current_user;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        '表 factory_3d_device_layout 的 owner 是 %，当前角色 % 无权接管。请先用 owner 会话（如建表的那个工具/角色）执行一次本文件，或由其执行：ALTER TABLE public.factory_3d_device_layout_s_539dcf81_b OWNER TO %I;',
        v_owner, current_user, current_user;
    END;
  END IF;
END
$$;

-- 权限与 RLS（fail-closed，与其余 erp_* 一致）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.factory_3d_device_layout_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.factory_3d_device_layout_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('factory_3d_device_layout_s_539dcf81_b');
SELECT public.refresh_sys_tables();

-- 基线角色授权：布局属管理配置，只给超管/租户管理员
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND t.table_name = 'factory_3d_device_layout_s_539dcf81_b'
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 给已物化租户补差
DO $$
DECLARE
  v_tenant RECORD;
  v_result JSONB;
  v_count  INTEGER := 0;
BEGIN
  FOR v_tenant IN
    SELECT t.id FROM public.sys_tenants t
    WHERE COALESCE(t.is_deleted, 'n') = 'n'
      AND COALESCE(t.metadata_materialized, FALSE)
    ORDER BY t.id
  LOOP
    v_result := public.clone_platform_baseline_to_tenant(v_tenant.id, FALSE, TRUE);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补差 factory_3d_device_layout 权限', v_count;
END;
$$;


-- ============================================================================
-- 2. 设备视图（3D 场景的主数据源）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_devices
  WITH (security_invoker = true) AS
SELECT
  wc.tenant_id,
  wc.id                            AS device_id,
  wc.code                          AS device_code,
  COALESCE(l.label, wc.name)       AS device_name,
  wc.type                          AS device_type,
  wc.capacity_per_day,
  wc.status                        AS wc_status,
  -- 推导状态：running / idle / offline（口径见文件头）
  -- running = 存在「已指派到本工作中心且订单已 in_progress」的工序
  CASE
    WHEN COALESCE(wc.status, 'active') <> 'active' THEN 'offline'
    WHEN cur.order_id IS NOT NULL                  THEN 'running'
    ELSE 'idle'
  END                              AS scene_status,
  -- 当班信息（取最新一道已指派到本工作中心、且订单 in_progress 的工序所在工单）
  cur.order_id                     AS current_order_id,
  cur.order_no                     AS current_order_no,
  cur.product_name                 AS current_product_name,
  cur.operation_name               AS current_operation_name,
  cur.op_line_no                   AS current_op_line_no,
  cur.op_completed                 AS current_op_completed,
  cur.op_planned                   AS current_op_planned,
  -- 3D 坐标（未配置布局的设备为 NULL，前端按行序自动排布兜底）
  l.scene_x::float8                AS scene_x,
  l.scene_z::float8                AS scene_z
FROM public.erp_work_centers_s_539dcf81_b wc
LEFT JOIN public.factory_3d_device_layout_s_539dcf81_b l
       ON l.work_center_id = wc.id AND l.tenant_id = wc.tenant_id
      AND COALESCE(l.is_deleted, 'n') = 'n'
LEFT JOIN LATERAL (
  SELECT o.id            AS order_id,
         o.order_no,
         pr.name         AS product_name,
         op.name         AS operation_name,
         oo.line_no      AS op_line_no,
         oo.completed_quantity AS op_completed,
         oo.planned_quantity   AS op_planned
    FROM public.erp_production_order_operations_s_539dcf81_b oo
    JOIN public.erp_production_orders_s_539dcf81_b o
      ON o.id = oo.order_id AND o.tenant_id = oo.tenant_id
    LEFT JOIN public.erp_products_s_539dcf81_b pr
      ON pr.id = o.product_id
    LEFT JOIN public.erp_operations_s_539dcf81_b op
      ON op.id = oo.operation_id
   WHERE oo.work_center_id = wc.id
     AND COALESCE(oo.is_deleted, 'n') = 'n'
     AND COALESCE(o.is_deleted, 'n') = 'n'
     AND o.status = 'in_progress'
   -- 当班工单优先级：有 in_progress 工序的 > 无的；再按订单实际开工日取最新；
   -- line_no/id 兜底保证排序确定性（line_no 相同时 LIMIT 1 不漂移）
   ORDER BY (oo.status = 'in_progress') DESC,
            o.actual_start_date DESC NULLS LAST,
            oo.line_no, oo.id
   LIMIT 1
) cur ON COALESCE(wc.status, 'active') = 'active'
WHERE COALESCE(wc.is_deleted, 'n') = 'n';


-- ============================================================================
-- 3. 在制工单视图（订单进度 + 物料齐套汇总）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_orders
  WITH (security_invoker = true) AS
SELECT
  p.tenant_id,
  p.order_id,
  p.order_no,
  p.status,
  p.priority,
  p.product_id,
  p.product_code,
  p.product_name,
  p.unit,
  p.planned_quantity,
  p.received_quantity,
  p.remaining_quantity,
  p.progress_pct,
  p.delay_days,
  p.planned_start_date,
  p.planned_end_date,
  -- 工序口径进度（报工驱动，deploy_115）
  o.operation_progress_percent,
  -- 物料齐套汇总（口径：工单材料行 issued >= planned 即齐套）
  COALESCE(mat.line_total, 0)     AS material_line_total,
  COALESCE(mat.line_ready, 0)     AS material_line_ready,
  COALESCE(mat.line_total, 0) - COALESCE(mat.line_ready, 0) AS material_line_short,
  CASE WHEN COALESCE(mat.line_total, 0) > 0
            AND mat.line_ready >= mat.line_total THEN 'ready'
       WHEN COALESCE(mat.line_total, 0) > 0 THEN 'short'
       ELSE 'none'
  END                             AS material_kit_status
FROM public.vw_erp_production_progress p
JOIN public.erp_production_orders_s_539dcf81_b o
  ON o.id = p.order_id AND o.tenant_id = p.tenant_id
LEFT JOIN LATERAL (
  SELECT COUNT(*)::int                                        AS line_total,
         COUNT(*) FILTER (WHERE d.issued_quantity >= d.planned_quantity
                             AND COALESCE(d.planned_quantity, 0) > 0)::int AS line_ready
    FROM public.erp_production_order_details_s_539dcf81_b d
   WHERE d.order_id = p.order_id
     AND d.tenant_id = p.tenant_id
     AND COALESCE(d.is_deleted, 'n') = 'n'
) mat ON TRUE
WHERE p.status IN ('released', 'in_progress')
  AND COALESCE(o.is_deleted, 'n') = 'n';


-- ============================================================================
-- 4. 工序明细视图（订单点开后的工序进度条数据源）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_order_operations
  WITH (security_invoker = true) AS
SELECT
  oo.tenant_id,
  o.id            AS order_id,
  o.order_no,
  oo.id           AS order_operation_id,
  oo.line_no,
  oo.sequence_no,
  op.name         AS operation_name,
  wc.id           AS work_center_id,
  wc.name         AS work_center_name,
  emp.name        AS assignee_name,
  oo.planned_quantity,
  oo.completed_quantity,
  oo.scrapped_quantity,
  oo.status       AS operation_status,
  oo.plan_start_date,
  oo.plan_end_date,
  oo.actual_start_date,
  oo.actual_end_date
FROM public.erp_production_order_operations_s_539dcf81_b oo
JOIN public.erp_production_orders_s_539dcf81_b o
  ON o.id = oo.order_id AND o.tenant_id = oo.tenant_id
LEFT JOIN public.erp_operations_s_539dcf81_b op
  ON op.id = oo.operation_id
LEFT JOIN public.erp_work_centers_s_539dcf81_b wc
  ON wc.id = oo.work_center_id
LEFT JOIN public.erp_employees_s_539dcf81_b emp
  ON emp.id = oo.assignee_id
WHERE COALESCE(oo.is_deleted, 'n') = 'n'
  AND COALESCE(o.is_deleted, 'n') = 'n'
  AND o.status IN ('released', 'in_progress');


-- ============================================================================
-- 4a. 工作中心当班订单视图（设备详情面板「当班任务」列表数据源）
--     口径：按「工序的 work_center_id」匹配 —— 只要某道工序绑定了该工作中心、
--           且订单已 in_progress，这张订单就算该工作中心的当班任务，
--           **不看订单头的 work_center_id**（订单头可能为空或指向别处）。
--     一个工作中心 → 多行（每行一张在制订单，订单去重）。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_work_center_orders
  WITH (security_invoker = true) AS
SELECT DISTINCT ON (oo.work_center_id, o.id)
  oo.work_center_id,
  o.tenant_id,
  o.id                          AS order_id,
  o.order_no,
  pr.name                       AS product_name,
  o.planned_quantity,
  o.operation_progress_percent,
  o.actual_start_date,
  -- 该订单在这个工作中心上的工序数 / 在制工序数
  COUNT(*) OVER (PARTITION BY oo.work_center_id, o.id)::int               AS wc_op_total,
  COUNT(*) FILTER (WHERE oo.status = 'in_progress')
        OVER (PARTITION BY oo.work_center_id, o.id)::int                  AS wc_op_in_progress
FROM public.erp_production_order_operations_s_539dcf81_b oo
JOIN public.erp_production_orders_s_539dcf81_b o
  ON o.id = oo.order_id AND o.tenant_id = oo.tenant_id
LEFT JOIN public.erp_products_s_539dcf81_b pr
  ON pr.id = o.product_id
WHERE COALESCE(oo.is_deleted, 'n') = 'n'
  AND COALESCE(o.is_deleted, 'n') = 'n'
  AND o.status = 'in_progress'
  AND oo.work_center_id IS NOT NULL
ORDER BY oo.work_center_id, o.id, o.actual_start_date DESC NULLS LAST;


-- ============================================================================
-- 4b. 材料明细视图（订单点开后的 BOM 材料清单数据源）
--     口径：直接读 erp_production_order_details —— 它是 explode_production_order_bom()
--     从对应 BOM（erp_bom_details）展开写库的，即「生产订单的材料来自对应 BOM」。
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_factory_3d_order_materials
  WITH (security_invoker = true) AS
SELECT
  d.tenant_id,
  o.id                     AS order_id,
  o.order_no,
  d.id                     AS order_detail_id,
  d.line_no,
  d.material_id,
  p.code                   AS material_code,
  p.name                   AS material_name,
  p.specification          AS material_spec,
  d.planned_quantity,
  d.issued_quantity,
  COALESCE(d.unit, p.unit) AS unit
FROM public.erp_production_order_details_s_539dcf81_b d
JOIN public.erp_production_orders_s_539dcf81_b o
  ON o.id = d.order_id AND o.tenant_id = d.tenant_id
LEFT JOIN public.erp_products_s_539dcf81_b p
  ON p.id = d.material_id
WHERE COALESCE(d.is_deleted, 'n') = 'n'
  AND COALESCE(o.is_deleted, 'n') = 'n'
  AND o.status IN ('released', 'in_progress');


-- ============================================================================
-- 5. 视图授权
-- ============================================================================
GRANT SELECT ON public.vw_factory_3d_devices          TO authenticated;
GRANT SELECT ON public.vw_factory_3d_orders           TO authenticated;
GRANT SELECT ON public.vw_factory_3d_order_operations TO authenticated;
GRANT SELECT ON public.vw_factory_3d_order_materials  TO authenticated;
GRANT SELECT ON public.vw_factory_3d_work_center_orders TO authenticated;


-- ============================================================================
-- 6. fail-loud 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_opts TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables
                  WHERE schemaname = 'public'
                    AND tablename  = 'factory_3d_device_layout_s_539dcf81_b') THEN
    v_missing := v_missing || ' factory_3d_device_layout 表缺失;';
  END IF;

  IF (SELECT COUNT(DISTINCT viewname) FROM pg_views
       WHERE schemaname = 'public'
         AND viewname  IN ('vw_factory_3d_devices', 'vw_factory_3d_orders',
                           'vw_factory_3d_order_operations',
                           'vw_factory_3d_order_materials')) < 4 THEN
    v_missing := v_missing || ' 4 个驾驶舱视图未全部创建;';
  END IF;

  -- 铁律：视图必须 security_invoker，否则会绕过底层 erp_* 的租户 RLS
  SELECT COALESCE(string_agg(c.reloptions::text, ' '), '')
    INTO v_opts
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'vw_factory_3d_devices';

  IF v_opts IS NULL OR (v_opts NOT ILIKE '%security_invoker=%true%'
                        AND v_opts NOT ILIKE '%security_invoker=true%') THEN
    v_missing := v_missing || ' vw_factory_3d_devices 未启用 security_invoker（会绕过租户 RLS）;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_135 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_135 自检通过：factory_3d_device_layout + 4 个 3D 驾驶舱视图就绪';
END;
$$;
