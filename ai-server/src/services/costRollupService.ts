/**
 * 生产成本卷算服务（阶段 4）。
 *
 * 口径（v1，刻意从简，全部写在注释里以便审计）：
 *   材料成本 = 期间内「已过账」领料单的明细金额合计（erp_material_issue_details.amount，
 *              出库单价是过账时按移动加权算出来的实际成本），按领料单所属生产订单归集到成品。
 *   人工成本 = 期间内「已确认」报工单的 labor_hours × 工作中心 labor_rate。
 *   制造费用 = 期间内「已确认」报工单的 machine_hours × 工作中心 overhead_rate。
 *   完工数量 = 期间内「已过账」完工入库的 quantity 合计。
 *   单位成本 = (期初在制 + 本期投入) / 完工数量   —— 完工数量 > 0 时全额结转，期末在制 = 0；
 *              完工数量 = 0 时单位成本 = 0，本期投入全部留在期末在制。
 *   （刻意不做约当产量：库里没有工序进度口径的数据，硬凑一个分摊系数比全额结转更不可信。）
 *
 * ⚠️ 报工单只在 status='confirmed' 时计入成本：这是报工页「确认」动作的意义所在，
 *    草稿报工不参与卷算（避免误录工时污染成本）。
 *
 * 与 MRP 引擎同样的边界：计算全部是确定性算术，不做任何推测性数字。
 */
import { supabase } from "../config/supabase.js";

const T = {
  periods: "erp_accounting_periods_s_539dcf81_b",
  costCalculations: "erp_cost_calculations_s_539dcf81_b",
  materialIssues: "erp_material_issues_s_539dcf81_b",
  materialIssueDetails: "erp_material_issue_details_s_539dcf81_b",
  productionOrders: "erp_production_orders_s_539dcf81_b",
  productionReceipts: "erp_production_receipts_s_539dcf81_b",
  productionReports: "erp_production_reports_s_539dcf81_b",
  workCenters: "erp_work_centers_s_539dcf81_b",
  products: "erp_products_s_539dcf81_b",
} as const;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const asRows = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []) as Record<string, unknown>[];

const round4 = (n: number) => Math.round(n * 10000) / 10000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 期间首末日（自然月） */
function periodRange(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start, end: `${year}-${pad2(month)}-${pad2(lastDay)}` };
}

/** 上一个自然月 */
function prevMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

export interface CostRow {
  productId: number;
  productCode: string;
  productName: string;
  beginningWip: number;
  currentMaterial: number;
  currentLabor: number;
  currentOverhead: number;
  totalCost: number;
  finishedQuantity: number;
  unitCost: number;
  endingWip: number;
}

export interface CostRollupOutcome {
  periodId: number;
  year: number;
  month: number;
  periodStart: string;
  periodEnd: string;
  dryRun: boolean;
  rows: CostRow[];
  totals: {
    material: number;
    labor: number;
    overhead: number;
    total: number;
    finishedQuantity: number;
  };
  warnings: string[];
}

export interface CostRollupOptions {
  dryRun?: boolean;
  productIds?: number[];
}

/** 期间不存在则补一行（成本卷算是按自然月归集，不依赖期间是否已启用） */
async function ensurePeriod(
  tenantId: number,
  year: number,
  month: number,
): Promise<{ id: number; warnings: string[] }> {
  const { data, error } = await supabase
    .from(T.periods)
    .select("id, is_closed, is_locked")
    .eq("tenant_id", tenantId)
    .eq("year", year)
    .eq("month", month)
    .eq("is_deleted", "n")
    .maybeSingle();
  if (error) throw error;

  if (data) {
    const row = data as { id?: unknown; is_closed?: unknown; is_locked?: unknown };
    const warnings: string[] = [];
    if (row.is_closed === true) warnings.push(`period_closed:${year}-${pad2(month)}`);
    if (row.is_locked === true) warnings.push(`period_locked:${year}-${pad2(month)}`);
    return { id: num(row.id), warnings };
  }

  const { start, end } = periodRange(year, month);
  const { data: created, error: insErr } = await supabase
    .from(T.periods)
    .insert({
      year,
      month,
      start_date: start,
      end_date: end,
      is_enabled: false,
      is_closed: false,
      is_locked: false,
      tenant_id: tenantId,
      is_deleted: "n",
    })
    .select("id")
    .single();
  if (insErr) throw insErr;

  return { id: num((created as { id?: unknown } | null)?.id), warnings: ["period_auto_created"] };
}

/** 期初在制：上一期间同产品的期末在制 */
async function loadBeginningWip(
  tenantId: number,
  year: number,
  month: number,
): Promise<Map<number, number>> {
  const prev = prevMonth(year, month);
  const { data: prevPeriod, error: ppErr } = await supabase
    .from(T.periods)
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("year", prev.year)
    .eq("month", prev.month)
    .eq("is_deleted", "n")
    .maybeSingle();
  if (ppErr) throw ppErr;

  const map = new Map<number, number>();
  const prevId = num((prevPeriod as { id?: unknown } | null)?.id);
  if (!prevId) return map;

  const { data, error } = await supabase
    .from(T.costCalculations)
    .select("product_id, ending_wip")
    .eq("tenant_id", tenantId)
    .eq("period_id", prevId)
    .eq("is_deleted", "n");
  if (error) throw error;

  for (const row of asRows(data)) {
    map.set(num(row.product_id), num(row.ending_wip));
  }
  return map;
}

export async function rollupProductionCost(
  tenantId: number,
  year: number,
  month: number,
  options: CostRollupOptions = {},
): Promise<CostRollupOutcome> {
  const dryRun = options.dryRun === true;
  const warnings: string[] = [];

  const period = await ensurePeriod(tenantId, year, month);
  const periodId = period.id;
  warnings.push(...period.warnings);

  const { start, end } = periodRange(year, month);

  // ---- 1. 材料：已过账领料（期间内）→ 归集到生产订单的成品 ----
  const { data: issueData, error: issueErr } = await supabase
    .from(T.materialIssues)
    .select("id, production_order_id, total_amount")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .eq("status", "posted")
    .gte("issue_date", start)
    .lte("issue_date", end);
  if (issueErr) throw issueErr;

  const issues = asRows(issueData);
  const orderIdByIssue = new Map<number, number>();
  for (const issue of issues) {
    orderIdByIssue.set(num(issue.id), num(issue.production_order_id));
  }

  const materialByOrder = new Map<number, number>();
  if (issues.length > 0) {
    const { data: detailData, error: detailErr } = await supabase
      .from(T.materialIssueDetails)
      .select("issue_id, amount")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in(
        "issue_id",
        issues.map((i) => num(i.id)),
      );
    if (detailErr) throw detailErr;

    for (const detail of asRows(detailData)) {
      const orderId = orderIdByIssue.get(num(detail.issue_id)) ?? 0;
      if (!orderId) continue; // 未关联生产订单的领料：无法归集到产品，跳过
      materialByOrder.set(orderId, round4((materialByOrder.get(orderId) ?? 0) + num(detail.amount)));
    }
  }

  // ---- 2. 人工/制造费用：已确认报工（期间内）× 工作中心费率 ----
  const { data: reportData, error: reportErr } = await supabase
    .from(T.productionReports)
    .select("production_order_id, labor_hours, machine_hours, work_center_id")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .eq("status", "confirmed")
    .gte("report_date", start)
    .lte("report_date", end);
  if (reportErr) throw reportErr;

  const reports = asRows(reportData);
  const rateByCenter = new Map<number, { labor: number; overhead: number }>();
  const centerIds = Array.from(
    new Set(reports.map((r) => num(r.work_center_id)).filter((id) => id > 0)),
  );
  if (centerIds.length > 0) {
    const { data: centerData, error: centerErr } = await supabase
      .from(T.workCenters)
      .select("id, labor_rate, overhead_rate")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", centerIds);
    if (centerErr) throw centerErr;
    for (const center of asRows(centerData)) {
      rateByCenter.set(num(center.id), {
        labor: num(center.labor_rate),
        overhead: num(center.overhead_rate),
      });
    }
  }

  const laborByOrder = new Map<number, number>();
  const overheadByOrder = new Map<number, number>();
  let missingCenter = 0;
  for (const report of reports) {
    const orderId = num(report.production_order_id);
    if (!orderId) continue; // 报工未挂订单：无法归集，跳过
    const rates = rateByCenter.get(num(report.work_center_id));
    if (!rates) {
      missingCenter += 1;
      continue;
    }
    laborByOrder.set(
      orderId,
      round4((laborByOrder.get(orderId) ?? 0) + num(report.labor_hours) * rates.labor),
    );
    overheadByOrder.set(
      orderId,
      round4((overheadByOrder.get(orderId) ?? 0) + num(report.machine_hours) * rates.overhead),
    );
  }
  if (missingCenter > 0) {
    warnings.push(`report_without_work_center_rate:${missingCenter}`);
  }

  // ---- 3. 完工数量：已过账完工入库（期间内） ----
  const { data: receiptData, error: receiptErr } = await supabase
    .from(T.productionReceipts)
    .select("product_id, quantity")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .eq("status", "posted")
    .gte("receipt_date", start)
    .lte("receipt_date", end);
  if (receiptErr) throw receiptErr;

  const finishedByProduct = new Map<number, number>();
  for (const receipt of asRows(receiptData)) {
    const productId = num(receipt.product_id);
    if (!productId) continue;
    finishedByProduct.set(
      productId,
      round4((finishedByProduct.get(productId) ?? 0) + num(receipt.quantity)),
    );
  }

  // ---- 4. 订单 → 成品映射（材料与人工都先归集到订单） ----
  const orderIds = Array.from(
    new Set([
      ...materialByOrder.keys(),
      ...laborByOrder.keys(),
      ...overheadByOrder.keys(),
    ]),
  );

  const productIdByOrder = new Map<number, number>();
  if (orderIds.length > 0) {
    const { data: orderData, error: orderErr } = await supabase
      .from(T.productionOrders)
      .select("id, product_id")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", orderIds);
    if (orderErr) throw orderErr;
    for (const order of asRows(orderData)) {
      productIdByOrder.set(num(order.id), num(order.product_id));
    }
  }

  // ---- 5. 按产品汇总 ----
  const productIds = new Set<number>();
  for (const orderId of orderIds) {
    const pid = productIdByOrder.get(orderId);
    if (pid) productIds.add(pid);
  }
  for (const pid of finishedByProduct.keys()) productIds.add(pid);

  // ⚠️ 期初在制必须先取：上一期有在制余额的产品，本期即使没有任何业务也要留一行把余额结转下去，
  //    否则「空期间」会把在制余额吞掉 —— 再下一期回头找「上一期」就找不到，余额静默归零。
  const beginningWip = await loadBeginningWip(tenantId, year, month);
  for (const [pid, wip] of beginningWip) {
    if (pid > 0 && wip !== 0) productIds.add(pid);
  }

  if (options.productIds && options.productIds.length > 0) {
    const allowed = new Set(options.productIds);
    for (const pid of Array.from(productIds)) {
      if (!allowed.has(pid)) productIds.delete(pid);
    }
  }

  const metaById = new Map<number, { code: string; name: string }>();
  if (productIds.size > 0) {
    const { data: prodData, error: prodErr } = await supabase
      .from(T.products)
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", Array.from(productIds));
    if (prodErr) throw prodErr;
    for (const p of asRows(prodData)) {
      metaById.set(num(p.id), { code: String(p.code ?? ""), name: String(p.name ?? "") });
    }
  }

  const rows: CostRow[] = [];
  for (const productId of productIds) {
    const currentMaterial = round4(
      Array.from(materialByOrder.entries())
        .filter(([orderId]) => productIdByOrder.get(orderId) === productId)
        .reduce((sum, [, amount]) => sum + amount, 0),
    );
    const currentLabor = round4(
      Array.from(laborByOrder.entries())
        .filter(([orderId]) => productIdByOrder.get(orderId) === productId)
        .reduce((sum, [, amount]) => sum + amount, 0),
    );
    const currentOverhead = round4(
      Array.from(overheadByOrder.entries())
        .filter(([orderId]) => productIdByOrder.get(orderId) === productId)
        .reduce((sum, [, amount]) => sum + amount, 0),
    );

    const beginning = round4(beginningWip.get(productId) ?? 0);
    const totalCost = round4(currentMaterial + currentLabor + currentOverhead);
    const finishedQuantity = round4(finishedByProduct.get(productId) ?? 0);

    let unitCost = 0;
    let endingWip = 0;
    if (finishedQuantity > 0) {
      unitCost = round4((beginning + totalCost) / finishedQuantity);
      endingWip = 0; // 全额结转
    } else {
      unitCost = 0;
      endingWip = round4(beginning + totalCost); // 全留在在制
    }

    const meta = metaById.get(productId);
    rows.push({
      productId,
      productCode: meta?.code ?? String(productId),
      productName: meta?.name ?? "",
      beginningWip: beginning,
      currentMaterial,
      currentLabor,
      currentOverhead,
      totalCost,
      finishedQuantity,
      unitCost,
      endingWip,
    });
  }

  rows.sort((a, b) => a.productId - b.productId);

  // ---- 6. 写回（幂等 upsert：tenant + period + product） ----
  if (!dryRun) {
    for (const row of rows) {
      const payload = {
        period_id: periodId,
        product_id: row.productId,
        beginning_wip: row.beginningWip,
        current_material: row.currentMaterial,
        current_labor: row.currentLabor,
        current_overhead: row.currentOverhead,
        total_cost: row.totalCost,
        finished_quantity: row.finishedQuantity,
        unit_cost: row.unitCost,
        ending_wip: row.endingWip,
        tenant_id: tenantId,
        is_deleted: "n",
        updated_at: new Date().toISOString(),
      };

      const { data: existing, error: findErr } = await supabase
        .from(T.costCalculations)
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("period_id", periodId)
        .eq("product_id", row.productId)
        .eq("is_deleted", "n")
        .maybeSingle();
      if (findErr) throw findErr;

      const existingId = num((existing as { id?: unknown } | null)?.id);
      if (existingId) {
        const { error: upErr } = await supabase
          .from(T.costCalculations)
          .update(payload)
          .eq("id", existingId)
          .eq("tenant_id", tenantId);
        if (upErr) throw upErr;
      } else {
        const { error: insErr } = await supabase.from(T.costCalculations).insert(payload);
        if (insErr) throw insErr;
      }
    }
  }

  const totals = {
    material: round4(rows.reduce((s, r) => s + r.currentMaterial, 0)),
    labor: round4(rows.reduce((s, r) => s + r.currentLabor, 0)),
    overhead: round4(rows.reduce((s, r) => s + r.currentOverhead, 0)),
    total: round4(rows.reduce((s, r) => s + r.totalCost, 0)),
    finishedQuantity: round4(rows.reduce((s, r) => s + r.finishedQuantity, 0)),
  };

  return {
    periodId,
    year,
    month,
    periodStart: start,
    periodEnd: end,
    dryRun,
    rows,
    totals,
    warnings,
  };
}

/** 读取某期间已保存的成本行（成本页列表用；不动数据库） */
export async function loadCostRows(
  tenantId: number,
  year: number,
  month: number,
): Promise<{ periodId: number | null; rows: CostRow[] }> {
  const { data: periodData, error: pErr } = await supabase
    .from(T.periods)
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("year", year)
    .eq("month", month)
    .eq("is_deleted", "n")
    .maybeSingle();
  if (pErr) throw pErr;

  const periodId = num((periodData as { id?: unknown } | null)?.id);
  if (!periodId) return { periodId: null, rows: [] };

  const { data, error } = await supabase
    .from(T.costCalculations)
    .select(
      "product_id, beginning_wip, current_material, current_labor, current_overhead, " +
        "total_cost, finished_quantity, unit_cost, ending_wip",
    )
    .eq("tenant_id", tenantId)
    .eq("period_id", periodId)
    .eq("is_deleted", "n");
  if (error) throw error;

  const costRows = asRows(data);
  const productIds = Array.from(new Set(costRows.map((r) => num(r.product_id))));
  const metaById = new Map<number, { code: string; name: string }>();
  if (productIds.length > 0) {
    const { data: prodData, error: prodErr } = await supabase
      .from(T.products)
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", productIds);
    if (prodErr) throw prodErr;
    for (const p of asRows(prodData)) {
      metaById.set(num(p.id), { code: String(p.code ?? ""), name: String(p.name ?? "") });
    }
  }

  const rows: CostRow[] = costRows.map((r) => ({
    productId: num(r.product_id),
    productCode: metaById.get(num(r.product_id))?.code ?? String(num(r.product_id)),
    productName: metaById.get(num(r.product_id))?.name ?? "",
    beginningWip: num(r.beginning_wip),
    currentMaterial: num(r.current_material),
    currentLabor: num(r.current_labor),
    currentOverhead: num(r.current_overhead),
    totalCost: num(r.total_cost),
    finishedQuantity: num(r.finished_quantity),
    unitCost: num(r.unit_cost),
    endingWip: num(r.ending_wip),
  }));

  rows.sort((a, b) => a.productId - b.productId);
  return { periodId, rows };
}
