-- ============================================================================
-- P0-1：工单工序化（工序任务）—— 表结构
-- ============================================================================
--
-- 补的是差距评估文档里最大的一块结构性短板（§四.C）：
--   C1 工单无工序明细 —— `erp_production_order_details` 是**材料行**
--      (material_id / planned_quantity / issued_quantity / warehouse_id)，
--      不是工序行；全库没有 order_operation / dispatch / flow_card 任何一张表。
--      后果：客户问「我的活儿到哪一道了」，系统答不出来。
--   C2 报工不回写进度 —— 报工只登记工时，进度只能靠完工入库反推（D1）。
--   C3 无派工 —— 没有「这道工序谁做」的落点。
--   C4 工单状态无 CHECK —— 状态字段是自由文本，脏值可以随便写进去。
--
-- ---------------------------------------------------------------------------
-- 设计要点（都是刻意的，改之前先读）
-- ---------------------------------------------------------------------------
-- 1. **不抢 `erp_production_orders.completed_quantity`**
--    该字段是「**完工入库申报**」口径：`vw_erp_production_progress` 用已过账
--    完工入库算实际完工量、把表头这个值另列成 `declared_completed_quantity`；
--    `mrpService` 还用 `planned − completed − scrapped` 算「剩余量」参与 MRP 净算。
--    如果让报工去写它，就会和完工入库**两个来源争同一个字段**，MRP 净算也会被
--    车间报工左右。所以报工驱动的是**两个新列**：
--      · `reported_quantity`          末序累计合格完工数（报工口径）
--      · `operation_progress_percent` 按**计划工时加权**的工序进度（0..100）
--    口径分工：入库 = 库存事实源；报工 = 工序执行进度。两者都对，只是不同问题。
--
-- 2. **工序完工数只认 `status='confirmed'` 的报工**
--    与成本卷算（`costRollupService` / `vw_erp_production_cost`）**同一口径**：
--    草稿报工不进成本，也就进不了进度。否则误录一条草稿就把进度推上去，
--    而成本没动 —— 两个报表会互相打脸。确认动作＝班组长审核，这是业务上要的。
--
-- 3. **工时快照而非引用**
--    `standard_hours_per_unit` / `setup_hours` 从工艺路线明细**复制**过来，
--    `planned_hours` 落库。原因：工艺路线日后会改版，已下达工单的进度分母
--    必须稳定，否则「上周 80% 的工单今天变成 60%」。`source_routing_detail_id`
--    留溯源，但计算不再回头读它。
--
-- 4. **唯一键跟租户走**（项目铁律）
--    `(tenant_id, order_id, line_no) WHERE is_deleted='n'` —— 同一张工单内行号唯一。
--    「重新生成工序」走软删 + 重插，所以唯一键必须带 `is_deleted` 谓词。
--
-- 5. **两条复合外键挡住跨租户串行**
--    · 工序行 `(order_id, tenant_id)` → 工单 `(id, tenant_id)`
--    · 报工 `(order_operation_id, tenant_id)` → 工序行 `(id, tenant_id)`
--    单列外键挡不住「A 租户的工序挂到 B 租户的工单」（RLS 只校验本行的 tenant_id）。
--    为此需要给被引表补 `(id, tenant_id)` 唯一索引 —— id 是主键，(id, tenant_id)
--    天然唯一，加索引只是给外键一个可引用的目标，不改变任何现有语义。
--
-- 6. **`erp_production_reports` 加 `order_operation_id`，不另建报工表**
--    文档给了两个选项（新表 / 加列），选加列：报工单已经有
--    operation_id / completed_quantity / scrapped_quantity / work_center_id /
--    operator_id / labor_hours，再复制一张表会让「同一条报工」有两个落点，
--    成本卷算与产能负荷还得改两处。加一个**可空**的指向列最省事：
--    历史报工不带它（NULL）依旧合法，新报工带上后进度才流转。
--
-- 依赖：deploy_01（erp_production_orders / erp_production_reports / erp_operations）、
--       deploy_02（refresh_sys_tables）、deploy_41（install_role_table_rls）、
--       deploy_52（clone_platform_baseline_to_tenant）。
-- 后续：deploy_116 建 RPC 与触发器（生成工序 / 下达 / 报工回写进度）。
-- ============================================================================


-- ============================================================================
-- 1. 工单表：补外键目标索引 + 报工进度列 + 状态守卫
-- ============================================================================

-- 1.1 工序行的复合外键要指向 (id, tenant_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_production_orders_id_tenant
  ON public.erp_production_orders_s_539dcf81_b (id, tenant_id);

-- 1.2 报工口径的进度两列（见文件头「设计要点 1」）
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS reported_quantity NUMERIC(18,6) NOT NULL DEFAULT 0;
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS operation_progress_percent NUMERIC(5,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.erp_production_orders_s_539dcf81_b.reported_quantity IS
  '末序累计合格完工数（报工口径，仅 confirmed 报工）。与 completed_quantity（完工入库申报口径）分工不同，勿混用。';
COMMENT ON COLUMN public.erp_production_orders_s_539dcf81_b.operation_progress_percent IS
  '工序进度百分比（按工序计划工时加权，0..100）。由 deploy_116 的报工回写逻辑维护。';

-- 1.3 非负 / 区间约束（幂等重建：Postgres 无 ALTER CONSTRAINT）
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_production_orders_reported_quantity;
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD CONSTRAINT ck_erp_production_orders_reported_quantity
  CHECK (reported_quantity >= 0);

ALTER TABLE public.erp_production_orders_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_production_orders_operation_progress;
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD CONSTRAINT ck_erp_production_orders_operation_progress
  CHECK (operation_progress_percent >= 0 AND operation_progress_percent <= 100);

-- 1.4 状态取值守卫（C4）
--     status 可空（历史插入路径未必给值），一旦给了就必须落在枚举内 ——
--     用 `status IS NULL OR status IN (...)` 而不是 NOT NULL，是为了不给
--     别的写入路径制造无谓的破坏性变更。
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_production_orders_status;
ALTER TABLE public.erp_production_orders_s_539dcf81_b
  ADD CONSTRAINT ck_erp_production_orders_status CHECK (
    status IS NULL OR status IN (
      'draft', 'planned', 'released', 'in_progress', 'completed', 'closed', 'cancelled'
    )
  );


-- ============================================================================
-- 2. 工单工序（工序任务）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_production_order_operations_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 归属工单（复合外键强制同租户）
  order_id INTEGER NOT NULL,
  -- 工单内行号：1..N，按 (sequence_no, id) dense 生成，是「重新生成」的幂等键
  line_no INTEGER NOT NULL,
  -- 工序顺序（来自工艺路线 sequence_no，允许 10/20/30 这种留白编号）
  sequence_no INTEGER NOT NULL DEFAULT 0,
  operation_id INTEGER,
  work_center_id INTEGER,
  planned_quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- 合格完工数 / 报废数：由 deploy_116 的触发器按 confirmed 报工累加
  completed_quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
  scrapped_quantity NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- 工时快照（见文件头「设计要点 3」）
  standard_hours_per_unit NUMERIC(18,6) NOT NULL DEFAULT 0,
  setup_hours NUMERIC(18,6) NOT NULL DEFAULT 0,
  -- 计划总工时 = setup_hours + standard_hours_per_unit × planned_quantity
  planned_hours NUMERIC(18,6) NOT NULL DEFAULT 0,
  plan_start_date DATE,
  plan_end_date DATE,
  actual_start_date DATE,
  actual_end_date DATE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- 派工对象（C3）
  assignee_id INTEGER,
  -- 工序检验标记快照（供 P0-2 的成品/工序检验联动）
  is_inspection_required BOOLEAN NOT NULL DEFAULT FALSE,
  -- 溯源：本行由哪条工艺路线明细生成（不参与计算）
  source_routing_detail_id INTEGER,
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
  -- 工序行必须属于同租户的工单（单列外键挡不住跨租户串行）
  CONSTRAINT fk_erp_production_order_operations_order
    FOREIGN KEY (order_id, tenant_id)
    REFERENCES public.erp_production_orders_s_539dcf81_b (id, tenant_id)
    ON DELETE CASCADE,
  CONSTRAINT ck_erp_production_order_operations_status CHECK (
    status IN ('pending', 'in_progress', 'completed', 'cancelled')
  ),
  CONSTRAINT ck_erp_production_order_operations_qty CHECK (
    planned_quantity >= 0 AND completed_quantity >= 0 AND scrapped_quantity >= 0
  ),
  CONSTRAINT ck_erp_production_order_operations_hours CHECK (
    standard_hours_per_unit >= 0 AND setup_hours >= 0 AND planned_hours >= 0
  )
);

-- 2.1 报工挂工序要引它（(id, tenant_id) 复合外键目标）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_production_order_operations_id_tenant
  ON public.erp_production_order_operations_s_539dcf81_b (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_erp_production_order_operations_tenant
  ON public.erp_production_order_operations_s_539dcf81_b (tenant_id);

-- 一张工单内行号唯一；「重新生成工序」走软删 + 重插，故带 is_deleted 谓词
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_production_order_operations_order_line
  ON public.erp_production_order_operations_s_539dcf81_b (tenant_id, order_id, line_no)
  WHERE is_deleted = 'n';

-- 工序页签按工单 + 顺序读取
CREATE INDEX IF NOT EXISTS idx_erp_production_order_operations_order
  ON public.erp_production_order_operations_s_539dcf81_b (order_id, sequence_no, line_no)
  WHERE is_deleted = 'n';

-- 2.2 主数据外键（与 erp_routing_operation_details 同风格：单列外键）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_production_order_operations_operation'
       AND conrelid = 'public.erp_production_order_operations_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_production_order_operations_s_539dcf81_b
      ADD CONSTRAINT fk_erp_production_order_operations_operation
      FOREIGN KEY (operation_id) REFERENCES public.erp_operations_s_539dcf81_b (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_production_order_operations_work_center'
       AND conrelid = 'public.erp_production_order_operations_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_production_order_operations_s_539dcf81_b
      ADD CONSTRAINT fk_erp_production_order_operations_work_center
      FOREIGN KEY (work_center_id) REFERENCES public.erp_work_centers_s_539dcf81_b (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_production_order_operations_assignee'
       AND conrelid = 'public.erp_production_order_operations_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_production_order_operations_s_539dcf81_b
      ADD CONSTRAINT fk_erp_production_order_operations_assignee
      FOREIGN KEY (assignee_id) REFERENCES public.erp_employees_s_539dcf81_b (id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_production_order_operations_tenant'
       AND conrelid = 'public.erp_production_order_operations_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_production_order_operations_s_539dcf81_b
      ADD CONSTRAINT fk_erp_production_order_operations_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.sys_tenants (id) ON DELETE RESTRICT;
  END IF;
END;
$$;

COMMENT ON TABLE public.erp_production_order_operations_s_539dcf81_b IS
  '工单工序（工序任务）：工单下达时按工艺路线生成，报工回写完工数与进度。是「活儿跑到哪一道」的唯一落点。';
COMMENT ON COLUMN public.erp_production_order_operations_s_539dcf81_b.line_no IS
  '工单内行号（1..N），按 (sequence_no, id) dense 生成；(tenant, order, line_no) WHERE is_deleted=n 唯一。';
COMMENT ON COLUMN public.erp_production_order_operations_s_539dcf81_b.planned_hours IS
  '计划总工时 = setup_hours + standard_hours_per_unit × planned_quantity。是工序进度的加权分母。';
COMMENT ON COLUMN public.erp_production_order_operations_s_539dcf81_b.completed_quantity IS
  '合格完工数，按 confirmed 报工累加（草稿报工不计，与成本口径一致）。';
COMMENT ON COLUMN public.erp_production_order_operations_s_539dcf81_b.status IS
  'pending 待开工 / in_progress 进行中 / completed 已完工 / cancelled 已取消。由报工回写逻辑维护。';
COMMENT ON COLUMN public.erp_production_order_operations_s_539dcf81_b.assignee_id IS
  '派工对象（员工）。空 = 未派工，由派工动作或页面直接维护。';


-- ============================================================================
-- 3. 报工表挂工序行（见文件头「设计要点 6」）
-- ============================================================================
ALTER TABLE public.erp_production_reports_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS order_operation_id INTEGER;

COMMENT ON COLUMN public.erp_production_reports_s_539dcf81_b.order_operation_id IS
  '指向工单工序行（erp_production_order_operations）。为空 = 未挂工序的旧报工，不计入工序进度。';

-- 复合外键：报工与工序行必须同租户（可空 → 空值不校验，MATCH SIMPLE 语义）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_production_reports_order_operation'
       AND conrelid = 'public.erp_production_reports_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_production_reports_s_539dcf81_b
      ADD CONSTRAINT fk_erp_production_reports_order_operation
      FOREIGN KEY (order_operation_id, tenant_id)
      REFERENCES public.erp_production_order_operations_s_539dcf81_b (id, tenant_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_erp_production_reports_order_operation
  ON public.erp_production_reports_s_539dcf81_b (order_operation_id)
  WHERE is_deleted = 'n';


-- ============================================================================
-- 4. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_production_order_operations_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_production_order_operations_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_production_order_operations_s_539dcf81_b');

-- 注册到 sys_tables（第 5 节的授权要靠它）
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 5. 基线角色授权（sys_role_table_permissions）
--    新表不会自动获得授权 —— 没有这张表里的行，has_table_permission 恒为 FALSE，
--    除超管外所有人都读不到。漏掉是**静默失败**，故第 6 节自检。
-- ============================================================================
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
  AND t.table_name IN ('erp_production_order_operations_s_539dcf81_b')
  AND COALESCE(t.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_table_permissions rp
    WHERE rp.role_id = r.id AND rp.table_id = t.id
      AND rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
  );

-- 给已物化租户补差（基线授权对已物化租户不可见，不补差 → 租户管理员无权限）
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

-- 说明：工序行由 RPC 生成、无独立编号，故**不注册 DocType**（与 deploy_106/114 不同）。


-- ============================================================================
-- 6. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_n       INTEGER;
  v_missing TEXT := '';
  v_table   CONSTANT TEXT := 'erp_production_order_operations_s_539dcf81_b';
  v_reports CONSTANT TEXT := 'erp_production_reports_s_539dcf81_b';
  v_orders  CONSTANT TEXT := 'erp_production_orders_s_539dcf81_b';
BEGIN
  -- 6.1 表存在
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = v_table
  ) THEN
    v_missing := v_missing || format('表 %s 未创建;', v_table);
  END IF;

  -- 6.2 RLS 策略 ≥ 4（install_role_table_rls 装 select/insert/update/delete 四条）
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = v_table;
  IF COALESCE(v_n, 0) < 4 THEN
    v_missing := v_missing || format('%s 的 RLS 策略只有 %s 条（应为 4 条）;', v_table, v_n);
  END IF;

  -- 6.3 tenant_id 必须 NOT NULL（多租户铁律）
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_table
       AND column_name = 'tenant_id' AND is_nullable = 'NO'
  ) THEN
    v_missing := v_missing || format('%s.tenant_id 必须 NOT NULL;', v_table);
  END IF;

  -- 6.4 复合外键：工序行 → 工单（挡跨租户）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_production_order_operations_order'
     AND conrelid = format('public.%s', v_table)::regclass
     AND pg_get_constraintdef(oid) ILIKE '%(order_id, tenant_id)%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺工序行→工单的复合外键 (order_id, tenant_id) ;';
  END IF;

  -- 6.5 复合外键：报工 → 工序行（挡跨租户）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_production_reports_order_operation'
     AND conrelid = format('public.%s', v_reports)::regclass
     AND pg_get_constraintdef(oid) ILIKE '%(order_operation_id, tenant_id)%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺报工→工序行的复合外键 (order_operation_id, tenant_id) ;';
  END IF;

  -- 6.6 唯一索引：行号跟租户走
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = v_table
     AND indexname = 'uq_erp_production_order_operations_order_line';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 uq_erp_production_order_operations_order_line;';
  END IF;

  -- 6.7 外键目标：工单 (id, tenant_id)
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = v_orders
     AND indexname = 'uq_erp_production_orders_id_tenant';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 uq_erp_production_orders_id_tenant（复合外键目标）;';
  END IF;

  -- 6.8 工单两个进度列 + 状态守卫
  --     ⚠️ 断言只匹配「列名 + 比较符」：pg_get_constraintdef 会把 0 规范化成
  --     (0)::numeric，写死 '%>= 0%' 会匹配不上（deploy_114 踩过）。
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = v_orders
     AND column_name IN ('reported_quantity', 'operation_progress_percent');
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || '工单缺 reported_quantity / operation_progress_percent;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_production_orders_operation_progress'
     AND conrelid = format('public.%s', v_orders)::regclass
     AND pg_get_constraintdef(oid) ILIKE '%operation_progress_percent%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_production_orders_operation_progress;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_production_orders_status'
     AND conrelid = format('public.%s', v_orders)::regclass
     AND pg_get_constraintdef(oid) ILIKE '%in_progress%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_production_orders_status（状态枚举守卫）;';
  END IF;

  -- 6.9 工序行状态守卫
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_production_order_operations_status'
     AND conrelid = format('public.%s', v_table)::regclass
     AND pg_get_constraintdef(oid) ILIKE '%pending%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_production_order_operations_status;';
  END IF;

  -- 6.10 基线授权（平台角色 × 1 张表；实际行数取决于平台上有几个目标角色）
  SELECT count(*) INTO v_n
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_tables t ON t.id = rp.table_id
    JOIN public.sys_roles r ON r.id = rp.role_id
   WHERE t.table_name = v_table
     AND rp.tenant_id IS NULL
     AND r.tenant_id IS NULL
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
     AND COALESCE(rp.is_deleted, 'n') = 'n';
  IF COALESCE(v_n, 0) < 1 THEN
    v_missing := v_missing || format('%s 没有任何平台基线授权（漏了 = 静默无权限）;', v_table);
  END IF;

  -- 6.11 已物化租户授权补差
  --      ⚠️ 不能断言「每租户 ≥3 行」：**租户内刻意没有 super_admin**
  --      （项目铁律：建租户只走 bootstrap_tenant()，绝不把 super_admin 下放给租户），
  --      所以租户侧只有 tenant_admin / mrp_manager 两行。
  --      正确的不变量是「租户内**实际拥有**的目标角色，一个都不能少」。
  SELECT count(*) INTO v_n FROM (
    SELECT t.id
      FROM public.sys_tenants t
     WHERE COALESCE(t.is_deleted, 'n') = 'n'
       AND COALESCE(t.metadata_materialized, FALSE)
       AND (
         SELECT count(*)
           FROM public.sys_role_table_permissions rp
           JOIN public.sys_tables st ON st.id = rp.table_id
          WHERE st.table_name = v_table
            AND rp.tenant_id = t.id
            AND COALESCE(rp.is_deleted, 'n') = 'n'
       ) <> (
         SELECT count(*)
           FROM public.sys_roles r
          WHERE r.tenant_id = t.id
            AND COALESCE(r.is_deleted, 'n') = 'n'
            AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
       )
  ) bad;
  IF COALESCE(v_n, 0) > 0 THEN
    v_missing := v_missing || format('有 %s 个已物化租户没拿全 %s 的授权（基线对已物化租户不可见）;', v_n, v_table);
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_115 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_115 OK：工单工序表 / 报工挂工序 / 工单进度两列 / 状态守卫 / 复合外键 / 授权 齐备';
END;
$$;
