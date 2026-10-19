-- ============================================================================
-- deploy_139 员工工作负荷视图（3D 工厂人员详情面板）
-- ============================================================================
-- 需求：3D 工厂点击「人员」场景对象，除基本信息/当前排班/所在工单工序外，
--       还要显示该员工的「工作负荷」。
--
-- 口径（与 deploy_119 的 vw_erp_capacity_load「工作中心产能负荷」完全对齐，
--       仅把粒度从「工作中心」换成「员工」）：
--   分子 load_hours   = 该员工当月 status='confirmed' 报工的
--                       (labor_hours + machine_hours)
--   分母 capacity_hours = 该员工班次 net_hours × 当月工作日数
--   load_rate          = load_hours / capacity_hours × 100
--
--   · 报工归属：erp_production_reports.operator_id → erp_employees.id
--   · 排班：erp_employees.shift_id → erp_shifts.net_hours（仅启用班次）
--   · 工作日数：复用租户默认+启用的 erp_work_calendars，含例外日；
--     无日历退化（cal.id IS NULL）按自然日计，与产能负荷视图一致。
-- ============================================================================

CREATE OR REPLACE VIEW public.vw_erp_employee_load
  WITH (security_invoker = true) AS
WITH report_load AS (
  SELECT rep.tenant_id,
         rep.operator_id                       AS employee_id,
         DATE_TRUNC('month', rep.report_date)::date AS month_start,
         SUM(rep.labor_hours)                  AS labor_hours,
         SUM(rep.machine_hours)                AS machine_hours
    FROM public.erp_production_reports_s_539dcf81_b rep
   WHERE COALESCE(rep.is_deleted, 'n') = 'n'
     AND rep.status = 'confirmed'
     AND rep.operator_id IS NOT NULL
   GROUP BY rep.tenant_id, rep.operator_id,
            DATE_TRUNC('month', rep.report_date)::date
)
SELECT
  r.tenant_id,
  r.employee_id,
  e.code                                        AS employee_code,
  e.name                                        AS employee_name,
  e.shift_id,
  sh.shift_name,
  COALESCE(sh.net_hours, 0)                     AS shift_net_hours,
  r.month_start,
  COALESCE(r.labor_hours, 0)                    AS labor_hours,
  COALESCE(r.machine_hours, 0)                  AS machine_hours,
  ROUND(COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0), 2)
                                                AS load_hours,
  ROUND(COALESCE(sh.net_hours, 0) * COALESCE(wd.work_day_count, 0), 2)
                                                AS capacity_hours,
  CASE
    WHEN COALESCE(sh.net_hours, 0) * COALESCE(wd.work_day_count, 0) > 0
    THEN ROUND(
      (COALESCE(r.labor_hours, 0) + COALESCE(r.machine_hours, 0))
      / (sh.net_hours * wd.work_day_count) * 100, 2)
    ELSE 0
  END                                           AS load_rate,
  COALESCE(wd.work_day_count, 0)                AS work_day_count
FROM report_load r
JOIN public.erp_employees_s_539dcf81_b e
  ON e.id = r.employee_id
 AND e.tenant_id = r.tenant_id
 AND COALESCE(e.is_deleted, 'n') = 'n'
-- 只认启用中的班次：停用班次不贡献可用工时
LEFT JOIN public.erp_shifts_s_539dcf81_b sh
  ON sh.id = e.shift_id
 AND sh.tenant_id = e.tenant_id
 AND COALESCE(sh.is_deleted, 'n') = 'n'
 AND sh.is_active
-- 「默认 + 启用」的日历每租户至多一个（deploy_114 的部分唯一索引）
LEFT JOIN LATERAL (
  SELECT c.id, c.work_days
    FROM public.erp_work_calendars_s_539dcf81_b c
   WHERE c.tenant_id = r.tenant_id
     AND COALESCE(c.is_deleted, 'n') = 'n'
     AND c.is_default
     AND c.is_active
   LIMIT 1
) cal ON TRUE
-- 当月工作日数。⚠️ 无日历时退化「当月全部天数」，同产能负荷视图。
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

COMMENT ON VIEW public.vw_erp_employee_load IS
  '员工×月的工作负荷。负荷 = 该员工当月 confirmed 报工的(人工工时+机器工时)；可用 = 班次净工时 × 当月工作日数（按租户默认启用日历扣非工作日；无日历退化为自然日）。粒度对齐 vw_erp_capacity_load，仅把工作中心换成员工。';

-- 权限：与其余 RLS 视图一致，仅 SELECT
GRANT SELECT ON public.vw_erp_employee_load TO authenticated;
