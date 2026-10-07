-- ============================================================================
-- P0-4：MRP 计划参数（最大批量） + 工作日历
-- ============================================================================
--
-- 补的是差距评估文档 §A 里三格「计划员日常参数缺失」：
--   A3 批量规则不全 —— 引擎只认 lot_for_lot / fixed_qty / multiples，
--      数据库 CHECK 允许的 `max_qty` 在引擎里直接回退逐批（只发警告）；
--   A? 没有工作日历 —— 提前期按**自然日**倒排，计划下达日会落在周末/节假日
--      （计划员看到的采购下单日是周日，实际没人下单）；
--   A? 订货点（order_point）字段早在建表时就留在 erp_products 上，
--      但**引擎从未读过它**，也没有任何前端入口 —— 一个死字段。
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. 最大批量用**新列** `erp_products.max_order_qty`，不复用 max_stock
--    `max_stock` 是「最高库存」（库存水位，用于补货目标），
--    `max_order_qty` 是「单张订单上限」（计划批量约束，用于拆单）。
--    两者数值经常相同但语义不同 —— 混用会让「补到最高库存」和
--    「每单不超过上限」互相污染，日后无法拆分。默认 0 = 不限制。
--
-- 2. 工作日历分「周规律 + 例外日」两张表
--    现实里工厂的作息是「周一到周五上班」+「春节放假 / 周日调休上班」。
--    所以主表存周规律（`work_days` = ISO 星期数组 1..7），
--    子表存例外日（`calendar_date` + `is_workday`，两个方向都要能改：
--    节假日 → FALSE，调休上班 → TRUE）。
--
-- 3. 日历**可缺省**：引擎在没有启用日历（或日历未启用）时退化为自然日
--    这不是兜底而是契约：老租户不维护日历，MRP 的行为必须与 deploy_114
--    之前**逐位一致**（否则一次升级就把所有历史计划的下达日改掉了）。
--    所以 `mrpService` 读不到默认日历就传 null，引擎走 addDays 自然日分支。
--
-- 4. 默认日历每租户至多一个（部分唯一索引）
--    「哪个日历生效」必须唯一，否则引擎要么随机挑一个、要么引入
--    优先级规则（徒增解释成本）。要换日历就把旧的取消默认。
--
-- 5. 例外日与日历**同租户**由复合外键强制
--    与 deploy_111 标准成本明细同理：单列外键挡不住「A 租户的日历 +
--    B 租户的例外日」跨租户串行（RLS 只校验本行的 tenant_id）。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（erp_products）、deploy_02（refresh_sys_tables）、
--       deploy_32（单据编号）、deploy_41（install_role_table_rls）、
--       deploy_52（clone_platform_baseline_to_tenant）。
-- ============================================================================


-- ============================================================================
-- 1. 物料计划参数补列：单张订单上限（最大批量）
-- ============================================================================
ALTER TABLE public.erp_products_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS max_order_qty NUMERIC(18, 6) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.erp_products_s_539dcf81_b.max_order_qty IS
  '批量规则 max_qty 的单张订单上限（0 = 不限制）。语义是「拆单约束」，不是「最高库存」（后者见 max_stock）。';

-- 约束幂等补丁：Postgres 没有 ADD CONSTRAINT IF NOT EXISTS
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_erp_products_max_order_qty'
       AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_products_s_539dcf81_b
      ADD CONSTRAINT ck_erp_products_max_order_qty CHECK (max_order_qty >= 0);
  END IF;

  -- 订货点此前是个无约束的裸字段：负数订货点会让「补到目标水位」算出负数补货量
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'ck_erp_products_order_point'
       AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_products_s_539dcf81_b
      ADD CONSTRAINT ck_erp_products_order_point CHECK (order_point >= 0);
  END IF;
END;
$$;


-- ============================================================================
-- 2. 工作日历（主表：周规律）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_work_calendars_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 编号走 generate_document_no('work_calendar')，与其余主数据一致
  calendar_no VARCHAR(50) NOT NULL,
  calendar_name VARCHAR(100) NOT NULL
    CHECK (BTRIM(calendar_name) <> ''),
  -- 周规律：ISO 星期（1=周一 … 7=周日）。默认双休。
  -- ⚠️ 空数组是**非法**的：全周不上班会让提前期倒排永远退不出循环，
  --    引擎里有保护性上限，但更该在入口就拒绝。
  work_days SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  -- 每租户至多一个默认日历（见部分唯一索引）
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
  CONSTRAINT ck_erp_work_calendars_work_days CHECK (
    work_days IS NOT NULL
    -- ⚠️ 必须 COALESCE(array_length(...), 0)：空数组的 array_length 是 **NULL**，
    --    而 CHECK 只在结果为 FALSE 时才拒绝，NULL 会**放行** ——
    --    写成 `array_length(work_days,1) BETWEEN 1 AND 7` 等于没拦空数组。
    AND COALESCE(array_length(work_days, 1), 0) BETWEEN 1 AND 7
    AND work_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
  )
);

-- 约束定义幂等修补：Postgres 没有 ALTER CONSTRAINT，只能 DROP + ADD。
-- 无条件重建是为了让「本文件已经跑过一次」的库也拿到最新口径（首次执行同理）。
ALTER TABLE public.erp_work_calendars_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_work_calendars_work_days;
ALTER TABLE public.erp_work_calendars_s_539dcf81_b
  ADD CONSTRAINT ck_erp_work_calendars_work_days CHECK (
    work_days IS NOT NULL
    AND COALESCE(array_length(work_days, 1), 0) BETWEEN 1 AND 7
    AND work_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
  );

-- 例外日的复合外键要指向它（见第 3 节）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_calendars_id_tenant
  ON public.erp_work_calendars_s_539dcf81_b (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_erp_work_calendars_tenant
  ON public.erp_work_calendars_s_539dcf81_b (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_calendars_no
  ON public.erp_work_calendars_s_539dcf81_b (tenant_id, calendar_no)
  WHERE is_deleted = 'n';

-- 每租户至多一个「默认」日历：引擎据此唯一确定生效日历
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_calendars_default
  ON public.erp_work_calendars_s_539dcf81_b (tenant_id)
  WHERE is_deleted = 'n' AND is_default;

COMMENT ON TABLE public.erp_work_calendars_s_539dcf81_b IS
  '工作日历（周规律 + 例外日）：MRP 提前期倒排按工作日计算。租户未维护日历时引擎退化为自然日。';
COMMENT ON COLUMN public.erp_work_calendars_s_539dcf81_b.work_days IS
  '周规律，ISO 星期数组（1=周一 … 7=周日），如 {1,2,3,4,5}。不得为空数组。';
COMMENT ON COLUMN public.erp_work_calendars_s_539dcf81_b.is_default IS
  '每租户至多一个默认日历（部分唯一索引）。只有 is_default 且 is_active 的日历会被 MRP 引擎采用。';


-- ============================================================================
-- 3. 工作日历例外日（节假日放假 / 周末调休上班）
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_work_calendar_days_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  calendar_id INTEGER NOT NULL,
  calendar_date DATE NOT NULL,
  -- 两个方向都要能表达：节假日 → FALSE；调休上班 → TRUE
  is_workday BOOLEAN NOT NULL,
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id(),
  -- 例外日必须与日历同租户（单列外键挡不住跨租户串行）
  CONSTRAINT fk_erp_work_calendar_days_calendar
    FOREIGN KEY (calendar_id, tenant_id)
    REFERENCES public.erp_work_calendars_s_539dcf81_b (id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_erp_work_calendar_days_tenant
  ON public.erp_work_calendar_days_s_539dcf81_b (tenant_id);

-- 引擎按 (日历, 日期区间) 批量捞例外日
CREATE INDEX IF NOT EXISTS idx_erp_work_calendar_days_lookup
  ON public.erp_work_calendar_days_s_539dcf81_b (tenant_id, calendar_id, calendar_date)
  WHERE is_deleted = 'n';

-- 同一日历同一天只能有一条例外（软删后允许重录）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_calendar_days_date
  ON public.erp_work_calendar_days_s_539dcf81_b (tenant_id, calendar_id, calendar_date)
  WHERE is_deleted = 'n';

COMMENT ON TABLE public.erp_work_calendar_days_s_539dcf81_b IS
  '工作日历例外日：覆盖周规律的单日设定（节假日放假 = FALSE，周末调休上班 = TRUE）。';
COMMENT ON COLUMN public.erp_work_calendar_days_s_539dcf81_b.is_workday IS
  '该日是否上班。FALSE=节假日（倒排时跳过）；TRUE=调休上班（倒排时计入工作日）。';


-- ============================================================================
-- 4. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_work_calendars_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_work_calendars_s_539dcf81_b_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_work_calendar_days_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_work_calendar_days_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_work_calendars_s_539dcf81_b');
SELECT public.install_role_table_rls('erp_work_calendar_days_s_539dcf81_b');

-- 注册到 sys_tables（第 5 节的授权要靠它）
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 5. 基线角色授权（sys_role_table_permissions）
--    新表不会自动获得授权 —— 没有这张表里的行，has_table_permission 恒为 FALSE，
--    除超管外所有人都读不到。漏掉是**静默失败**，故第 7 节自检。
-- ============================================================================
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
  AND t.table_name IN (
    'erp_work_calendars_s_539dcf81_b',
    'erp_work_calendar_days_s_539dcf81_b'
  )
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


-- ============================================================================
-- 6. 单据类型（工作日历编号规则）
--    工作日历不走审批、不产凭证，注册它的唯一目的是让编号走统一的
--    generate_document_no('work_calendar') —— 与 deploy_106 的 batch 同理。
--    规则用 {YYYY} 而**不带 {MM}**：日历是年度级主数据，按月重置序号没有意义。
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('work_calendar', '工作日历', 'id', 'mrp', '/mrp/work-calendars',
   'erp_work_calendars_s_539dcf81_b', 'WC{YYYY}{####}', FALSE, '1', 73, 'n')
ON CONFLICT (document_type) DO UPDATE SET
  document_name  = EXCLUDED.document_name,
  module_code    = EXCLUDED.module_code,
  route_path     = EXCLUDED.route_path,
  table_name     = EXCLUDED.table_name,
  naming_rule    = EXCLUDED.naming_rule,
  is_submittable = EXCLUDED.is_submittable,
  is_deleted     = 'n',
  updated_at     = NOW();


-- ============================================================================
-- 7. 菜单：物料计划参数（sort 15）+ 工作日历（sort 16）
--    位置约定：排在 14（生产退料）之后、70（委外组）之前 ——
--    它们是「计划基础参数」，属于基础数据段，不抢 委外组/生产报表 的最下方位置
--    （用户要求生产报表固定在 mrp 目录最下面，见 deploy_109）。
--    菜单类表走模板可见性，必须三步：基线行 → 基线角色授权 → 已物化租户补差。
--    sys_menus 没有 (tenant_id, menu_code) 唯一索引，只能 NOT EXISTS 守卫。
-- ============================================================================
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
  '物料计划参数', 'mrp_planning-params', 'C', 'SlidersOutlined',
  '/mrp/planning-params', './pages/mrp/PlanningParams', 15, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_planning-params'
);

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
  '工作日历', 'mrp_work-calendars', 'C', 'ScheduleOutlined',
  '/mrp/work-calendars', './pages/mrp/WorkCalendars', 16, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_work-calendars'
);

-- 基线角色授权
INSERT INTO public.sys_role_menus (role_id, menu_id, is_deleted, tenant_id)
SELECT r.id, m.id, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_menus m
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin')
  AND m.tenant_id IS NULL
  AND m.menu_code IN ('mrp_planning-params', 'mrp_work-calendars')
  AND COALESCE(m.is_deleted, 'n') = 'n'
  AND NOT EXISTS (
    SELECT 1 FROM public.sys_role_menus dup
    WHERE dup.role_id = r.id AND dup.menu_id = m.id
  );

-- 给已物化租户补菜单副本
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
    RAISE NOTICE '租户 % (%) 菜单补差：%', v_tenant.id, v_tenant.code, v_result;
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE '已给 % 个已物化租户补菜单', v_count;
END;
$$;


-- ============================================================================
-- 8. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing    TEXT := '';
  v_n          INTEGER;
  v_base_menu  INTEGER;
  v_parent     INTEGER;
  v_sort       INTEGER;
  v_tenant     RECORD;
  v_menu       RECORD;
  v_tables     CONSTANT TEXT[] := ARRAY[
    'erp_work_calendars_s_539dcf81_b',
    'erp_work_calendar_days_s_539dcf81_b'
  ];
  v_tbl        TEXT;
BEGIN
  -- 8.1 计划参数列：max_order_qty 必须 NOT NULL + 默认 0 + 非负约束
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_products_s_539dcf81_b'
     AND column_name = 'max_order_qty' AND is_nullable = 'NO'
     AND column_default LIKE '%0%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_products 缺 max_order_qty（NOT NULL DEFAULT 0）;';
  END IF;

  -- ⚠️ 不要写字面 "%max_order_qty >= 0"：Postgres 会把 0 规范化成 (0)::numeric，
  --    实际约束定义是 CHECK ((max_order_qty >= (0)::numeric))，字面量匹配必然失败。
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_products_max_order_qty'
     AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%max_order_qty%'
     AND pg_get_constraintdef(oid) ILIKE '%>=%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_products_max_order_qty（max_order_qty >= 0）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_products_order_point'
     AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%order_point%'
     AND pg_get_constraintdef(oid) ILIKE '%>=%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_products_order_point（order_point >= 0）;';
  END IF;

  -- 8.2 两张日历表：存在 / RLS ≥4 / tenant_id NOT NULL
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_tbl AND c.relkind = 'r'
    ) THEN
      v_missing := v_missing || format('缺表 %s;', v_tbl);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl;
    IF COALESCE(v_n, 0) < 4 THEN
      v_missing := v_missing || format('%s 的 RLS 策略只有 %s 条（应 ≥4）;', v_tbl, v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = v_tbl
       AND column_name = 'tenant_id' AND is_nullable = 'NO';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || format('%s 缺 tenant_id NOT NULL;', v_tbl);
    END IF;
  END LOOP;

  -- 8.3 work_days 合法性约束（空数组 / 越界星期必须进不来）
  --     ⚠️ 断言里必须看到 COALESCE：空数组的 array_length 是 NULL，
  --        而 CHECK 对 NULL 是**放行**，漏了 COALESCE 这条约束对空数组形同虚设。
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_work_calendars_work_days'
     AND conrelid = 'public.erp_work_calendars_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%array_length%'
     AND pg_get_constraintdef(oid) ILIKE '%COALESCE%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_work_calendars_work_days（work_days 非空且 1..7，需 COALESCE 兜住空数组）;';
  END IF;

  -- 8.4 关键唯一索引：编号 / 默认日历 / 例外日
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_work_calendars_s_539dcf81_b'
     AND indexname = 'uq_erp_work_calendars_no'
     AND indexdef ILIKE '%tenant_id%' AND indexdef ILIKE '%calendar_no%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 (tenant_id, calendar_no) 唯一索引;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_work_calendars_s_539dcf81_b'
     AND indexname = 'uq_erp_work_calendars_default'
     AND indexdef ILIKE '%is_default%' AND indexdef ILIKE '%WHERE%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺「每租户至多一个默认日历」部分唯一索引;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_work_calendar_days_s_539dcf81_b'
     AND indexname = 'uq_erp_work_calendar_days_date'
     AND indexdef ILIKE '%calendar_date%' AND indexdef ILIKE '%WHERE%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 (tenant_id, calendar_id, calendar_date) 唯一索引;';
  END IF;

  -- 8.5 例外日→日历的复合外键（同租户强制）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_work_calendar_days_calendar'
     AND conrelid = 'public.erp_work_calendar_days_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%calendar_id%'
     AND pg_get_constraintdef(oid) ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '例外日缺 (calendar_id, tenant_id) 复合外键;';
  END IF;

  -- 8.6 基线授权：3 个角色 × 2 张表 = 6 行
  SELECT count(*) INTO v_n
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_roles r ON r.id = rp.role_id
    JOIN public.sys_tables t ON t.id = rp.table_id
   WHERE rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
     AND r.tenant_id IS NULL AND COALESCE(r.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
     AND t.table_name = ANY (v_tables);
  IF COALESCE(v_n, 0) < 6 THEN
    v_missing := v_missing || format('基线表权限只有 %s 行（期望 6 = 3 角色 × 2 表）;', v_n);
  END IF;

  -- 8.7 已物化租户必须有授权副本（否则该租户管理员看不到工作日历）
  FOR v_tenant IN
    SELECT id FROM public.sys_tenants
     WHERE COALESCE(is_deleted, 'n') = 'n' AND COALESCE(metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n
      FROM public.sys_role_table_permissions rp
      JOIN public.sys_tables t ON t.id = rp.table_id
     WHERE rp.tenant_id = v_tenant.id AND COALESCE(rp.is_deleted, 'n') = 'n'
       AND t.table_name = ANY (v_tables);
    IF COALESCE(v_n, 0) < 2 THEN
      v_missing := v_missing || format('已物化租户%s的工作日历授权副本只有 %s/2;', v_tenant.id, v_n);
    END IF;
  END LOOP;

  -- 8.8 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE is_deleted = 'n' AND document_type = 'work_calendar'
     AND naming_rule = 'WC{YYYY}{####}';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 work_calendar 单据类型（WC{YYYY}{####}）;';
  END IF;

  -- 8.9 两个菜单：基线行 / 父必须是 mrp / sort_order / 基线角色授权 / 租户副本
  FOR v_menu IN
    SELECT * FROM (VALUES
      ('mrp_planning-params', 15),
      ('mrp_work-calendars',  16)
    ) AS x(menu_code, expected_sort)
  LOOP
    SELECT id, parent_id, sort_order INTO v_base_menu, v_parent, v_sort
    FROM public.sys_menus
    WHERE tenant_id IS NULL AND menu_code = v_menu.menu_code
      AND COALESCE(is_deleted, 'n') = 'n';

    IF v_base_menu IS NULL THEN
      v_missing := v_missing || format('基线菜单未写入：%s;', v_menu.menu_code);
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus p
      WHERE p.id = v_parent AND p.menu_code = 'mrp' AND p.tenant_id IS NULL
    ) THEN
      v_missing := v_missing || format('%s 未挂在 mrp 下（parent_id=%s）;', v_menu.menu_code, v_parent);
    END IF;

    IF v_sort <> v_menu.expected_sort THEN
      v_missing := v_missing || format('%s 的 sort_order=%s（期望 %s）;',
        v_menu.menu_code, v_sort, v_menu.expected_sort);
    END IF;

    SELECT count(*) INTO v_n
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
     WHERE rm.menu_id = v_base_menu AND rm.tenant_id IS NULL
       AND COALESCE(rm.is_deleted, 'n') = 'n'
       AND r.role_code IN ('super_admin', 'tenant_admin');
    IF COALESCE(v_n, 0) < 2 THEN
      v_missing := v_missing || format('%s 的基线角色授权不全（%s/2）;', v_menu.menu_code, v_n);
    END IF;

    FOR v_tenant IN
      SELECT t.id FROM public.sys_tenants t
       WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.sys_menus m
        WHERE m.tenant_id = v_tenant.id AND m.menu_code = v_menu.menu_code
          AND COALESCE(m.is_deleted, 'n') = 'n'
      ) THEN
        v_missing := v_missing || format('%s 在租户%s缺菜单副本;', v_menu.menu_code, v_tenant.id);
      ELSIF NOT EXISTS (
        SELECT 1
        FROM public.sys_role_menus rm
        JOIN public.sys_roles r ON r.id = rm.role_id
        JOIN public.sys_menus m ON m.id = rm.menu_id
        WHERE m.tenant_id = v_tenant.id AND m.menu_code = v_menu.menu_code
          AND rm.tenant_id = v_tenant.id AND COALESCE(rm.is_deleted, 'n') = 'n'
          AND r.role_code IN ('super_admin', 'tenant_admin')
      ) THEN
        v_missing := v_missing || format('%s 在租户%s缺角色授权;', v_menu.menu_code, v_tenant.id);
      END IF;
    END LOOP;
  END LOOP;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_114 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_114 OK：max_order_qty + 工作日历 2 表 / 复合外键 / 默认日历唯一 / 基线授权 / 1 DocType / 2 菜单齐备';
END;
$$;
