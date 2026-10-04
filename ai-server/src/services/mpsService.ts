/**
 * 主生产计划 MPS 服务（阶段 5）。
 *
 * 职责（与 MRP 的分工：MPS 管「计划员的人为决策」，MRP 管「执行层的自动展开」）：
 *   · 计划行汇总视图（预测 / 订单 / MPS / 已下推 / 剩余可下推）
 *   · 确认 / 取消确认（确认后整单锁定，行级锁在 deploy_63 触发器里兜底）
 *   · RCCP 粗能力校验（MPS 量 × 默认工艺路线单件工时 → 工作中心 × 月负荷，纯计算不落表）
 *   · 下推生产订单（一行一张 MO，1:1 最好追溯；台账复用 doc_flow 单据下推基础设施）
 *
 * ⭐ 与 doc_flow 下推引擎的复用关系（刻意不建 doc_flow_rules 规则行）：
 *   doc_flow_generate 是「单头 → 单头」的通用转换（一次生成一张目标单据），
 *   而 MPS 是「一行一个产品 → 一张生产订单」（MO 表头只有一个 product_id），
 *   行级转换与通用引擎形状不匹配。复用的是底层台账：
 *     · doc_flow_ledger_convert —— 记 doc_flow_transfers，自动校验「累计下推 ≤ mps_qty」
 *       （超下推直接报错 = 并发/重复点击的兜底）；
 *     · doc_flow_sync_source_progress —— 自动回写 mps 行的 pushed_quantity。
 *   两者都由 deploy_63 的 doc_flow_source_meta('mps_plan') 元数据驱动。
 *
 * 两条铁律（ai-server 写业务数据的模块必须守住）：
 *   1. service_role 不过 RLS —— 每一次查询、每一笔写入都显式带 tenant_id。
 *   2. 确认锁不允许绕过 —— 行的修改/删除由 DB 触发器拦截，这里只负责「先取消确认」的引导。
 *
 * 刻意不做（v1）：
 *   · forecast_qty 不接入 MRP 需求源（MRP 仍是订单驱动），只做展示 —— 预测与销售订单的
 *     去重策略（组合预测、消耗规则）没有业务输入前硬凑只会误导。
 *   · 不做周/月桶：日桶与 MRP 引擎粒度一致，页面按日期排序即可读。
 *   · RCCP 刻意只按自然日估算月产能（capacity_per_day × 当月天数），与 MRP 提前期的
 *     自然日口径一致；工作日历是后续独立主题。
 */
import { supabase } from "../config/supabase.js";

const T = {
  plans: "erp_mps_plans_s_539dcf81_b",
  details: "erp_mps_plan_details_s_539dcf81_b",
  products: "erp_products_s_539dcf81_b",
  salesOrders: "erp_sales_orders_s_539dcf81_b",
  salesOrderDetails: "erp_sales_order_details_s_539dcf81_b",
  routings: "erp_routing_operations_s_539dcf81_b",
  routingDetails: "erp_routing_operation_details_s_539dcf81_b",
  operations: "erp_operations_s_539dcf81_b",
  workCenters: "erp_work_centers_s_539dcf81_b",
  productionOrders: "erp_production_orders_s_539dcf81_b",
} as const;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const asRows = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []) as Record<string, unknown>[];

const todayStr = () => new Date().toISOString().slice(0, 10);

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * 错误信息提取：PostgrestError 是普通对象（不是 Error 实例），
 * String() 会得到 "[object Object]" 把真实原因吞掉 —— 统一从这里取 message。
 */
export const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  const m = (err as { message?: unknown } | null)?.message;
  if (typeof m === "string" && m.length > 0) return m;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/** 销售订单的终态（与 mrpService 的口径一致：终态单不再产生毛需求） */
const SO_TERMINAL_STATUSES = new Set(["completed", "closed", "cancelled"]);

// ---------------------------------------------------------------------------
// 基础读取
// ---------------------------------------------------------------------------

export interface MpsPlanRow {
  id: number;
  plan_no: string;
  plan_date: string;
  start_date: string;
  end_date: string;
  frozen_days: number;
  status: string;
  remark: string | null;
}

export interface MpsLineRow {
  id: number;
  plan_id: number;
  product_id: number;
  requirement_date: string;
  forecast_qty: number;
  mps_qty: number;
  pushed_quantity: number;
  remark: string | null;
}

export async function loadMpsPlan(
  tenantId: number,
  planId: number,
): Promise<MpsPlanRow> {
  const { data, error } = await supabase
    .from(T.plans)
    .select(
      "id, plan_no, plan_date, start_date, end_date, frozen_days, status, remark",
    )
    .eq("tenant_id", tenantId)
    .eq("id", planId)
    .eq("is_deleted", "n")
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(`主生产计划 ${planId} 不存在或不属于当前租户。`);
  }
  return {
    id: num(data.id),
    plan_no: String(data.plan_no ?? ""),
    plan_date: String(data.plan_date ?? ""),
    start_date: String(data.start_date ?? ""),
    end_date: String(data.end_date ?? ""),
    frozen_days: num(data.frozen_days),
    status: String(data.status ?? "draft"),
    remark: (data.remark as string | null) ?? null,
  };
}

async function loadMpsLines(
  tenantId: number,
  planId: number,
): Promise<MpsLineRow[]> {
  const { data, error } = await supabase
    .from(T.details)
    .select(
      "id, plan_id, product_id, requirement_date, forecast_qty, mps_qty, pushed_quantity, remark",
    )
    .eq("tenant_id", tenantId)
    .eq("plan_id", planId)
    .eq("is_deleted", "n")
    .order("requirement_date", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return asRows(data).map((r) => ({
    id: num(r.id),
    plan_id: num(r.plan_id),
    product_id: num(r.product_id),
    requirement_date: String(r.requirement_date ?? ""),
    forecast_qty: num(r.forecast_qty),
    mps_qty: num(r.mps_qty),
    pushed_quantity: num(r.pushed_quantity),
    remark: (r.remark as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 汇总视图（预览/下推/页面共用，保证「看到什么就执行什么」）
// ---------------------------------------------------------------------------

export interface MpsOverviewLine extends MpsLineRow {
  product_code: string;
  product_name: string;
  /** 未下推剩余 = mps_qty - pushed_quantity */
  remaining_qty: number;
  /** 该产品的未交付销售订单余量（全日期合计，仅作计划参考，不按日期分摊） */
  order_qty: number;
}

export interface MpsOverview {
  plan: MpsPlanRow;
  lines: MpsOverviewLine[];
  summary: {
    totalLines: number;
    totalForecast: number;
    totalMps: number;
    totalPushed: number;
    totalRemaining: number;
    linesWithOrderGap: number;
  };
}

export async function loadMpsOverview(
  tenantId: number,
  planId: number,
): Promise<MpsOverview> {
  const plan = await loadMpsPlan(tenantId, planId);
  const lines = await loadMpsLines(tenantId, planId);

  const productIds = Array.from(new Set(lines.map((l) => l.product_id))).filter(
    (id) => id > 0,
  );

  const productMap = new Map<number, { code: string; name: string }>();
  if (productIds.length > 0) {
    const { data, error } = await supabase
      .from(T.products)
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", productIds);
    if (error) throw error;
    for (const p of asRows(data)) {
      productMap.set(num(p.id), {
        code: String(p.code ?? ""),
        name: String(p.name ?? ""),
      });
    }
  }

  // 订单参考量：未交付销售订单按产品合计（终态单剔除）
  const orderQtyByProduct = new Map<number, number>();
  if (productIds.length > 0) {
    const { data: orders, error } = await supabase
      .from(T.salesOrders)
      .select("id, status")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n");
    if (error) throw error;
    const openOrderIds = asRows(orders)
      .filter((o) => !SO_TERMINAL_STATUSES.has(String(o.status ?? "")))
      .map((o) => num(o.id));

    if (openOrderIds.length > 0) {
      const { data: details, error: dErr } = await supabase
        .from(T.salesOrderDetails)
        .select("product_id, quantity, delivered_quantity")
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .in("order_id", openOrderIds);
      if (dErr) throw dErr;
      const wanted = new Set(productIds);
      for (const d of asRows(details)) {
        const pid = num(d.product_id);
        if (!wanted.has(pid)) continue;
        const remaining = num(d.quantity) - num(d.delivered_quantity);
        if (remaining > 0) {
          orderQtyByProduct.set(pid, (orderQtyByProduct.get(pid) ?? 0) + remaining);
        }
      }
    }
  }

  const overviewLines: MpsOverviewLine[] = lines.map((l) => {
    const product = productMap.get(l.product_id);
    return {
      ...l,
      product_code: product?.code ?? "",
      product_name: product?.name ?? "",
      remaining_qty: round4(l.mps_qty - l.pushed_quantity),
      order_qty: round4(orderQtyByProduct.get(l.product_id) ?? 0),
    };
  });

  return {
    plan,
    lines: overviewLines,
    summary: {
      totalLines: overviewLines.length,
      totalForecast: round4(overviewLines.reduce((s, l) => s + l.forecast_qty, 0)),
      totalMps: round4(overviewLines.reduce((s, l) => s + l.mps_qty, 0)),
      totalPushed: round4(overviewLines.reduce((s, l) => s + l.pushed_quantity, 0)),
      totalRemaining: round4(
        overviewLines.reduce((s, l) => s + Math.max(l.remaining_qty, 0), 0),
      ),
      // 计划量覆盖不住订单参考量的行数（提示计划员产能/数量缺口）
      linesWithOrderGap: overviewLines.filter(
        (l) => l.mps_qty > 0 && l.order_qty > l.mps_qty,
      ).length,
    },
  };
}

// ---------------------------------------------------------------------------
// 确认 / 取消确认
// ---------------------------------------------------------------------------

export async function setPlanConfirmed(
  tenantId: number,
  planId: number,
  confirm: boolean,
): Promise<MpsPlanRow> {
  const plan = await loadMpsPlan(tenantId, planId);

  if (confirm) {
    if (plan.status === "confirmed") {
      throw new Error(`计划 ${plan.plan_no} 已经确认，请勿重复确认。`);
    }
    const lines = await loadMpsLines(tenantId, planId);
    if (lines.length === 0 || lines.every((l) => l.mps_qty <= 0)) {
      throw new Error("计划没有任何 MPS 计划量，先维护计划行再确认。");
    }
  } else {
    const lines = await loadMpsLines(tenantId, planId);
    const pushed = lines.filter((l) => l.pushed_quantity > 0);
    if (pushed.length > 0) {
      throw new Error(
        `计划 ${plan.plan_no} 已有 ${pushed.length} 行下推过生产订单，` +
          `取消确认会与下推台账脱钩；请先撤销相关生产订单后再取消确认。`,
      );
    }
    if (plan.status !== "confirmed") {
      throw new Error(`计划 ${plan.plan_no} 当前未确认，无需取消。`);
    }
  }

  const { error } = await supabase
    .from(T.plans)
    .update({
      status: confirm ? "confirmed" : "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId)
    .eq("tenant_id", tenantId);
  if (error) throw error;

  return { ...plan, status: confirm ? "confirmed" : "draft" };
}

// ---------------------------------------------------------------------------
// RCCP 粗能力校验（纯计算，不落表）
// ---------------------------------------------------------------------------

export interface RccpUnitHours {
  product_id: number;
  product_code: string;
  product_name: string;
  routing_id: number | null;
  /** 单件工时（小时/件）：Σ(标准工时 + 准备工时)，无工序明细时回退 total_standard_hours */
  unit_hours: number;
  /** 工时来源：routing_details | routing_total | no_routing */
  hours_source: "routing_details" | "routing_total" | "no_routing";
}

interface RccpWorkRequirement {
  workCenterId: number | null;
  hoursPerUnit: number;
}

export interface RccpRow {
  work_center_id: number | null;
  work_center_code: string;
  work_center_name: string;
  month: string;
  capacity_per_day: number;
  load_hours: number;
  capacity_hours: number;
  load_ratio: number;
}

export interface RccpOutcome {
  plan: MpsPlanRow;
  months: string[];
  unitHours: RccpUnitHours[];
  rows: RccpRow[];
  warnings: string[];
}

async function loadRoutingRequirements(
  tenantId: number,
  productIds: number[],
  productMeta: Map<number, { code: string; name: string }>,
): Promise<{
  byProduct: Map<number, RccpWorkRequirement[]>;
  unitHours: RccpUnitHours[];
  warnings: string[];
}> {
  const byProduct = new Map<number, RccpWorkRequirement[]>();
  const unitHours: RccpUnitHours[] = [];
  const warnings: string[] = [];
  if (productIds.length === 0) return { byProduct, unitHours, warnings };

  // 默认工艺路线：优先 is_default，其次 id 最小（与 BOM 挑选口径一致）
  const { data: routings, error } = await supabase
    .from(T.routings)
    .select("id, product_id, is_default, is_active, total_standard_hours")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .in("product_id", productIds);
  if (error) throw error;

  const routingByProduct = new Map<number, { id: number; isDefault: boolean }>();
  const routingTotalHours = new Map<number, number>();
  for (const r of asRows(routings)) {
    if (r.is_active === false || r.is_active === "false") continue;
    const pid = num(r.product_id);
    const candidate = { id: num(r.id), isDefault: r.is_default === true };
    const existing = routingByProduct.get(pid);
    if (!existing) {
      routingByProduct.set(pid, candidate);
    } else if (candidate.isDefault && !existing.isDefault) {
      routingByProduct.set(pid, candidate);
    } else if (
      candidate.isDefault === existing.isDefault &&
      candidate.id < existing.id
    ) {
      routingByProduct.set(pid, candidate);
    }
    routingTotalHours.set(num(r.id), num(r.total_standard_hours));
  }

  const routingIds = Array.from(routingByProduct.values()).map((r) => r.id);
  const detailHours = new Map<number, RccpWorkRequirement[]>();
  if (routingIds.length > 0) {
    const { data: details, error: dErr } = await supabase
      .from(T.routingDetails)
      .select(
        `routing_id, operation_id, standard_hours, setup_hours, ${T.operations}!operation_id(work_center_id)`,
      )
      .eq("is_deleted", "n")
      .in("routing_id", routingIds);
    if (dErr) throw dErr;
    for (const d of asRows(details)) {
      const rid = num(d.routing_id);
      // FK 消歧嵌入的返回键是物理表名（T.operations），不是裸名 erp_operations
      const op = ((d[T.operations] ?? d.erp_operations) ?? null) as Record<
        string,
        unknown
      > | null;
      const hoursPerUnit = num(d.standard_hours) + num(d.setup_hours);
      if (hoursPerUnit <= 0) continue;
      const list = detailHours.get(rid) ?? [];
      list.push({
        workCenterId:
          op && num(op.work_center_id) > 0 ? num(op.work_center_id) : null,
        hoursPerUnit,
      });
      detailHours.set(rid, list);
    }
  }

  for (const pid of productIds) {
    const routing = routingByProduct.get(pid);
    const meta = productMeta.get(pid) ?? { code: "", name: "" };
    if (!routing) {
      byProduct.set(pid, []);
      unitHours.push({
        product_id: pid,
        product_code: meta.code,
        product_name: meta.name,
        routing_id: null,
        unit_hours: 0,
        hours_source: "no_routing",
      });
      continue;
    }

    const details = detailHours.get(routing.id) ?? [];
    if (details.length > 0) {
      const total = details.reduce((s, d) => s + d.hoursPerUnit, 0);
      byProduct.set(pid, details);
      unitHours.push({
        product_id: pid,
        product_code: meta.code,
        product_name: meta.name,
        routing_id: routing.id,
        unit_hours: round4(total),
        hours_source: "routing_details",
      });
    } else {
      const total = routingTotalHours.get(routing.id) ?? 0;
      // 无工序明细时整批工时没有工作中心归属 → 汇入「未指定」桶
      byProduct.set(pid, total > 0 ? [{ workCenterId: null, hoursPerUnit: total }] : []);
      unitHours.push({
        product_id: pid,
        product_code: meta.code,
        product_name: meta.name,
        routing_id: routing.id,
        unit_hours: round4(total),
        hours_source: total > 0 ? "routing_total" : "no_routing",
      });
      if (total <= 0) {
        warnings.push(`no_routing_hours:${meta.code || pid}`);
      }
    }
  }

  return { byProduct, unitHours, warnings };
}

const monthKey = (date: string) => (date || "").slice(0, 7);

const daysInMonth = (month: string) => {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return 0;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export async function computeRccp(
  tenantId: number,
  planId: number,
): Promise<RccpOutcome> {
  const plan = await loadMpsPlan(tenantId, planId);
  const lines = await loadMpsLines(tenantId, planId);

  const productIds = Array.from(new Set(lines.map((l) => l.product_id))).filter(
    (id) => id > 0,
  );

  const productMap = new Map<number, { code: string; name: string }>();
  if (productIds.length > 0) {
    const { data, error } = await supabase
      .from(T.products)
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", productIds);
    if (error) throw error;
    for (const p of asRows(data)) {
      productMap.set(num(p.id), {
        code: String(p.code ?? ""),
        name: String(p.name ?? ""),
      });
    }
  }

  const { byProduct, unitHours, warnings } = await loadRoutingRequirements(
    tenantId,
    productIds,
    productMap,
  );

  // 负荷聚合：工作中心 × 月
  const loadByWcMonth = new Map<string, number>();
  const months = new Set<string>();
  for (const line of lines) {
    if (line.mps_qty <= 0) continue;
    const month = monthKey(line.requirement_date);
    if (!month) continue;
    months.add(month);
    for (const req of byProduct.get(line.product_id) ?? []) {
      const key = `${req.workCenterId ?? 0}|${month}`;
      loadByWcMonth.set(
        key,
        (loadByWcMonth.get(key) ?? 0) + line.mps_qty * req.hoursPerUnit,
      );
    }
  }

  const wcIds = Array.from(new Set(
    Array.from(loadByWcMonth.keys()).map((k) => Number(k.split("|")[0])),
  )).filter((id) => id > 0);

  const wcMap = new Map<number, { code: string; name: string; capacity: number }>();
  if (wcIds.length > 0) {
    const { data, error } = await supabase
      .from(T.workCenters)
      .select("id, code, name, capacity_per_day")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", wcIds);
    if (error) throw error;
    for (const w of asRows(data)) {
      wcMap.set(num(w.id), {
        code: String(w.code ?? ""),
        name: String(w.name ?? ""),
        capacity: num(w.capacity_per_day),
      });
    }
  }

  const rows: RccpRow[] = [];
  const sortedMonths = Array.from(months).sort();
  for (const key of Array.from(loadByWcMonth.keys()).sort()) {
    const [wcRaw, month] = key.split("|");
    const wcId = Number(wcRaw);
    const load = round4(loadByWcMonth.get(key) ?? 0);
    const wc = wcId > 0 ? wcMap.get(wcId) : undefined;
    const capacityPerDay = wc?.capacity ?? 0;
    const capacityHours = round4(capacityPerDay * daysInMonth(month));
    rows.push({
      work_center_id: wcId > 0 ? wcId : null,
      work_center_code: wc?.code ?? "",
      work_center_name: wc?.name ?? "",
      month,
      capacity_per_day: capacityPerDay,
      load_hours: load,
      capacity_hours: capacityHours,
      load_ratio: capacityHours > 0 ? round4(load / capacityHours) : 0,
    });
  }

  if (rows.some((r) => r.work_center_id === null)) {
    warnings.push("load_without_work_center");
  }

  return { plan, months: sortedMonths, unitHours, rows, warnings };
}

// ---------------------------------------------------------------------------
// 下推生产订单
// ---------------------------------------------------------------------------

async function nextDocumentNo(
  tenantId: number,
  documentType: string,
  date: string,
): Promise<string> {
  const { data, error } = await supabase.rpc("generate_document_no_for_tenant", {
    p_document_type: documentType,
    p_date: date || todayStr(),
    p_tenant_id: tenantId,
  });
  if (error) throw error;
  const value = typeof data === "string" ? data : "";
  if (!value.trim()) {
    throw new Error(`取号失败（document_type=${documentType}），请检查 sys_document_types 命名规则。`);
  }
  return value;
}

export interface MpsPushCandidate extends MpsOverviewLine {
  /** 本轮要下推的数量 = remaining_qty（预览与执行共用，保证「看到什么就执行什么」） */
  quantity: number;
  bomId: number | null;
  workCenterId: number | null;
  /** 生产提前期（自然日，erp_products.lead_time_production），用于倒排计划开始日 */
  leadTimeDays: number;
  warnings: string[];
}

export interface MpsPushItemResult {
  lineId: number;
  productCode: string;
  productName: string;
  quantity: number;
  ok: boolean;
  documentId?: number;
  documentNo?: string;
  error?: string;
  warnings: string[];
}

export interface MpsPushOutcome {
  plan: MpsPlanRow;
  created: number;
  failed: number;
  skipped: { lineId: number; productCode: string; reason: string }[];
  items: MpsPushItemResult[];
  notified: boolean;
}

/** 预览与执行共用：候选 = 确认计划中「剩余可下推 > 0」的行 */
export async function buildPushCandidates(
  tenantId: number,
  planId: number,
  lineIds?: number[],
): Promise<{ overview: MpsOverview; candidates: MpsPushCandidate[]; skipped: MpsPushOutcome["skipped"] }> {
  const overview = await loadMpsOverview(tenantId, planId);
  if (overview.plan.status !== "confirmed") {
    throw new Error(
      `计划 ${overview.plan.plan_no} 尚未确认（当前状态 ${overview.plan.status}），请先确认再下推。`,
    );
  }

  const wanted =
    lineIds && lineIds.length > 0 ? new Set(lineIds) : null;

  const candidates: MpsPushCandidate[] = [];
  const skipped: MpsPushOutcome["skipped"] = [];

  const productIdsInLines = Array.from(
    new Set(overview.lines.map((l) => l.product_id)),
  ).filter((id) => id > 0);

  // 默认 BOM（口径与 MRP 转单一致：优先 is_default，其次 id 最小）
  const bomByProduct = new Map<number, { id: number; isDefault: boolean }>();
  const leadTimeByProduct = new Map<number, number>();
  const workCenterByProduct = new Map<number, number | null>();
  if (productIdsInLines.length > 0) {
    const { data: prodMeta, error: pErr } = await supabase
      .from(T.products)
      .select("id, lead_time_production")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", productIdsInLines);
    if (pErr) throw pErr;
    for (const p of asRows(prodMeta)) {
      leadTimeByProduct.set(num(p.id), Math.max(num(p.lead_time_production), 0));
    }

    const { data: boms, error } = await supabase
      .from("erp_boms_s_539dcf81_b")
      .select("id, product_id, is_default, is_active")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("product_id", productIdsInLines);
    if (error) throw error;
    for (const b of asRows(boms)) {
      if (b.is_active === false || b.is_active === "false") continue;
      const pid = num(b.product_id);
      const candidate = { id: num(b.id), isDefault: b.is_default === true };
      const existing = bomByProduct.get(pid);
      if (!existing) {
        bomByProduct.set(pid, candidate);
      } else if (candidate.isDefault && !existing.isDefault) {
        bomByProduct.set(pid, candidate);
      } else if (
        candidate.isDefault === existing.isDefault &&
        candidate.id < existing.id
      ) {
        bomByProduct.set(pid, candidate);
      }
    }

    // MO 表头的默认工作中心：默认工艺路线第一道工序的工作中心
    const rccpReqs = await loadRoutingRequirements(
      tenantId,
      productIdsInLines,
      new Map(),
    );
    const routingIdByProduct = new Map(
      rccpReqs.unitHours.map((u) => [u.product_id, u.routing_id] as const),
    );
    const routingIds = Array.from(
      new Set(
        Array.from(routingIdByProduct.values()).filter(
          (id): id is number => id !== null,
        ),
      ),
    );
    const firstWcByRouting = new Map<number, number | null>();
    if (routingIds.length > 0) {
      const { data: details, error } = await supabase
        .from(T.routingDetails)
        .select(`routing_id, sequence_no, ${T.operations}!operation_id(work_center_id)`)
        .eq("is_deleted", "n")
        .in("routing_id", routingIds)
        .order("sequence_no", { ascending: true });
      if (error) throw error;
      for (const d of asRows(details)) {
        const rid = num(d.routing_id);
        if (firstWcByRouting.has(rid)) continue;
        // 同上：嵌入键为物理表名
        const op = ((d[T.operations] ?? d.erp_operations) ?? null) as Record<
          string,
          unknown
        > | null;
        const wcId =
          op && num(op.work_center_id) > 0 ? num(op.work_center_id) : null;
        firstWcByRouting.set(rid, wcId);
      }
    }
    for (const [pid, rid] of routingIdByProduct) {
      workCenterByProduct.set(
        pid,
        rid !== null ? (firstWcByRouting.get(rid) ?? null) : null,
      );
    }
  }

  for (const line of overview.lines) {
    if (wanted && !wanted.has(line.id)) continue;
    if (line.remaining_qty <= 0) {
      skipped.push({
        lineId: line.id,
        productCode: line.product_code,
        reason: "already_pushed",
      });
      continue;
    }

    const warnings: string[] = [];
    const bomId = bomByProduct.get(line.product_id)?.id ?? null;
    if (bomId === null) {
      warnings.push("no_default_bom"); // 仍建单，明细可稍后在页面上手动展开
    }

    candidates.push({
      ...line,
      quantity: line.remaining_qty,
      bomId,
      workCenterId: workCenterByProduct.get(line.product_id) ?? null,
      leadTimeDays: leadTimeByProduct.get(line.product_id) ?? 0,
      warnings,
    });
  }

  return { overview, candidates, skipped };
}

async function createProductionOrderFromMps(
  tenantId: number,
  candidate: MpsPushCandidate,
  planNo: string,
): Promise<{ id: number; no: string; warnings: string[] }> {
  const warnings: string[] = [];
  const orderNo = await nextDocumentNo(tenantId, "production_order", candidate.requirement_date);

  // 计划开始日 = 需求日 − 生产提前期（自然日，v1 口径；无提前期则当天开始）
  let plannedStart = candidate.requirement_date;
  if (candidate.leadTimeDays > 0 && candidate.requirement_date) {
    const d = new Date(`${candidate.requirement_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - candidate.leadTimeDays);
    plannedStart = d.toISOString().slice(0, 10);
  }

  const { data, error } = await supabase
    .from(T.productionOrders)
    .insert({
      order_no: orderNo,
      order_date: todayStr(),
      product_id: candidate.product_id,
      bom_id: candidate.bomId,
      planned_quantity: candidate.quantity,
      completed_quantity: 0,
      scrapped_quantity: 0,
      planned_start_date: plannedStart,
      planned_end_date: candidate.requirement_date,
      work_center_id: candidate.workCenterId,
      status: "draft",
      priority: 5,
      remark: `由主生产计划 ${planNo} 下推（需求日 ${candidate.requirement_date}）`,
      tenant_id: tenantId,
      is_deleted: "n",
    })
    .select("id")
    .single();
  if (error) throw error;

  const orderId = num((data as { id?: unknown } | null)?.id);

  // 下推台账：防重复下推 + 回写 pushed_quantity（元数据驱动，deploy_63）
  const { error: ledgerErr } = await supabase.rpc("doc_flow_ledger_convert", {
    p_source_document_type: "mps_plan",
    p_source_detail_id: candidate.id,
    p_target_document_type: "production_order",
    p_target_document_id: orderId,
    p_target_detail_id: null,
    p_quantity: candidate.quantity,
    p_reason: "mps push",
  });
  if (ledgerErr) {
    // 台账记失败（并发重复下推等）→ 作废刚建的 MO，保持「台账 = 事实」
    await supabase
      .from(T.productionOrders)
      .update({ is_deleted: "y", updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .eq("tenant_id", tenantId);
    throw ledgerErr;
  }

  if (candidate.bomId === null) {
    warnings.push("no_default_bom");
    return { id: orderId, no: orderNo, warnings };
  }

  // 展开子件：失败不回滚订单（订单本身有效，页面可手动重试展开）
  const { error: explodeErr } = await supabase.rpc("explode_production_order_bom", {
    p_order_id: orderId,
    p_replace: true,
  });
  if (explodeErr) {
    warnings.push(`explode_failed:${explodeErr.message}`);
  }

  return { id: orderId, no: orderNo, warnings };
}

async function notifyPush(
  planNo: string,
  userId: number,
  created: number,
  failed: number,
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc("notify_push", {
      p_notification_type: "task_completed",
      p_severity: failed > 0 ? "warning" : "info",
      p_title: `MPS 下推完成：${planNo}`,
      p_content:
        `主生产计划 ${planNo} 已生成 ${created} 张生产订单` +
        (failed > 0 ? `，${failed} 条失败需人工处理。` : "。"),
      p_source_type: "mps_plan",
      p_source_id: null,
      p_source_no: planNo,
      p_link_path: "/mrp/mps",
      p_dedup_key: null,
      p_recipient_user_ids: [userId],
      p_recipient_role_code: "mrp_manager",
      p_dedup_window_hours: 24,
    });
    return !error;
  } catch {
    return false;
  }
}

export async function pushPlanToProductionOrders(
  tenantId: number,
  planId: number,
  userId: number,
  lineIds?: number[],
): Promise<MpsPushOutcome> {
  const { overview, candidates, skipped } = await buildPushCandidates(
    tenantId,
    planId,
    lineIds,
  );

  const items: MpsPushItemResult[] = [];

  // 串行执行：逐条容错，单条失败不影响其余（与 MRP 转单一致）
  for (const candidate of candidates) {
    const base: MpsPushItemResult = {
      lineId: candidate.id,
      productCode: candidate.product_code,
      productName: candidate.product_name,
      quantity: candidate.quantity,
      ok: false,
      warnings: Array.from(new Set(candidate.warnings)),
    };

    try {
      const created = await createProductionOrderFromMps(
        tenantId,
        candidate,
        overview.plan.plan_no,
      );
      items.push({
        ...base,
        ok: true,
        documentId: created.id,
        documentNo: created.no,
        warnings: Array.from(new Set([...base.warnings, ...created.warnings])),
      });
    } catch (err) {
      items.push({
        ...base,
        error: errorMessage(err),
      });
    }
  }

  const created = items.filter((i) => i.ok).length;
  const failed = items.length - created;
  const notified =
    created > 0
      ? await notifyPush(overview.plan.plan_no, userId, created, failed)
      : false;

  return { plan: overview.plan, created, failed, skipped, items, notified };
}
