-- ============================================================================
-- deploy_108 —— P0-5：生产报表四件套（security_invoker 视图）
-- ============================================================================
--
-- 目的：给「生产制造」补上标准 ERP 必备的四张生产报表（此前该域报表为 0）：
--   ① vw_erp_production_progress  生产进度表（工单 vs 已完工 vs 在制 vs 逾期）
--   ② vw_erp_production_cost      工单成本表（料/工/费 + 单位成本，按生产订单）
--   ③ vw_erp_wip_report           在制品报表（期初 + 本期投入 − 完工结转 = 期末在制）
--   ④ vw_erp_capacity_load        产能负荷表（工作中心 × 月份：工时负荷 vs 产能）
--
-- 设计约束（与项目既有铁律一致）：
--   * **一律 `security_invoker = true`** —— 视图不提升权限，底层 erp_* 的
--     fail-closed RLS 按调用者身份生效；否则视图会变成绕过租户隔离的后门。
--   * 主数据关联一律 `LEFT JOIN`（软删物料不能让工单凭空消失，只让名称为 NULL）。
--   * **口径必须与 `ai-server/src/services/costRollupService.ts` 一致**：
--       材料 = 已过账领料明细 amount 合计；
--       人工 = 已确认报工 labor_hours  × 工作中心 labor_rate；
--       制费 = 已确认报工 machine_hours × 工作中心 overhead_rate；
--       完工 = 已过账完工入库 quantity 合计。
--     报工只在 `status='confirmed'` 时计入（草稿报工不参与，避免误录工时污染成本）。
--
-- 与 ai-server 的成本卷算（按月 × 产品）的区别：
--   * 本视图 ② 是**按生产订单**的「工单成本表」（全部期间累计，用于单张工单算账）；
--   * ai-server 的 `erp_cost_calculations` 是**按月 × 产品**的期末结转口径，
--     走视图 ③ 展示。两者是不同粒度，不要互相替代。
--
-- 已知口径说明（别当成 bug）：
--   * 产能负荷表只输出**有已确认报工**的工作中心 × 月份行；没有报工的月份不补零行。
--     产能 = `capacity_per_day × 该月自然日数`（与 MPS 的 RCCP 同口径，非工作日历）。
--   * 生产进度表用「已过账完工入库」作为实际完工量；`declared_completed_quantity`
--     另列展示工单表头上的申报值，两者不一致时以入库为准（库存流水是唯一事实源）。
-- ============================================================================


-- ============================================================================
-- ① 生产进度表
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_production_progress
  WITH (security_invoker = true) AS
SELECT
  o.tenant_id,
  o.id                              AS order_id,
  o.order_no,
  o.order_date,
  o.status,
  o.priority,
  o.product_id,
  pr.code                           AS product_code,
  pr.name                           AS product_name,
  pr.unit,
  o.planned_quantity,
  o.completed_quantity              AS declared_completed_quantity,
  o.scrapped_quantity,
  COALESCE(rcv.received_quantity, 0) AS received_quantity,
  GREATEST(0, COALESCE(o.planned_quantity, 0) - COALESCE(rcv.received_quantity, 0))
                                    AS remaining_quantity,
  CASE WHEN COALESCE(o.planned_quantity, 0) > 0
       THEN ROUND(COALESCE(rcv.received_quantity, 0) / o.planned_quantity * 100, 2)
       ELSE 0 END                   AS progress_pct,
  CASE WHEN COALESCE(rcv.received_quantity, 0) + COALESCE(o.scrapped_quantity, 0) > 0
       THEN ROUND(COALESCE(o.scrapped_quantity, 0)
                  / (COALESCE(rcv.received_quantity, 0) + COALESCE(o.scrapped_quantity, 0)) * 100, 2)
       ELSE 0 END                   AS scrap_rate,
  o.planned_start_date,
  o.planned_end_date,
  o.actual_start_date,
  o.actual_end_date,
  CASE WHEN o.status IN ('completed', 'closed', 'cancelled') THEN 0
       WHEN o.planned_end_date IS NOT NULL AND o.planned_end_date < CURRENT_DATE
       THEN (CURRENT_DATE - o.planned_end_date)
       ELSE 0 END                   AS delay_days,
  bom.bom_no,
  rt.routing_no,
  wc.name                           AS work_center_name
FROM public.erp_production_orders_s_539dcf81_b o
LEFT JOIN public.erp_products_s_539dcf81_b       pr  ON pr.id  = o.product_id   AND pr.tenant_id  = o.tenant_id  AND COALESCE(pr.is_deleted, 'n')  = 'n'
LEFT JOIN public.erp_boms_s_539dcf81_b           bom ON bom.id = o.bom_id       AND bom.tenant_id = o.tenant_id  AND COALESCE(bom.is_deleted, 'n') = 'n'
LEFT JOIN public.erp_routing_operations_s_539dcf81_b rt ON rt.id = o.routing_id AND rt.tenant_id = o.tenant_id  AND COALESCE(rt.is_deleted, 'n')  = 'n'
LEFT JOIN public.erp_work_centers_s_539dcf81_b   wc  ON wc.id  = o.work_center_id AND wc.tenant_id = o.tenant_id AND COALESCE(wc.is_deleted, 'n')  = 'n'
LEFT JOIN (
  SELECT r.tenant_id,
         r.production_order_id,
         SUM(r.quantity) AS received_quantity
    FROM public.erp_production_receipts_s_539dcf81_b r
   WHERE COALESCE(r.is_deleted, 'n') = 'n'
     AND r.status = 'posted'
   GROUP BY r.tenant_id, r.production_order_id
) rcv ON rcv.production_order_id = o.id AND rcv.tenant_id = o.tenant_id
WHERE COALESCE(o.is_deleted, 'n') = 'n';


-- ============================================================================
-- ② 工单成本表（按生产订单，全部期间累计）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_production_cost
  WITH (security_invoker = true) AS
SELECT
  o.tenant_id,
  o.id                              AS order_id,
  o.order_no,
  o.order_date,
  o.status,
  o.product_id,
  pr.code                           AS product_code,
  pr.name                           AS product_name,
  COALESCE(mat.material_cost, 0)    AS material_cost,
  COALESCE(lab.labor_cost, 0)       AS labor_cost,
  COALESCE(lab.overhead_cost, 0)    AS overhead_cost,
  ROUND(COALESCE(mat.material_cost, 0)
        + COALESCE(lab.labor_cost, 0)
        + COALESCE(lab.overhead_cost, 0), 4) AS total_cost,
  COALESCE(rcv.received_quantity, 0) AS received_quantity,
  CASE WHEN COALESCE(rcv.received_quantity, 0) > 0
       THEN ROUND((COALESCE(mat.material_cost, 0)
                   + COALESCE(lab.labor_cost, 0)
                   + COALESCE(lab.overhead_cost, 0)) / rcv.received_quantity, 4)
       ELSE 0 END                   AS unit_cost
FROM public.erp_production_orders_s_539dcf81_b o
LEFT JOIN public.erp_products_s_539dcf81_b pr
       ON pr.id = o.product_id AND pr.tenant_id = o.tenant_id AND COALESCE(pr.is_deleted, 'n') = 'n'
LEFT JOIN (
  SELECT mi.tenant_id,
         mi.production_order_id,
         SUM(mid.amount) AS material_cost
    FROM public.erp_material_issues_s_539dcf81_b mi
    JOIN public.erp_material_issue_details_s_539dcf81_b mid
      ON mid.issue_id = mi.id AND mid.tenant_id = mi.tenant_id AND COALESCE(mid.is_deleted, 'n') = 'n'
   WHERE COALESCE(mi.is_deleted, 'n') = 'n'
     AND mi.status = 'posted'
     AND mi.production_order_id IS NOT NULL
   GROUP BY mi.tenant_id, mi.production_order_id
) mat ON mat.production_order_id = o.id AND mat.tenant_id = o.tenant_id
LEFT JOIN (
  SELECT r.tenant_id,
         r.production_order_id,
         SUM(r.labor_hours   * COALESCE(wc.labor_rate, 0))    AS labor_cost,
         SUM(r.machine_hours * COALESCE(wc.overhead_rate, 0)) AS overhead_cost
    FROM public.erp_production_reports_s_539dcf81_b r
    LEFT JOIN public.erp_work_centers_s_539dcf81_b wc
      ON wc.id = r.work_center_id AND wc.tenant_id = r.tenant_id AND COALESCE(wc.is_deleted, 'n') = 'n'
   WHERE COALESCE(r.is_deleted, 'n') = 'n'
     AND r.status = 'confirmed'
     AND r.production_order_id IS NOT NULL
   GROUP BY r.tenant_id, r.production_order_id
) lab ON lab.production_order_id = o.id AND lab.tenant_id = o.tenant_id
LEFT JOIN (
  SELECT r.tenant_id,
         r.production_order_id,
         SUM(r.quantity) AS received_quantity
    FROM public.erp_production_receipts_s_539dcf81_b r
   WHERE COALESCE(r.is_deleted, 'n') = 'n'
     AND r.status = 'posted'
     AND r.production_order_id IS NOT NULL
   GROUP BY r.tenant_id, r.production_order_id
) rcv ON rcv.production_order_id = o.id AND rcv.tenant_id = o.tenant_id
WHERE COALESCE(o.is_deleted, 'n') = 'n';


-- ============================================================================
-- ③ 在制品报表（按月 × 产品，来自成本卷算落库结果）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_wip_report
  WITH (security_invoker = true) AS
SELECT
  cc.tenant_id,
  p.year                            AS period_year,
  p.month                           AS period_month,
  make_date(p.year, p.month, 1)     AS period_start,
  cc.product_id,
  pr.code                           AS product_code,
  pr.name                           AS product_name,
  COALESCE(cc.beginning_wip, 0)     AS beginning_wip,
  COALESCE(cc.current_material, 0)  AS current_material,
  COALESCE(cc.current_labor, 0)     AS current_labor,
  COALESCE(cc.current_overhead, 0)  AS current_overhead,
  COALESCE(cc.total_cost, 0)        AS current_input,
  COALESCE(cc.finished_quantity, 0) AS finished_quantity,
  COALESCE(cc.unit_cost, 0)         AS unit_cost,
  COALESCE(cc.ending_wip, 0)        AS ending_wip
FROM public.erp_cost_calculations_s_539dcf81_b cc
JOIN public.erp_accounting_periods_s_539dcf81_b p
  ON p.id = cc.period_id AND p.tenant_id = cc.tenant_id AND COALESCE(p.is_deleted, 'n') = 'n'
LEFT JOIN public.erp_products_s_539dcf81_b pr
  ON pr.id = cc.product_id AND pr.tenant_id = cc.tenant_id AND COALESCE(pr.is_deleted, 'n') = 'n'
WHERE COALESCE(cc.is_deleted, 'n') = 'n';


-- ============================================================================
-- ④ 产能负荷表（工作中心 × 月份：实际工时负荷 vs 产能）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_capacity_load
  WITH (security_invoker = true) AS
SELECT
  r.tenant_id,
  r.work_center_id,
  wc.code                           AS work_center_code,
  wc.name                           AS work_center_name,
  r.month_start,
  COALESCE(wc.capacity_per_day, 0)  AS capacity_per_day,
  ROUND(COALESCE(wc.capacity_per_day, 0)
        * EXTRACT(DAY FROM (r.month_start + INTERVAL '1 month - 1 day')), 2) AS capacity_hours,
  COALESCE(r.labor_hours, 0)        AS labor_hours,
  COALESCE(r.machine_hours, 0)      AS machine_hours,
  ROUND(COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0), 2) AS load_hours,
  CASE WHEN COALESCE(wc.capacity_per_day, 0) > 0
       THEN ROUND((COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0))
                  / (wc.capacity_per_day * EXTRACT(DAY FROM (r.month_start + INTERVAL '1 month - 1 day'))) * 100, 2)
       ELSE 0 END                   AS load_rate
FROM (
  SELECT rep.tenant_id,
         rep.work_center_id,
         date_trunc('month', rep.report_date)::date AS month_start,
         SUM(rep.labor_hours)   AS labor_hours,
         SUM(rep.machine_hours) AS machine_hours
    FROM public.erp_production_reports_s_539dcf81_b rep
   WHERE COALESCE(rep.is_deleted, 'n') = 'n'
     AND rep.status = 'confirmed'
     AND rep.work_center_id IS NOT NULL
   GROUP BY rep.tenant_id, rep.work_center_id, date_trunc('month', rep.report_date)::date
) r
LEFT JOIN public.erp_work_centers_s_539dcf81_b wc
  ON wc.id = r.work_center_id AND wc.tenant_id = r.tenant_id AND COALESCE(wc.is_deleted, 'n') = 'n';


-- ============================================================================
-- 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_name    TEXT;
  v_opts    TEXT;
  v_missing TEXT := '';
  v_expect  TEXT[] := ARRAY[
    'vw_erp_production_progress',
    'vw_erp_production_cost',
    'vw_erp_wip_report',
    'vw_erp_capacity_load'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_expect LOOP
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') INTO v_opts
      FROM pg_class c
     WHERE c.relkind = 'v'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = v_name;

    IF v_opts IS NULL THEN
      v_missing := v_missing || format('%s 未创建;', v_name);
      CONTINUE;
    END IF;
    -- 铁律：视图必须 security_invoker，否则会绕过租户 RLS
    IF v_opts NOT ILIKE '%security_invoker=%true%' AND v_opts NOT ILIKE '%security_invoker=true%' THEN
      v_missing := v_missing || format('%s 缺 security_invoker 选项（当前 %s）;', v_name, v_opts);
    END IF;
  END LOOP;

  -- 关键口径必须留在视图定义里，防止后人"优化"掉
  IF (SELECT pg_get_viewdef('public.vw_erp_production_progress'::regclass, TRUE))
     NOT ILIKE '%progress_pct%' THEN
    v_missing := v_missing || 'vw_erp_production_progress 丢了进度百分比;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_production_cost'::regclass, TRUE))
     NOT ILIKE '%overhead_rate%' THEN
    v_missing := v_missing || 'vw_erp_production_cost 丢了制费口径（machine_hours × overhead_rate）;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_production_cost'::regclass, TRUE)) NOT ILIKE '%posted%' THEN
    v_missing := v_missing || 'vw_erp_production_cost 丢了「只算已过账领料/入库」口径;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_wip_report'::regclass, TRUE))
     NOT ILIKE '%ending_wip%' THEN
    v_missing := v_missing || 'vw_erp_wip_report 丢了期末在制;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_capacity_load'::regclass, TRUE))
     NOT ILIKE '%load_rate%' THEN
    v_missing := v_missing || 'vw_erp_capacity_load 丢了负荷率;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_108 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_108 OK：生产进度 / 工单成本 / 在制报表 / 产能负荷 四个 security_invoker 视图已就绪';
END;
$$;
