-- ============================================================================
-- deploy_136 —— 3D 工厂场景对象（AGV / 仓储房屋 / 人员 / 货车）
-- ============================================================================
--
-- ⚠️ 本文件是**可选增强件**，与 deploy_135 一样未登记进 000_run_all_* 执行清单：
--    ERP 主线不依赖它，需要 3D 驾驶舱场景对象时手动单独执行（幂等，可重复跑）：
--      node ./scripts/verify/run-migration.cjs supabase/tables/deploy_136_factory_3d_scene_objects.sql
--
-- 为 factory-3d 组件新增的 4 个场景对象模型（AGV 小车 / 仓储房屋 / 人员 / 货车）提供数据底座：
--
--   1. erp_agvs       AGV 小车主数据（系统此前无此对象，新增）
--   2. erp_vehicles   货车主数据（系统此前无此对象，新增，含车牌号）
--   3. factory_3d_scene_object   场景对象（摆放位置 + 绑定关系）
--      一行 = 一个可摆放对象在车间平面上的位置，及其绑定的业务对象。
--      仓库/人员分别绑定 erp_warehouses / erp_employees，AGV/货车绑定对应主数据。
--
-- 绑定口径：
--   · warehouse → bind_id 指向 erp_warehouses.id
--   · person    → bind_id 指向 erp_employees.id
--   · agv       → bind_id 指向 erp_agvs.id
--   · truck     → bind_id 指向 erp_vehicles.id
--   · bind_id 存 text（BindingOption.id 为 number|string，统一文本化）
--
-- 依赖：deploy_01（erp_warehouses / erp_employees）、deploy_117（erp_employees）、
--       deploy_41（install_role_table_rls / tenant 隔离）、
--       deploy_135（factory_3d_device_layout 的表风格 + 布局维护约定）。
-- ============================================================================


-- ============================================================================
-- 1. AGV 小车主数据
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_agvs_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    code VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    remark TEXT,
    tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_agvs_code
  ON public.erp_agvs_s_539dcf81_b (tenant_id, code)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_agvs_tenant
  ON public.erp_agvs_s_539dcf81_b (tenant_id)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_agvs_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_agvs_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_agvs_s_539dcf81_b');

COMMENT ON TABLE public.erp_agvs_s_539dcf81_b IS
  'AGV 小车主数据：3D 驾驶舱「AGV 小车」场景对象的绑定源。';
COMMENT ON COLUMN public.erp_agvs_s_539dcf81_b.status IS
  '启用状态：active 启用 / inactive 停用。';


-- ============================================================================
-- 2. 货车主数据
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_vehicles_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    plate_no VARCHAR(20) NOT NULL,
    name VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    remark TEXT,
    tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_vehicles_plate
  ON public.erp_vehicles_s_539dcf81_b (tenant_id, plate_no)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_erp_vehicles_tenant
  ON public.erp_vehicles_s_539dcf81_b (tenant_id)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_vehicles_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_vehicles_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_vehicles_s_539dcf81_b');

COMMENT ON TABLE public.erp_vehicles_s_539dcf81_b IS
  '货车主数据：3D 驾驶舱「货车」场景对象的绑定源。';
COMMENT ON COLUMN public.erp_vehicles_s_539dcf81_b.plate_no IS
  '车牌号（3D 场景对象的展示 label）。';


-- ============================================================================
-- 3. 场景对象表（摆放位置 + 绑定关系）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.factory_3d_scene_object_s_539dcf81_b (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    is_deleted CHAR(1) NOT NULL DEFAULT 'n',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- 客户端生成的稳定对象 id（obj_<时间戳>_<随机>），跨会话保持一致，做增量 upsert 键
    obj_id VARCHAR(64) NOT NULL,
    kind VARCHAR(20) NOT NULL,
    name VARCHAR(100) NOT NULL,
    scene_x NUMERIC(10, 3) NOT NULL DEFAULT 0,
    scene_z NUMERIC(10, 3) NOT NULL DEFAULT 0,
    bind_id TEXT,
    bind_label TEXT,
    status VARCHAR(20),
    tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
    CONSTRAINT ck_factory_3d_scene_object_kind
      CHECK (kind IN ('agv', 'warehouse', 'person', 'truck'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_factory_3d_scene_object_obj
  ON public.factory_3d_scene_object_s_539dcf81_b (tenant_id, obj_id)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_factory_3d_scene_object_tenant
  ON public.factory_3d_scene_object_s_539dcf81_b (tenant_id)
  WHERE is_deleted = 'n';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.factory_3d_scene_object_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.factory_3d_scene_object_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('factory_3d_scene_object_s_539dcf81_b');

COMMENT ON TABLE public.factory_3d_scene_object_s_539dcf81_b IS
  '3D 驾驶舱场景对象（AGV / 仓储房屋 / 人员 / 货车）的摆放位置与业务绑定。';
COMMENT ON COLUMN public.factory_3d_scene_object_s_539dcf81_b.obj_id IS
  '客户端生成的稳定对象 id，增量 upsert 键（同租户内唯一）。';
COMMENT ON COLUMN public.factory_3d_scene_object_s_539dcf81_b.bind_id IS
  '绑定的业务对象 id（warehouse→erp_warehouses / person→erp_employees / agv→erp_agvs / truck→erp_vehicles）。';

SELECT public.refresh_sys_tables();


-- ============================================================================
-- 4. fail-loud 自检
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables
                  WHERE schemaname = 'public'
                    AND tablename  = 'erp_agvs_s_539dcf81_b') THEN
    v_missing := v_missing || ' erp_agvs 表缺失;';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables
                  WHERE schemaname = 'public'
                    AND tablename  = 'erp_vehicles_s_539dcf81_b') THEN
    v_missing := v_missing || ' erp_vehicles 表缺失;';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_tables
                  WHERE schemaname = 'public'
                    AND tablename  = 'factory_3d_scene_object_s_539dcf81_b') THEN
    v_missing := v_missing || ' factory_3d_scene_object 表缺失;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_136 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_136 自检通过：AGV/货车/场景对象三表就绪';
END;
$$;
