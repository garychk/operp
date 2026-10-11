-- ============================================================================
-- P0-3：标准成本卷算 + 成本差异分析（RPC 与视图）
-- ============================================================================
--
-- 承接 deploy_111 的两张标准成本表，这一层解决三件事：
--   ① rollup_standard_cost     从 BOM + 工艺路线卷算标准成本（含材料明细）
--   ② vw_erp_cost_variance     工单维度：标准 vs 实际（料/工/费），差异与差异率
--   ③ vw_erp_material_cost_variance
--                              工单 × 物料维度：材料**价差 / 量差**分解
--
-- ---------------------------------------------------------------------------
-- 差异公式（经典标准成本法，写死在这里避免"口径漂移"）
-- ---------------------------------------------------------------------------
--   标准材料成本 = 单位标准材料成本 × 完工数量
--   实际材料成本 = 该工单已过账领料明细的 amount 合计
--   材料总差异   = 实际 − 标准
--
--   价差（价格差异）=（实际单价 − 标准单价）× 实际用量
--   量差（用量差异）=（实际用量 − 标准用量）× 标准单价
--   两者之和恒等于 实际金额 − 标准金额（代数上恒等，见自检断言）
--
--   人工差异   = 实际人工 − 标准人工（单位标准人工 × 完工数量）
--   制费差异   = 实际制费 − 标准制费（单位标准制费 × 完工数量）
--   差异率     = 总差异 / 标准总成本 × 100
--
-- ---------------------------------------------------------------------------
-- 关键口径（写进注释，防止后人"优化"掉）
-- ---------------------------------------------------------------------------
-- 1. 匹配哪个标准成本：**active 且 effective_date ≤ 工单日期**，取 effective_date
--    最新的那一版。差异是"跟当时生效的基准比"，不是"跟今天的基准比"。
-- 2. 没设标准成本的工单：`has_standard_cost = false`，差异列一律 **0**，
--    不把实际成本当成"全部差异"（那是假差异，会把报表打成一片红）。
-- 3. 实际成本口径与 deploy_108 的 vw_erp_production_cost **完全一致**：
--    材料 = 已过账领料明细 amount；人工 = 已确认报工 labor_hours × 工作中心
--    labor_rate；制费 = 已确认报工 machine_hours × overhead_rate。
--    草稿报工、未过账领料不计入（否则误录会污染差异）。
-- 4. 完工数量 = 该工单**已过账**完工入库 quantity 合计（库存流水是唯一事实源）。
-- 5. 明细行只展开 BOM **第一层**：子件的 `cost_price` 就是它的标准价，
--    所以半成品不需要再往下拆；多层展开会把半成品的加工费漏算成材料费。
--
-- 依赖：deploy_111（标准成本表）、deploy_108（实际成本口径）、
--       deploy_01（BOM / 工艺路线 / 工作中心）。
-- 本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================


-- ============================================================================
-- ① 从 BOM + 工艺路线卷算标准成本
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rollup_standard_cost(
  p_product_id     INTEGER,
  p_bom_id         INTEGER DEFAULT NULL,
  p_routing_id     INTEGER DEFAULT NULL,
  p_version        TEXT    DEFAULT 'V1',
  p_effective_date DATE    DEFAULT NULL,
  p_tenant_id      BIGINT  DEFAULT NULL,
  p_actor_id       INTEGER DEFAULT NULL,
  p_overwrite      BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant   BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  v_version  TEXT   := COALESCE(NULLIF(BTRIM(p_version), ''), 'V1');
  v_eff      DATE   := COALESCE(p_effective_date, CURRENT_DATE);
  v_bom      INTEGER := p_bom_id;
  v_routing  INTEGER := p_routing_id;
  v_std_id   INTEGER;
  v_status   TEXT;
  v_mat      NUMERIC(18, 6) := 0;
  v_lab      NUMERIC(18, 6) := 0;
  v_ovh      NUMERIC(18, 6) := 0;
  v_lines    INTEGER := 0;
BEGIN
  IF v_tenant IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'rollup_standard_cost 需要 product_id，且必须能解析出当前租户'
      USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.erp_products_s_539dcf81_b p
     WHERE p.id = p_product_id AND p.tenant_id = v_tenant
       AND COALESCE(p.is_deleted, 'n') = 'n'
  ) THEN
    RAISE EXCEPTION '物料 % 不存在或不属于当前租户', p_product_id USING ERRCODE = 'P0002';
  END IF;

  -- 未指定 BOM 时按「默认优先 → 生效日期最新 → id 最大」挑一张
  IF v_bom IS NULL THEN
    SELECT b.id INTO v_bom
      FROM public.erp_boms_s_539dcf81_b b
     WHERE b.tenant_id = v_tenant AND b.product_id = p_product_id
       AND COALESCE(b.is_deleted, 'n') = 'n'
       AND COALESCE(b.is_active, TRUE)
       AND (b.effective_date IS NULL OR b.effective_date <= v_eff)
       AND (b.expiry_date IS NULL OR b.expiry_date >= v_eff)
     ORDER BY COALESCE(b.is_default, FALSE) DESC NULLS LAST,
              b.effective_date DESC NULLS LAST, b.id DESC
     LIMIT 1;
  END IF;

  IF v_bom IS NULL THEN
    RAISE EXCEPTION '物料 % 没有可用 BOM，无法卷算标准成本（请先维护 BOM 或改用手工录入）',
      p_product_id USING ERRCODE = 'P0002';
  END IF;

  -- 未指定工艺路线时按同样规则挑一条（挑不到不报错：允许只算材料成本）
  IF v_routing IS NULL THEN
    SELECT rt.id INTO v_routing
      FROM public.erp_routing_operations_s_539dcf81_b rt
     WHERE rt.tenant_id = v_tenant AND rt.product_id = p_product_id
       AND COALESCE(rt.is_deleted, 'n') = 'n'
       AND COALESCE(rt.is_active, TRUE)
       AND (rt.effective_date IS NULL OR rt.effective_date <= v_eff)
       AND (rt.expiry_date IS NULL OR rt.expiry_date >= v_eff)
     ORDER BY COALESCE(rt.is_default, FALSE) DESC NULLS LAST,
              rt.effective_date DESC NULLS LAST, rt.id DESC
     LIMIT 1;
  END IF;

  -- 目标行：同产品同版本
  SELECT sc.id, sc.status INTO v_std_id, v_status
    FROM public.erp_standard_costs_s_539dcf81_b sc
   WHERE sc.tenant_id = v_tenant AND sc.product_id = p_product_id
     AND sc.version = v_version AND COALESCE(sc.is_deleted, 'n') = 'n';

  -- 生效版本是绩效基准，默认不许覆盖（否则上月差异会被今天改写，审计不可复现）
  IF v_std_id IS NOT NULL AND v_status = 'active' AND NOT p_overwrite THEN
    RAISE EXCEPTION '版本 % 已生效，不能直接覆盖。请新建版本，或先停用该版本再卷算。', v_version
      USING ERRCODE = '23514';
  END IF;

  IF v_std_id IS NULL THEN
    INSERT INTO public.erp_standard_costs_s_539dcf81_b (
      standard_cost_no, product_id, version, effective_date, status,
      bom_id, routing_id, source, created_by, tenant_id
    ) VALUES (
      -- 编号走统一规则；拿不到号就报错（不降级成时间戳编号）
      public.generate_document_no_for_tenant('standard_cost', v_eff, v_tenant),
      p_product_id, v_version, v_eff, 'draft',
      v_bom, v_routing, 'bom_rollup', p_actor_id, v_tenant
    ) RETURNING id INTO v_std_id;
  ELSE
    UPDATE public.erp_standard_costs_s_539dcf81_b
       SET effective_date = v_eff,
           bom_id         = v_bom,
           routing_id     = v_routing,
           source         = 'bom_rollup',
           updated_at     = NOW()
     WHERE id = v_std_id AND tenant_id = v_tenant;
  END IF;

  -- 旧明细软删（不硬删：历史明细仍在，便于事后审计"这一版当时按什么算的"）
  UPDATE public.erp_standard_cost_materials_s_539dcf81_b
     SET is_deleted = 'y', updated_at = NOW()
   WHERE standard_cost_id = v_std_id AND tenant_id = v_tenant
     AND COALESCE(is_deleted, 'n') = 'n';

  -- 材料明细：BOM 第一层，标准用量**已含损耗**，标准价取物料 cost_price
  INSERT INTO public.erp_standard_cost_materials_s_539dcf81_b (
    standard_cost_id, line_no, material_id, standard_quantity, loss_rate,
    standard_price, tenant_id
  )
  SELECT
    v_std_id,
    COALESCE(bd.line_no, 1),
    bd.material_id,
    ROUND(COALESCE(bd.quantity, 0) * (1 + COALESCE(bd.loss_rate, 0)), 6),
    COALESCE(bd.loss_rate, 0),
    COALESCE(mp.cost_price, 0),
    v_tenant
  FROM public.erp_bom_details_s_539dcf81_b bd
  LEFT JOIN public.erp_products_s_539dcf81_b mp
    ON mp.id = bd.material_id AND mp.tenant_id = v_tenant
   AND COALESCE(mp.is_deleted, 'n') = 'n'
  WHERE bd.bom_id = v_bom AND bd.tenant_id = v_tenant
    AND COALESCE(bd.is_deleted, 'n') = 'n'
    AND bd.material_id IS NOT NULL;

  GET DIAGNOSTICS v_lines = ROW_COUNT;

  SELECT COALESCE(SUM(standard_amount), 0) INTO v_mat
    FROM public.erp_standard_cost_materials_s_539dcf81_b
   WHERE standard_cost_id = v_std_id AND tenant_id = v_tenant
     AND COALESCE(is_deleted, 'n') = 'n';

  -- 人工 / 制费：工艺路线明细的 standard_hours × 费率（明细费率优先，其次工序主数据）
  IF v_routing IS NOT NULL THEN
    SELECT
      COALESCE(SUM(COALESCE(rd.standard_hours, 0)
                   * COALESCE(rd.labor_rate, op.labor_rate, 0)), 0),
      COALESCE(SUM(COALESCE(rd.standard_hours, 0)
                   * COALESCE(rd.overhead_rate, op.overhead_rate, 0)), 0)
      INTO v_lab, v_ovh
      FROM public.erp_routing_operation_details_s_539dcf81_b rd
      LEFT JOIN public.erp_operations_s_539dcf81_b op
        ON op.id = rd.operation_id AND op.tenant_id = v_tenant
       AND COALESCE(op.is_deleted, 'n') = 'n'
     WHERE rd.routing_id = v_routing AND rd.tenant_id = v_tenant
       AND COALESCE(rd.is_deleted, 'n') = 'n';
  END IF;

  UPDATE public.erp_standard_costs_s_539dcf81_b
     SET standard_material_cost = ROUND(v_mat, 6),
         standard_labor_cost    = ROUND(v_lab, 6),
         standard_overhead_cost = ROUND(v_ovh, 6),
         updated_at             = NOW()
   WHERE id = v_std_id AND tenant_id = v_tenant;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'standard_cost_id', v_std_id,
    'product_id', p_product_id,
    'version', v_version,
    'bom_id', v_bom,
    'routing_id', v_routing,
    'standard_material_cost', ROUND(v_mat, 6),
    'standard_labor_cost', ROUND(v_lab, 6),
    'standard_overhead_cost', ROUND(v_ovh, 6),
    'material_line_count', v_lines
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rollup_standard_cost(
  INTEGER, INTEGER, INTEGER, TEXT, DATE, BIGINT, INTEGER, BOOLEAN
) TO authenticated;

COMMENT ON FUNCTION public.rollup_standard_cost(
  INTEGER, INTEGER, INTEGER, TEXT, DATE, BIGINT, INTEGER, BOOLEAN
) IS
  '从 BOM（材料，标准价取 erp_products.cost_price）+ 工艺路线（工时 × 费率）卷算标准成本，'
  '写入 erp_standard_costs 及其材料明细。拒绝覆盖已生效（active）版本。';


-- ============================================================================
-- ② 工单成本差异表（标准 vs 实际）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_cost_variance
  WITH (security_invoker = true) AS
WITH ord AS (
  SELECT
    o.tenant_id,
    o.id                                   AS order_id,
    o.order_no,
    o.order_date,
    o.status                               AS order_status,
    o.product_id,
    EXTRACT(YEAR  FROM o.order_date)::int  AS period_year,
    EXTRACT(MONTH FROM o.order_date)::int  AS period_month,
    COALESCE(rcv.received_quantity, 0)     AS completed_quantity,
    COALESCE(mat.material_cost, 0)         AS actual_material,
    COALESCE(lab.labor_cost, 0)            AS actual_labor,
    COALESCE(lab.overhead_cost, 0)         AS actual_overhead,
    sc.id                                  AS standard_cost_id,
    sc.version                             AS standard_version,
    sc.standard_material_cost,
    sc.standard_labor_cost,
    sc.standard_overhead_cost,
    sc.standard_total_cost
  FROM public.erp_production_orders_s_539dcf81_b o
  LEFT JOIN (
    SELECT r.tenant_id, r.production_order_id, SUM(r.quantity) AS received_quantity
      FROM public.erp_production_receipts_s_539dcf81_b r
     WHERE COALESCE(r.is_deleted, 'n') = 'n' AND r.status = 'posted'
     GROUP BY r.tenant_id, r.production_order_id
  ) rcv ON rcv.production_order_id = o.id AND rcv.tenant_id = o.tenant_id
  LEFT JOIN (
    SELECT mi.tenant_id, mi.production_order_id, SUM(mid.amount) AS material_cost
      FROM public.erp_material_issues_s_539dcf81_b mi
      JOIN public.erp_material_issue_details_s_539dcf81_b mid
        ON mid.issue_id = mi.id AND mid.tenant_id = mi.tenant_id
       AND COALESCE(mid.is_deleted, 'n') = 'n'
     WHERE COALESCE(mi.is_deleted, 'n') = 'n' AND mi.status = 'posted'
       AND mi.production_order_id IS NOT NULL
     GROUP BY mi.tenant_id, mi.production_order_id
  ) mat ON mat.production_order_id = o.id AND mat.tenant_id = o.tenant_id
  LEFT JOIN (
    SELECT r.tenant_id, r.production_order_id,
           SUM(r.labor_hours   * COALESCE(wc.labor_rate, 0))    AS labor_cost,
           SUM(r.machine_hours * COALESCE(wc.overhead_rate, 0)) AS overhead_cost
      FROM public.erp_production_reports_s_539dcf81_b r
      LEFT JOIN public.erp_work_centers_s_539dcf81_b wc
        ON wc.id = r.work_center_id AND wc.tenant_id = r.tenant_id
       AND COALESCE(wc.is_deleted, 'n') = 'n'
     WHERE COALESCE(r.is_deleted, 'n') = 'n' AND r.status = 'confirmed'
       AND r.production_order_id IS NOT NULL
     GROUP BY r.tenant_id, r.production_order_id
  ) lab ON lab.production_order_id = o.id AND lab.tenant_id = o.tenant_id
  -- 基准：active 且 effective_date ≤ 工单日期的最新版本
  LEFT JOIN LATERAL (
    SELECT s.id, s.version, s.standard_material_cost, s.standard_labor_cost,
           s.standard_overhead_cost, s.standard_total_cost
      FROM public.erp_standard_costs_s_539dcf81_b s
     WHERE s.tenant_id = o.tenant_id
       AND s.product_id = o.product_id
       AND COALESCE(s.is_deleted, 'n') = 'n'
       AND s.status = 'active'
       AND s.effective_date <= o.order_date
     ORDER BY s.effective_date DESC, s.id DESC
     LIMIT 1
  ) sc ON TRUE
  WHERE COALESCE(o.is_deleted, 'n') = 'n'
)
SELECT
  d.tenant_id,
  d.order_id,
  d.order_no,
  d.order_date,
  d.order_status,
  d.period_year,
  d.period_month,
  d.product_id,
  pr.code                                            AS product_code,
  pr.name                                            AS product_name,
  pr.unit,
  d.completed_quantity,
  (d.standard_cost_id IS NOT NULL)                   AS has_standard_cost,
  d.standard_cost_id,
  d.standard_version,
  ROUND(COALESCE(d.standard_material_cost, 0) * d.completed_quantity, 6) AS standard_material,
  ROUND(COALESCE(d.standard_labor_cost, 0)    * d.completed_quantity, 6) AS standard_labor,
  ROUND(COALESCE(d.standard_overhead_cost, 0) * d.completed_quantity, 6) AS standard_overhead,
  ROUND(COALESCE(d.standard_total_cost, 0)    * d.completed_quantity, 6) AS standard_total,
  d.actual_material,
  d.actual_labor,
  d.actual_overhead,
  ROUND(d.actual_material + d.actual_labor + d.actual_overhead, 6)       AS actual_total,
  -- 未设标准成本的工单：差异一律 0（把实际成本当差异会把报表打成一片红）
  CASE WHEN d.standard_cost_id IS NULL THEN 0
       ELSE ROUND(d.actual_material - COALESCE(d.standard_material_cost, 0) * d.completed_quantity, 6)
  END                                                                     AS material_variance,
  CASE WHEN d.standard_cost_id IS NULL THEN 0
       ELSE ROUND(d.actual_labor - COALESCE(d.standard_labor_cost, 0) * d.completed_quantity, 6)
  END                                                                     AS labor_variance,
  CASE WHEN d.standard_cost_id IS NULL THEN 0
       ELSE ROUND(d.actual_overhead - COALESCE(d.standard_overhead_cost, 0) * d.completed_quantity, 6)
  END                                                                     AS overhead_variance,
  CASE WHEN d.standard_cost_id IS NULL THEN 0
       ELSE ROUND((d.actual_material + d.actual_labor + d.actual_overhead)
                  - COALESCE(d.standard_total_cost, 0) * d.completed_quantity, 6)
  END                                                                     AS total_variance,
  CASE WHEN d.standard_cost_id IS NULL
         OR COALESCE(d.standard_total_cost, 0) * d.completed_quantity = 0 THEN 0
       ELSE ROUND(((d.actual_material + d.actual_labor + d.actual_overhead)
                   - d.standard_total_cost * d.completed_quantity)
                  / (d.standard_total_cost * d.completed_quantity) * 100, 4)
  END                                                                     AS total_variance_rate
FROM ord d
LEFT JOIN public.erp_products_s_539dcf81_b pr
  ON pr.id = d.product_id AND pr.tenant_id = d.tenant_id
 AND COALESCE(pr.is_deleted, 'n') = 'n'
WHERE d.completed_quantity <> 0
   OR d.actual_material <> 0
   OR d.actual_labor <> 0
   OR d.actual_overhead <> 0;

COMMENT ON VIEW public.vw_erp_cost_variance IS
  '工单成本差异表：标准成本（active 且生效日 ≤ 工单日期）vs 实际（料/工/费），'
  '差异 = 实际 − 标准；未设标准成本的工单 has_standard_cost=false 且差异为 0。';


-- ============================================================================
-- ③ 材料价差 / 量差明细（工单 × 物料）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_material_cost_variance
  WITH (security_invoker = true) AS
WITH ord AS (
  SELECT
    o.tenant_id,
    o.id                               AS order_id,
    o.order_no,
    o.order_date,
    o.product_id,
    COALESCE(rcv.received_quantity, 0) AS completed_quantity,
    sc.id                              AS standard_cost_id
  FROM public.erp_production_orders_s_539dcf81_b o
  LEFT JOIN (
    SELECT r.tenant_id, r.production_order_id, SUM(r.quantity) AS received_quantity
      FROM public.erp_production_receipts_s_539dcf81_b r
     WHERE COALESCE(r.is_deleted, 'n') = 'n' AND r.status = 'posted'
     GROUP BY r.tenant_id, r.production_order_id
  ) rcv ON rcv.production_order_id = o.id AND rcv.tenant_id = o.tenant_id
  LEFT JOIN LATERAL (
    SELECT s.id
      FROM public.erp_standard_costs_s_539dcf81_b s
     WHERE s.tenant_id = o.tenant_id
       AND s.product_id = o.product_id
       AND COALESCE(s.is_deleted, 'n') = 'n'
       AND s.status = 'active'
       AND s.effective_date <= o.order_date
     ORDER BY s.effective_date DESC, s.id DESC
     LIMIT 1
  ) sc ON TRUE
  WHERE COALESCE(o.is_deleted, 'n') = 'n'
),
std AS (
  SELECT d.tenant_id,
         d.order_id,
         m.material_id,
         ROUND(m.standard_quantity * d.completed_quantity, 6) AS standard_quantity,
         m.standard_price                                     AS standard_price
    FROM ord d
    JOIN public.erp_standard_cost_materials_s_539dcf81_b m
      ON m.standard_cost_id = d.standard_cost_id
     AND m.tenant_id = d.tenant_id
     AND COALESCE(m.is_deleted, 'n') = 'n'
   WHERE d.standard_cost_id IS NOT NULL
),
act AS (
  SELECT mi.tenant_id,
         mi.production_order_id AS order_id,
         mid.material_id,
         ROUND(SUM(COALESCE(mid.quantity, 0)), 6) AS actual_quantity,
         ROUND(SUM(COALESCE(mid.amount, 0)), 6)   AS actual_amount
    FROM public.erp_material_issues_s_539dcf81_b mi
    JOIN public.erp_material_issue_details_s_539dcf81_b mid
      ON mid.issue_id = mi.id AND mid.tenant_id = mi.tenant_id
     AND COALESCE(mid.is_deleted, 'n') = 'n'
   WHERE COALESCE(mi.is_deleted, 'n') = 'n'
     AND mi.status = 'posted'
     AND mi.production_order_id IS NOT NULL
   GROUP BY mi.tenant_id, mi.production_order_id, mid.material_id
),
keys AS (
  SELECT tenant_id, order_id, material_id FROM std
  UNION
  SELECT tenant_id, order_id, material_id FROM act
)
SELECT
  d.tenant_id,
  k.order_id,
  d.order_no,
  d.order_date,
  d.product_id,
  k.material_id,
  p.code                                                       AS material_code,
  p.name                                                       AS material_name,
  p.unit,
  COALESCE(s.standard_quantity, 0)                             AS standard_quantity,
  COALESCE(s.standard_price, 0)                                AS standard_price,
  ROUND(COALESCE(s.standard_quantity, 0) * COALESCE(s.standard_price, 0), 6) AS standard_amount,
  COALESCE(a.actual_quantity, 0)                               AS actual_quantity,
  COALESCE(a.actual_amount, 0)                                 AS actual_amount,
  CASE WHEN COALESCE(a.actual_quantity, 0) <> 0
       THEN ROUND(a.actual_amount / a.actual_quantity, 6) ELSE 0 END AS actual_price,
  -- 价差 =（实际单价 − 标准单价）× 实际用量
  ROUND((CASE WHEN COALESCE(a.actual_quantity, 0) <> 0
              THEN a.actual_amount / a.actual_quantity ELSE 0 END
         - COALESCE(s.standard_price, 0)) * COALESCE(a.actual_quantity, 0), 6) AS price_variance,
  -- 量差 =（实际用量 − 标准用量）× 标准单价
  ROUND((COALESCE(a.actual_quantity, 0) - COALESCE(s.standard_quantity, 0))
        * COALESCE(s.standard_price, 0), 6)                    AS usage_variance,
  -- 合计 = 实际金额 − 标准金额（恒等于 价差 + 量差）
  ROUND(COALESCE(a.actual_amount, 0)
        - COALESCE(s.standard_quantity, 0) * COALESCE(s.standard_price, 0), 6) AS total_variance
FROM keys k
JOIN ord d
  ON d.order_id = k.order_id AND d.tenant_id = k.tenant_id
LEFT JOIN std s
  ON s.order_id = k.order_id AND s.tenant_id = k.tenant_id AND s.material_id = k.material_id
LEFT JOIN act a
  ON a.order_id = k.order_id AND a.tenant_id = k.tenant_id AND a.material_id = k.material_id
LEFT JOIN public.erp_products_s_539dcf81_b p
  ON p.id = k.material_id AND p.tenant_id = k.tenant_id
 AND COALESCE(p.is_deleted, 'n') = 'n'
-- 只对「有标准成本基准」的工单做分解：没有基准就没有差异可言
WHERE d.standard_cost_id IS NOT NULL
  AND (COALESCE(s.standard_quantity, 0) <> 0 OR COALESCE(a.actual_quantity, 0) <> 0);

COMMENT ON VIEW public.vw_erp_material_cost_variance IS
  '材料成本差异明细（工单 × 物料）：价差 =（实际单价−标准单价）×实际用量；'
  '量差 =（实际用量−标准用量）×标准单价；两者之和 = 实际金额 − 标准金额。';


-- ============================================================================
-- 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_name    TEXT;
  v_opts    TEXT;
  v_missing TEXT := '';
  v_n       INTEGER;
  v_views   CONSTANT TEXT[] := ARRAY[
    'vw_erp_cost_variance',
    'vw_erp_material_cost_variance'
  ];
BEGIN
  -- 1. 视图存在 + security_invoker（铁律：视图不得绕过租户 RLS）
  FOREACH v_name IN ARRAY v_views LOOP
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') INTO v_opts
      FROM pg_class c
     WHERE c.relkind = 'v' AND c.relnamespace = 'public'::regnamespace
       AND c.relname = v_name;

    IF v_opts IS NULL THEN
      v_missing := v_missing || format('%s 未创建;', v_name);
      CONTINUE;
    END IF;
    IF v_opts NOT ILIKE '%security_invoker=%true%' AND v_opts NOT ILIKE '%security_invoker=true%' THEN
      v_missing := v_missing || format('%s 缺 security_invoker 选项（当前 %s）;', v_name, v_opts);
    END IF;
  END LOOP;

  -- 2. 关键口径必须留在视图定义里
  IF (SELECT pg_get_viewdef('public.vw_erp_cost_variance'::regclass, TRUE))
     NOT ILIKE '%standard_total_cost%' THEN
    v_missing := v_missing || 'vw_erp_cost_variance 丢了标准成本基准;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_cost_variance'::regclass, TRUE))
     NOT ILIKE '%status%''active''%' AND (SELECT pg_get_viewdef('public.vw_erp_cost_variance'::regclass, TRUE))
     NOT ILIKE '%''active''%' THEN
    v_missing := v_missing || 'vw_erp_cost_variance 丢了「只匹配 active 版本」口径;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_material_cost_variance'::regclass, TRUE))
     NOT ILIKE '%price_variance%' THEN
    v_missing := v_missing || 'vw_erp_material_cost_variance 丢了价差;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_material_cost_variance'::regclass, TRUE))
     NOT ILIKE '%usage_variance%' THEN
    v_missing := v_missing || 'vw_erp_material_cost_variance 丢了量差;';
  END IF;

  -- 3. 卷算函数存在且有 authenticated 执行权
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rollup_standard_cost';
  IF COALESCE(v_n, 0) <> 1 THEN
    v_missing := v_missing || 'rollup_standard_cost 未创建;';
  END IF;

  IF NOT has_function_privilege(
       'authenticated',
       'public.rollup_standard_cost(INTEGER, INTEGER, INTEGER, TEXT, DATE, BIGINT, INTEGER, BOOLEAN)',
       'EXECUTE') THEN
    v_missing := v_missing || 'authenticated 无 rollup_standard_cost 执行权;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_112 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_112 OK：标准成本卷算 RPC + 工单成本差异视图 + 材料价差/量差视图已就绪';
END;
$$;
