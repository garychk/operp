-- ============================================================================
-- 排班地基 Step 1/3：班次主档 + 产能口径修正
-- ============================================================================
--
-- 背景：排班 = 人 × 日期 × 班次 × 工位。四要素里已有三个半：
--   · 人  = erp_employees + erp_departments（deploy_117 补了页面）
--   · 日期 = erp_work_calendars + erp_work_calendar_days（deploy_114）
--   · 工位 = erp_work_centers（含 capacity_per_day / labor_rate / overhead_rate）
--   · 事/派工/报工 = erp_production_orders / _operations.assignee_id / production_reports
-- 唯一缺失的是**班次**：全库不存在任何 shift/schedule/attendance 表。
--
-- 为什么班次是硬前提，而不是「以后再说」：
--   工作日历只能回答「这一天开不开工」（布尔），回答不了
--   「这一天开几班、每班几点到几点、每班净工时多少」。
--   而排班的最小单位正是「某人 / 某天 / 某班次 / 某工位」这一格。
--   没有班次主档，「排班」就只能退化成 Excel。
--
-- ---------------------------------------------------------------------------
-- 设计要点
-- ---------------------------------------------------------------------------
-- 1. net_hours 是**存储列**，不是生成列
--    生成列要求表达式 IMMUTABLE；`time - time` 在 PG 15 里走的是
--    `time_mi_time`（该函数在当前库中不可直接定位），为免踩不可变性判定的坑，
--    这里存实体列。口径：net_hours = (跨零点展开后的时长) - 休息分钟/60。
--    前端在起止时间/休息分钟变更时重算回写，与「单据表头合计由前端重算」
--    的既有约定一致；DB 侧只守住区间 [>0, ≤24]，不去校验等式 ——
--    现实里存在「休息照付薪」的特例，硬等式会把合法业务挡在门外。
--
-- 2. cross_midnight 是**显式**布尔，不从时间大小推导
--    夜班 20:00→04:00 与 08:00→08:00（24 小时班）在纯时间比较下无法区分。
--    用 CHECK 表达两者的合法组合：
--      跨零点 → end_time <= start_time（允许相等＝满 24 小时）
--      不跨点 → end_time >  start_time
--
-- 3. 工作日历参与产能计算（本文件同时修一个既有缺陷）
--    `vw_erp_capacity_load`（deploy_108 定义）此前用
--      capacity_per_day × 当月**自然日**数
--    作为月产能 —— 于是周末、节假日也被算成可生产的日子，负荷率被系统性低估。
--    deploy_114 已经让 MRP 提前期走工作日，产能却还在按自然日算，
--    两个口径在同一次升级里已经不一致了。本文件把产能也接到工作日历上。
--    ⚠️ 本文件成为 `vw_erp_capacity_load` 的**唯一真相源**，
--       改这台视图请改这里，deploy_108 里的旧定义已失效。
--
-- 4. 产能口径优先级：班次推导 > 人工填写（可缺省契约）
--    工作中心配了「基准班次」+「每天班次数」→ 日产能 = net_hours × shift_count；
--    没配 → 回退 `capacity_per_day`（与 deploy_114 工作日历「可缺省」同一精神：
--    老租户不维护班次时，产能数值必须与本次升级前**逐位一致**）。
--    视图额外输出 `capacity_source`（shift / manual）把口径来源摊开，
--    避免「为什么我填的 capacity_per_day 不生效」这种无从排查的疑问。
--
-- 5. 员工/工作中心的班次引用走**复合外键**（id, tenant_id）
--    单列外键挡不住「A 租户的员工 + B 租户的班次」跨租户串行（RLS 只校验本行）。
--    ⚠️ 复合外键要求被引用侧有 (id, tenant_id) 唯一索引：
--       erp_work_centers 此前**只有** (tenant_id, code) 唯一索引，故第 2 节补建。
--
-- 6. 不预置班次数据 —— 班次是**租户业务主数据**（erp_*），不是平台基线字典
--    （与 sys_dict_items 里的 Jobs 不同）。新建环境拿到空表是正确行为，
--    页面负责把空态说清楚。
--
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- 依赖：deploy_01（erp_employees / erp_work_centers）、deploy_02（refresh_sys_tables）、
--       deploy_32（单据编号 / generate_document_no）、deploy_41（install_role_table_rls）、
--       deploy_52（clone_platform_baseline_to_tenant）、
--       deploy_108（vw_erp_capacity_load，本文件覆盖之）、
--       deploy_114（erp_work_calendars / erp_work_calendar_days）。
-- ============================================================================


-- ============================================================================
-- 1. 班次主档
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.erp_shifts_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 编号走 generate_document_no('work_shift')，与其余主数据一致
  shift_no VARCHAR(50) NOT NULL,
  shift_name VARCHAR(100) NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  cross_midnight BOOLEAN NOT NULL DEFAULT FALSE,
  break_minutes INTEGER NOT NULL DEFAULT 0,
  net_hours NUMERIC(8, 2) NOT NULL DEFAULT 8,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  remark TEXT,
  created_by INTEGER,
  tenant_id BIGINT NOT NULL DEFAULT public.current_tenant_id()
);

-- 约束定义幂等修补：Postgres 没有 ALTER CONSTRAINT，只能 DROP + ADD。
-- 无条件重建是为了让「本文件已经跑过一次」的库也拿到最新口径（首次执行同理）。
ALTER TABLE public.erp_shifts_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_shifts_name_not_blank;
ALTER TABLE public.erp_shifts_s_539dcf81_b
  ADD CONSTRAINT ck_erp_shifts_name_not_blank CHECK (BTRIM(shift_name) <> '');

ALTER TABLE public.erp_shifts_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_shifts_break_minutes;
ALTER TABLE public.erp_shifts_s_539dcf81_b
  ADD CONSTRAINT ck_erp_shifts_break_minutes CHECK (
    break_minutes >= 0 AND break_minutes < 1440
  );

-- net_hours 只守区间，不校验与起止时间的等式（见设计要点 1）
ALTER TABLE public.erp_shifts_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_shifts_net_hours;
ALTER TABLE public.erp_shifts_s_539dcf81_b
  ADD CONSTRAINT ck_erp_shifts_net_hours CHECK (net_hours > 0 AND net_hours <= 24);

-- 起止时间的合法组合（见设计要点 2）
ALTER TABLE public.erp_shifts_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_shifts_time_order;
ALTER TABLE public.erp_shifts_s_539dcf81_b
  ADD CONSTRAINT ck_erp_shifts_time_order CHECK (
    CASE WHEN cross_midnight
         THEN end_time <= start_time
         ELSE end_time > start_time
    END
  );

-- 被 erp_employees / erp_work_centers 的复合外键引用
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_shifts_id_tenant
  ON public.erp_shifts_s_539dcf81_b (id, tenant_id);

CREATE INDEX IF NOT EXISTS idx_erp_shifts_tenant
  ON public.erp_shifts_s_539dcf81_b (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_shifts_no
  ON public.erp_shifts_s_539dcf81_b (tenant_id, shift_no)
  WHERE is_deleted = 'n';

COMMENT ON TABLE public.erp_shifts_s_539dcf81_b IS
  '班次主档：排班的最小单位（人 × 日期 × 班次 × 工位）。工作日历只表达「这天开不开工」，班次表达「这天开几班、每班多少净工时」。';
COMMENT ON COLUMN public.erp_shifts_s_539dcf81_b.cross_midnight IS
  '是否跨零点。TRUE 时 end_time 允许 <= start_time（夜班 20:00→04:00，或相等＝满 24 小时班）。';
COMMENT ON COLUMN public.erp_shifts_s_539dcf81_b.net_hours IS
  '每班净工时（小时）：跨零点展开后的时长减去休息分钟。由前端重算回写，DB 只守 (0, 24]。';
COMMENT ON COLUMN public.erp_shifts_s_539dcf81_b.break_minutes IS
  '班内休息分钟数（从净工时中扣除），取值 [0, 1440)。';


-- ============================================================================
-- 2. 工作中心：基准班次 + 每天班次数
-- ============================================================================
ALTER TABLE public.erp_work_centers_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS shift_id INTEGER;

-- 加 NOT NULL DEFAULT 1：PG 11+ 只改元数据，不重写表；
-- 语义是「常见情况下每天开 1 班，与旧版 capacity_per_day 口径一致」，不是兜底猜测。
ALTER TABLE public.erp_work_centers_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS shift_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.erp_work_centers_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS ck_erp_work_centers_shift_count;
ALTER TABLE public.erp_work_centers_s_539dcf81_b
  ADD CONSTRAINT ck_erp_work_centers_shift_count CHECK (
    shift_count >= 1 AND shift_count <= 4
  );

-- 被 erp_employees.work_center_id 的复合外键引用（此前缺这个索引）
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_work_centers_id_tenant
  ON public.erp_work_centers_s_539dcf81_b (id, tenant_id);

COMMENT ON COLUMN public.erp_work_centers_s_539dcf81_b.shift_id IS
  '基准班次。与 shift_count 一起推导日产能（net_hours × shift_count）；留空则产能回退到 capacity_per_day。';
COMMENT ON COLUMN public.erp_work_centers_s_539dcf81_b.shift_count IS
  '每天班次数 [1, 4]。与基准班次共同决定日产能；capacity_per_day 仅在未配基准班次时生效。';


-- ============================================================================
-- 3. 员工：默认班次 + 默认工位
-- ============================================================================
ALTER TABLE public.erp_employees_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS shift_id INTEGER;

ALTER TABLE public.erp_employees_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS work_center_id INTEGER;

COMMENT ON COLUMN public.erp_employees_s_539dcf81_b.shift_id IS
  '默认班次（排班时的预填值）。留空表示该员工不固定班次，由排班逐日指定。';
COMMENT ON COLUMN public.erp_employees_s_539dcf81_b.work_center_id IS
  '默认工位（常用工作中心）。排班时用于自动带出「该员工通常在哪个工位」。';


-- ============================================================================
-- 4. 复合外键（同租户强制）
--    MATCH SIMPLE（默认）：任一列 NULL 即不校验 → 员工不配班次时不受约束。
--    ON DELETE RESTRICT：班次是软删主数据，硬删应被挡住而不是把员工字段清空
--    （复合外键 + ON DELETE SET NULL 会连 tenant_id 一起置空，撞 NOT NULL）。
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_work_centers_shift'
       AND conrelid = 'public.erp_work_centers_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_work_centers_s_539dcf81_b
      ADD CONSTRAINT fk_erp_work_centers_shift
      FOREIGN KEY (shift_id, tenant_id)
      REFERENCES public.erp_shifts_s_539dcf81_b (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_employees_shift'
       AND conrelid = 'public.erp_employees_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_employees_s_539dcf81_b
      ADD CONSTRAINT fk_erp_employees_shift
      FOREIGN KEY (shift_id, tenant_id)
      REFERENCES public.erp_shifts_s_539dcf81_b (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_erp_employees_work_center'
       AND conrelid = 'public.erp_employees_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_employees_s_539dcf81_b
      ADD CONSTRAINT fk_erp_employees_work_center
      FOREIGN KEY (work_center_id, tenant_id)
      REFERENCES public.erp_work_centers_s_539dcf81_b (id, tenant_id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;


-- ============================================================================
-- 5. 产能负荷视图重写（口径修正）
--    前 11 列**保持原名原序**（CREATE OR REPLACE VIEW 不允许改已有列名/顺序），
--    新列一律追加在尾部。
--
--    变化点：
--      · capacity_hours：自然日数 → **当月工作日数**（有默认启用日历则按日历，
--        日历的例外日优先于周规律；无日历则退化为自然日＝旧行为）
--      · load_rate 的分母随之变化（负荷率会上升，这是修正后的真实值）
--      · 日产能：优先 net_hours × shift_count，回退 capacity_per_day
--      · 新增 work_day_count / capacity_source / shift_no / shift_name / shift_net_hours
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_capacity_load
WITH (security_invoker = true) AS
WITH report_load AS (
  SELECT rep.tenant_id,
         rep.work_center_id,
         DATE_TRUNC('month', rep.report_date)::date AS month_start,
         SUM(rep.labor_hours) AS labor_hours,
         SUM(rep.machine_hours) AS machine_hours
    FROM public.erp_production_reports_s_539dcf81_b rep
   WHERE COALESCE(rep.is_deleted, 'n') = 'n'
     AND rep.status = 'confirmed'
     AND rep.work_center_id IS NOT NULL
   GROUP BY rep.tenant_id, rep.work_center_id,
            DATE_TRUNC('month', rep.report_date)::date
)
SELECT
  r.tenant_id,
  r.work_center_id,
  wc.code AS work_center_code,
  wc.name AS work_center_name,
  r.month_start,
  COALESCE(wc.capacity_per_day, 0) AS capacity_per_day,
  ROUND(COALESCE(dc.daily_capacity, 0) * COALESCE(wd.work_day_count, 0), 2)
    AS capacity_hours,
  COALESCE(r.labor_hours, 0) AS labor_hours,
  COALESCE(r.machine_hours, 0) AS machine_hours,
  ROUND(COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0), 2)
    AS load_hours,
  CASE
    WHEN COALESCE(dc.daily_capacity, 0) * COALESCE(wd.work_day_count, 0) > 0
    THEN ROUND(
      (COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0))
      / (dc.daily_capacity * wd.work_day_count) * 100, 2)
    ELSE 0
  END AS load_rate,
  -- ↓ 以下为本次新增的诊断列
  COALESCE(wd.work_day_count, 0) AS work_day_count,
  dc.capacity_source,
  sh.shift_no,
  sh.shift_name,
  COALESCE(sh.net_hours, 0) AS shift_net_hours
FROM report_load r
LEFT JOIN public.erp_work_centers_s_539dcf81_b wc
       ON wc.id = r.work_center_id
      AND wc.tenant_id = r.tenant_id
      AND COALESCE(wc.is_deleted, 'n') = 'n'
-- 只认启用中的班次：停用班次不应继续贡献产能
LEFT JOIN public.erp_shifts_s_539dcf81_b sh
       ON sh.id = wc.shift_id
      AND sh.tenant_id = wc.tenant_id
      AND COALESCE(sh.is_deleted, 'n') = 'n'
      AND sh.is_active
LEFT JOIN LATERAL (
  SELECT COALESCE(
           NULLIF(COALESCE(sh.net_hours, 0) * COALESCE(wc.shift_count, 1), 0),
           COALESCE(wc.capacity_per_day, 0)
         ) AS daily_capacity,
         CASE
           WHEN COALESCE(sh.net_hours, 0) * COALESCE(wc.shift_count, 1) > 0
           THEN 'shift' ELSE 'manual'
         END AS capacity_source
) dc ON TRUE
-- 「默认 + 启用」的日历每租户至多一个（deploy_114 的部分唯一索引），取之即可
LEFT JOIN LATERAL (
  SELECT c.id, c.work_days
    FROM public.erp_work_calendars_s_539dcf81_b c
   WHERE c.tenant_id = r.tenant_id
     AND COALESCE(c.is_deleted, 'n') = 'n'
     AND c.is_default
     AND c.is_active
   LIMIT 1
) cal ON TRUE
-- 当月工作日数。⚠️ 没有日历时必须退化为「当月的全部天数」：
--    写成 cal.id IS NULL OR COALESCE(例外日, 周规律) 是利用 SQL 的
--    `OR` 短路 —— 若写成 COALESCE(子查询, cal.work_days = 任意)，无日历
--    （cal 全 NULL）会让整个表达式求值为 NULL，把每一天都筛掉 → 工作日数 0。
LEFT JOIN LATERAL (
  SELECT COUNT(*)::numeric AS work_day_count
    FROM generate_series(
           r.month_start::timestamp,
           (r.month_start + INTERVAL '1 mon - 1 day')::timestamp,
           INTERVAL '1 day'
         ) AS d(day)
   WHERE cal.id IS NULL
      OR COALESCE(
           (SELECT cd.is_workday
              FROM public.erp_work_calendar_days_s_539dcf81_b cd
             WHERE cd.tenant_id = r.tenant_id
               AND cd.calendar_id = cal.id
               AND cd.calendar_date = d.day::date
               AND COALESCE(cd.is_deleted, 'n') = 'n'
             LIMIT 1),
           EXTRACT(ISODOW FROM d.day)::smallint = ANY (cal.work_days)
         )
) wd ON TRUE;

COMMENT ON VIEW public.vw_erp_capacity_load IS
  '工作中心×月的产能负荷。月产能 = 日产能 × 当月工作日数（按租户默认启用日历扣非工作日；无日历退化为自然日）。日产能优先取 班次净工时 × 每天班次数，未配班次时回退 capacity_per_day（见 capacity_source）。';


-- ============================================================================
-- 6. 权限与 RLS（fail-closed，与其余 erp_* 一致）
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_shifts_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_shifts_s_539dcf81_b_id_seq TO authenticated;

SELECT public.install_role_table_rls('erp_shifts_s_539dcf81_b');

-- 注册到 sys_tables（第 7 节的授权要靠它）
SELECT public.refresh_sys_tables();


-- ============================================================================
-- 7. 基线角色授权（sys_role_table_permissions）
--    新表不会自动获得授权 —— 没有这张表里的行，has_table_permission 恒为 FALSE，
--    除超管外所有人都读不到。漏掉是**静默失败**，故第 10 节自检。
-- ============================================================================
INSERT INTO public.sys_role_table_permissions
  (role_id, table_id, can_select, can_insert, can_update, can_delete, is_deleted, tenant_id)
SELECT r.id, t.id, TRUE, TRUE, TRUE, TRUE, 'n', NULL
FROM public.sys_roles r
CROSS JOIN public.sys_tables t
WHERE r.tenant_id IS NULL
  AND COALESCE(r.is_deleted, 'n') = 'n'
  AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
  AND t.table_name = 'erp_shifts_s_539dcf81_b'
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
-- 8. 单据类型（班次编号规则）
--    班次不走审批、不产凭证，注册它的唯一目的是让编号走统一的
--    generate_document_no('work_shift') —— 与 deploy_114 的 work_calendar 同理。
--    规则用 {YYYY} 不带 {MM}：班次是长期有效的主数据，按月重置序号没有意义。
-- ============================================================================
INSERT INTO public.sys_document_types (
  document_type, document_name, primary_key_field, module_code, route_path,
  table_name, naming_rule, is_submittable, status, sort_order, is_deleted
)
VALUES
  ('work_shift', '班次', 'id', 'mrp', '/mrp/shifts',
   'erp_shifts_s_539dcf81_b', 'SHF{YYYY}{####}', FALSE, '1', 74, 'n')
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
-- 9. 菜单：班次管理（sort 17）
--    位置约定：紧贴「工作日历」（16）—— 同属「时间维度的基础数据」，
--    且是它的下游（日历说哪天开工，班次说那天开几班）。
--    生产报表固定占 74（deploy_109），委外组占 70..73，均不冲突。
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
  '班次管理', 'mrp_shifts', 'C', 'FieldTimeOutlined',
  '/mrp/shifts', './pages/mrp/Shifts', 17, '1', 'n', NULL
WHERE NOT EXISTS (
  SELECT 1 FROM public.sys_menus m
  WHERE m.tenant_id IS NULL AND m.menu_code = 'mrp_shifts'
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
  AND m.menu_code = 'mrp_shifts'
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
-- 10. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_missing     TEXT := '';
  v_n           INTEGER;
  v_menu        INTEGER;
  v_parent      INTEGER;
  v_sort        INTEGER;
  v_tenant      RECORD;
BEGIN
  -- 10.1 表存在 / RLS ≥4 / tenant_id NOT NULL
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'erp_shifts_s_539dcf81_b'
       AND c.relkind = 'r'
  ) THEN
    v_missing := v_missing || '缺表 erp_shifts_s_539dcf81_b;';
  ELSE
    SELECT count(*) INTO v_n FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'erp_shifts_s_539dcf81_b';
    IF COALESCE(v_n, 0) < 4 THEN
      v_missing := v_missing || format('erp_shifts 的 RLS 策略只有 %s 条（应 ≥4）;', v_n);
    END IF;

    SELECT count(*) INTO v_n
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'erp_shifts_s_539dcf81_b'
       AND column_name = 'tenant_id' AND is_nullable = 'NO';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || 'erp_shifts 缺 tenant_id NOT NULL;';
    END IF;
  END IF;

  -- 10.2 三条业务约束必须都在（跨零点规则 / 净工时区间 / 休息分钟区间）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_shifts_time_order'
     AND conrelid = 'public.erp_shifts_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%cross_midnight%'
     AND pg_get_constraintdef(oid) ILIKE '%end_time%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_shifts_time_order（跨零点与起止时间的合法组合）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_shifts_net_hours'
     AND conrelid = 'public.erp_shifts_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%net_hours%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_shifts_net_hours（(0, 24]）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'ck_erp_shifts_break_minutes'
     AND conrelid = 'public.erp_shifts_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%break_minutes%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 ck_erp_shifts_break_minutes（[0, 1440)）;';
  END IF;

  -- 10.3 被复合外键引用的唯一索引必须存在
  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_shifts_s_539dcf81_b'
     AND indexname = 'uq_erp_shifts_id_tenant'
     AND indexdef ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 uq_erp_shifts_id_tenant（复合外键的引用目标）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_shifts_s_539dcf81_b'
     AND indexname = 'uq_erp_shifts_no'
     AND indexdef ILIKE '%shift_no%' AND indexdef ILIKE '%WHERE%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 (tenant_id, shift_no) 唯一索引;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_indexes
   WHERE schemaname = 'public' AND tablename = 'erp_work_centers_s_539dcf81_b'
     AND indexname = 'uq_erp_work_centers_id_tenant'
     AND indexdef ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 uq_erp_work_centers_id_tenant（员工工位外键的引用目标）;';
  END IF;

  -- 10.4 补列 + 默认值
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_work_centers_s_539dcf81_b'
     AND column_name = 'shift_id';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_work_centers 缺 shift_id;';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_work_centers_s_539dcf81_b'
     AND column_name = 'shift_count' AND is_nullable = 'NO'
     AND column_default = '1';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'erp_work_centers.shift_count 应为 NOT NULL DEFAULT 1;';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'erp_employees_s_539dcf81_b'
     AND column_name IN ('shift_id', 'work_center_id');
  IF COALESCE(v_n, 0) <> 2 THEN
    v_missing := v_missing || format('erp_employees 只补了 %s/2 列（shift_id, work_center_id）;', v_n);
  END IF;

  -- 10.5 三条复合外键（都必须同时含 id 列与 tenant_id 列）
  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_work_centers_shift'
     AND conrelid = 'public.erp_work_centers_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%shift_id%'
     AND pg_get_constraintdef(oid) ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 fk_erp_work_centers_shift（(shift_id, tenant_id)）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_employees_shift'
     AND conrelid = 'public.erp_employees_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%shift_id%'
     AND pg_get_constraintdef(oid) ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 fk_erp_employees_shift（(shift_id, tenant_id)）;';
  END IF;

  SELECT count(*) INTO v_n FROM pg_constraint
   WHERE conname = 'fk_erp_employees_work_center'
     AND conrelid = 'public.erp_employees_s_539dcf81_b'::regclass
     AND pg_get_constraintdef(oid) ILIKE '%work_center_id%'
     AND pg_get_constraintdef(oid) ILIKE '%tenant_id%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 fk_erp_employees_work_center（(work_center_id, tenant_id)）;';
  END IF;

  -- 10.6 产能视图：仍须 security_invoker + 新增诊断列 + 定义里真的读了日历
  SELECT count(*) INTO v_n FROM pg_class
   WHERE relname = 'vw_erp_capacity_load'
     AND reloptions @> ARRAY['security_invoker=true'];
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'vw_erp_capacity_load 丢了 security_invoker=true;';
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_erp_capacity_load'
     AND column_name IN ('work_day_count', 'capacity_source', 'shift_net_hours',
                         'shift_no', 'shift_name');
  IF COALESCE(v_n, 0) <> 5 THEN
    v_missing := v_missing || format('vw_erp_capacity_load 只新增了 %s/5 个诊断列;', v_n);
  END IF;

  -- 前 11 列必须原样保留（下游 ProductionAnalytics 按名取列）
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'vw_erp_capacity_load'
     AND ordinal_position <= 11
     AND column_name IN ('tenant_id', 'work_center_id', 'work_center_code',
                         'work_center_name', 'month_start', 'capacity_per_day',
                         'capacity_hours', 'labor_hours', 'machine_hours',
                         'load_hours', 'load_rate');
  IF COALESCE(v_n, 0) <> 11 THEN
    v_missing := v_missing || format('vw_erp_capacity_load 前 11 列被改动了（只匹配到 %s/11）;', v_n);
  END IF;

  -- 视图定义里必须出现日历两张表 —— 否则「扣非工作日」只是注释里的口号
  SELECT count(*) INTO v_n
    FROM pg_views
   WHERE schemaname = 'public' AND viewname = 'vw_erp_capacity_load'
     AND definition ILIKE '%erp_work_calendars%'
     AND definition ILIKE '%erp_work_calendar_days%'
     AND definition ILIKE '%is_workday%';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'vw_erp_capacity_load 未接入工作日历（is_workday）;';
  END IF;

  -- 10.7 基线授权：3 个角色 × 1 张表 = 3 行
  SELECT count(*) INTO v_n
    FROM public.sys_role_table_permissions rp
    JOIN public.sys_roles r ON r.id = rp.role_id
    JOIN public.sys_tables t ON t.id = rp.table_id
   WHERE rp.tenant_id IS NULL AND COALESCE(rp.is_deleted, 'n') = 'n'
     AND r.tenant_id IS NULL AND COALESCE(r.is_deleted, 'n') = 'n'
     AND r.role_code IN ('super_admin', 'tenant_admin', 'mrp_manager')
     AND t.table_name = 'erp_shifts_s_539dcf81_b';
  IF COALESCE(v_n, 0) < 3 THEN
    v_missing := v_missing || format('erp_shifts 的基线表权限只有 %s 行（期望 3）;', v_n);
  END IF;

  -- 10.8 已物化租户必须有授权副本（否则该租户管理员看不到班次）
  FOR v_tenant IN
    SELECT id FROM public.sys_tenants
     WHERE COALESCE(is_deleted, 'n') = 'n' AND COALESCE(metadata_materialized, FALSE)
  LOOP
    SELECT count(*) INTO v_n
      FROM public.sys_role_table_permissions rp
      JOIN public.sys_tables t ON t.id = rp.table_id
     WHERE rp.tenant_id = v_tenant.id AND COALESCE(rp.is_deleted, 'n') = 'n'
       AND t.table_name = 'erp_shifts_s_539dcf81_b';
    IF COALESCE(v_n, 0) < 1 THEN
      v_missing := v_missing || format('已物化租户%s的班次表授权副本缺失;', v_tenant.id);
    END IF;
  END LOOP;

  -- 10.9 单据类型
  SELECT count(*) INTO v_n FROM public.sys_document_types
   WHERE is_deleted = 'n' AND document_type = 'work_shift'
     AND naming_rule = 'SHF{YYYY}{####}'
     AND table_name = 'erp_shifts_s_539dcf81_b';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || '缺 work_shift 单据类型（SHF{YYYY}{####}）;';
  END IF;

  -- 10.10 菜单：基线行 / 父必须是 mrp / sort 17 / component·icon 与前端一致
  SELECT id, parent_id, sort_order INTO v_menu, v_parent, v_sort
  FROM public.sys_menus
  WHERE tenant_id IS NULL AND menu_code = 'mrp_shifts'
    AND COALESCE(is_deleted, 'n') = 'n';

  IF v_menu IS NULL THEN
    v_missing := v_missing || '基线菜单 mrp_shifts 未写入;';
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.sys_menus p
      WHERE p.id = v_parent AND p.menu_code = 'mrp' AND p.tenant_id IS NULL
    ) THEN
      v_missing := v_missing || format('mrp_shifts 未挂在 mrp 下（parent_id=%s）;', v_parent);
    END IF;

    IF v_sort <> 17 THEN
      v_missing := v_missing || format('mrp_shifts 的 sort_order=%s（期望 17）;', v_sort);
    END IF;

    SELECT count(*) INTO v_n
      FROM public.sys_menus m
     WHERE m.id = v_menu
       AND m.path = '/mrp/shifts'
       AND m.component = './pages/mrp/Shifts'
       AND m.icon = 'FieldTimeOutlined';
    IF COALESCE(v_n, 0) <> 1 THEN
      v_missing := v_missing || 'mrp_shifts 的 path/component/icon 与前端登记不一致;';
    END IF;

    SELECT count(*) INTO v_n
      FROM public.sys_role_menus rm
      JOIN public.sys_roles r ON r.id = rm.role_id
     WHERE rm.menu_id = v_menu AND rm.tenant_id IS NULL
       AND COALESCE(rm.is_deleted, 'n') = 'n'
       AND r.role_code IN ('super_admin', 'tenant_admin');
    IF COALESCE(v_n, 0) < 2 THEN
      v_missing := v_missing || format('mrp_shifts 的基线角色授权不全（%s/2）;', v_n);
    END IF;

    FOR v_tenant IN
      SELECT t.id FROM public.sys_tenants t
       WHERE COALESCE(t.is_deleted, 'n') = 'n' AND COALESCE(t.metadata_materialized, FALSE)
    LOOP
      IF NOT EXISTS (
        SELECT 1 FROM public.sys_menus m
        WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_shifts'
          AND COALESCE(m.is_deleted, 'n') = 'n'
      ) THEN
        v_missing := v_missing || format('mrp_shifts 在租户%s缺菜单副本;', v_tenant.id);
      ELSIF NOT EXISTS (
        SELECT 1
        FROM public.sys_role_menus rm
        JOIN public.sys_roles r ON r.id = rm.role_id
        JOIN public.sys_menus m ON m.id = rm.menu_id
        WHERE m.tenant_id = v_tenant.id AND m.menu_code = 'mrp_shifts'
          AND rm.tenant_id = v_tenant.id AND COALESCE(rm.is_deleted, 'n') = 'n'
          AND r.role_code IN ('super_admin', 'tenant_admin')
      ) THEN
        v_missing := v_missing || format('mrp_shifts 在租户%s缺角色授权;', v_tenant.id);
      END IF;
    END LOOP;
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_119 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_119 OK：班次主档 / 员工+工作中心班次字段 / 3 条复合外键 / 产能口径接入工作日历 / 1 DocType / 1 菜单齐备';
END;
$$;
