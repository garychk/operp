/**
 * MRP 运算服务 · 数据库取数 / 结果写回 / 编排。
 *
 * ⚠️ ai-server 用 service_role 连库（BYPASSRLS），每一条查询都必须显式带 tenant_id 过滤，
 *    每一笔写入都必须显式带 tenant_id —— 这里没有任何 RLS 兜底。
 * 幻觉红线：本文件只搬运数据库里的数字，不产生任何业务数字；计算全部在 mrpEngine.ts。
 */
import { supabase } from "../config/supabase.js";
import {
  computeMrp,
  type MrpBomInput,
  type MrpDemandInput,
  type MrpEngineInput,
  type MrpEngineResult,
  type MrpProductInput,
  type MrpSupplyInput,
  type MrpWorkCalendarInput,
} from "./mrpEngine.js";

const T = {
  plans: "erp_mrp_plans_s_539dcf81_b",
  requirements: "erp_mrp_requirements_s_539dcf81_b",
  products: "erp_products_s_539dcf81_b",
  boms: "erp_boms_s_539dcf81_b",
  bomDetails: "erp_bom_details_s_539dcf81_b",
  productCategories: "erp_product_categories_s_539dcf81_b",
  warehouses: "erp_warehouses_s_539dcf81_b",
  inventory: "erp_inventory_s_539dcf81_b",
  salesOrders: "erp_sales_orders_s_539dcf81_b",
  salesOrderDetails: "erp_sales_order_details_s_539dcf81_b",
  purchaseOrders: "erp_purchase_orders_s_539dcf81_b",
  purchaseOrderDetails: "erp_purchase_order_details_s_539dcf81_b",
  productionOrders: "erp_production_orders_s_539dcf81_b",
  productionOrderDetails: "erp_production_order_details_s_539dcf81_b",
  mpsPlans: "erp_mps_plans_s_539dcf81_b",
  mpsDetails: "erp_mps_plan_details_s_539dcf81_b",
  // deploy_114（P0-4）
  workCalendars: "erp_work_calendars_s_539dcf81_b",
  workCalendarDays: "erp_work_calendar_days_s_539dcf81_b",
} as const;

/** 终态单据不参与供需（覆盖当前已知的状态词表，遇到新值宁可多算也不漏算） */
const TERMINAL_STATUSES = new Set(["cancelled", "closed", "delivered", "completed", "received"]);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** supabase-js 无类型客户端的返回值统一归一化成行数组 */
const asRows = (value: unknown): Record<string, unknown>[] =>
  (Array.isArray(value) ? value : []) as Record<string, unknown>[];

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * DATE 列 → 'YYYY-MM-DD' 键。
 *
 * ⚠️ 不能直接 `String(v).slice(0, 10)`：PostgREST 对 date 列返回纯字符串
 * （'2026-10-01'，切片没问题），但 node-pg 会把 DATE 解成本地零点的 Date 对象
 * （UTC+8 下显示成 2026-09-30T16:00:00Z），对它 toISOString().slice(0,10)
 * 会得到**前一天** —— 节假日会挂到昨天，静默错一整年。所以 Date 走本地分量。
 */
const toDateKey = (v: unknown): string => {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v ?? "").slice(0, 10);
};

// ---------------------------------------------------------------------------
// 计划单
// ---------------------------------------------------------------------------

export interface MrpPlanRow {
  id: number;
  plan_no: string;
  plan_date: string;
  start_date: string;
  end_date: string;
  status: string | null;
  tenant_id: number;
}

export async function loadPlan(tenantId: number, planId: number): Promise<MrpPlanRow> {
  const { data, error } = await supabase
    .from(T.plans)
    .select("id, plan_no, plan_date, start_date, end_date, status, tenant_id")
    .eq("tenant_id", tenantId)
    .eq("id", planId)
    .eq("is_deleted", "n")
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`计划不存在或不属于当前租户（plan_id=${planId}）。`);
  return data as MrpPlanRow;
}

/**
 * 并发互斥：只有 draft / failed 可以进入 running。
 * 返回 false 说明有别的运算正在跑或计划状态不允许。
 */
export async function tryAcquirePlan(planId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from(T.plans)
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", planId)
    .in("status", ["draft", "failed"])
    .neq("is_deleted", "y")
    .select("id");

  if (error) throw error;
  return Boolean(data && data.length > 0);
}

export async function finishPlan(planId: number, status: "completed" | "failed"): Promise<void> {
  const { error } = await supabase
    .from(T.plans)
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", planId);
  if (error) throw error;
}

export async function saveAnalysisReport(
  tenantId: number,
  planId: number,
  report: string,
  stats?: MrpEngineResult["stats"] | null,
): Promise<void> {
  const { error } = await supabase
    .from(T.plans)
    .update({
      analysis_report: report,
      // 结构化统计随报告一起落库（deploy_127），供前端报告弹窗画图；stats 缺失时不动该列
      ...(stats ? { analysis_stats: stats } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", planId)
    .eq("tenant_id", tenantId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// 取数 → 引擎输入
// ---------------------------------------------------------------------------

export async function loadEngineInput(tenantId: number, plan: MrpPlanRow): Promise<MrpEngineInput> {
  // ---- 物料 ----
  // deploy_120：计划参数列可空，NULL = 跟随类别默认（erp_product_categories 同名列），
  // 两端皆空再落现状默认（0 / lot_for_lot）。合并在这一层做完，引擎仍只收具体数值。
  const { data: productRows, error: productErr } = await supabase
    .from(T.products)
    .select(
      "id, code, name, category_id, is_purchased, is_manufactured, is_mrp_relevant, safety_stock, " +
        "max_stock, order_point, " +
        "lead_time_purchase, lead_time_production, lot_policy, min_order_qty, order_multiple, max_order_qty",
    )
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n");
  if (productErr) throw productErr;

  // 物料涉及的类别默认参数（deploy_120）
  const categoryIds = Array.from(
    new Set(asRows(productRows).map((r) => num(r.category_id)).filter((id) => id > 0)),
  );
  const categoryById = new Map<number, Record<string, unknown>>();
  if (categoryIds.length > 0) {
    const { data: catRows, error: catErr } = await supabase
      .from(T.productCategories)
      .select(
        "id, safety_stock, min_stock, max_stock, order_point, min_order_qty, " +
          "order_multiple, max_order_qty, lead_time_purchase, lead_time_production, lot_policy",
      )
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("id", categoryIds);
    if (catErr) throw catErr;
    for (const c of asRows(catRows)) categoryById.set(num(c.id), c);
  }

  /** 物料显式值 → 类别默认值 → 兜底值（deploy_120 取值链） */
  const pickNum = (v: unknown, cat: Record<string, unknown> | undefined, key: string, fallback = 0) =>
    num(v === null || v === undefined ? (cat?.[key] ?? fallback) : v);
  const LOT_POLICIES = ["lot_for_lot", "fixed_qty", "multiples", "max_qty"] as const;
  const pickLotPolicy = (v: unknown, cat: Record<string, unknown> | undefined): MrpProductInput["lotPolicy"] => {
    for (const candidate of [v, cat?.lot_policy]) {
      if (LOT_POLICIES.includes(candidate as never)) return candidate as MrpProductInput["lotPolicy"];
    }
    return "lot_for_lot";
  };

  const products: MrpProductInput[] = asRows(productRows).map((r) => {
    const cat = categoryById.get(num(r.category_id));
    return {
    id: num(r.id),
    code: String(r.code ?? ""),
    name: String(r.name ?? ""),
    isManufactured: Boolean(r.is_manufactured),
    isPurchased: Boolean(r.is_purchased),
    isMrpRelevant:
      r.is_mrp_relevant === null || r.is_mrp_relevant === undefined
        ? null
        : Boolean(r.is_mrp_relevant),
    safetyStock: pickNum(r.safety_stock, cat, "safety_stock"),
    maxStock: pickNum(r.max_stock, cat, "max_stock"),
    orderPoint: pickNum(r.order_point, cat, "order_point"),
    leadTimePurchase: pickNum(r.lead_time_purchase, cat, "lead_time_purchase"),
    leadTimeProduction: pickNum(r.lead_time_production, cat, "lead_time_production"),
    // 数据库 CHECK 保证取值；脏数据回退 lot_for_lot
    lotPolicy: pickLotPolicy(r.lot_policy, cat),
    minOrderQty: pickNum(r.min_order_qty, cat, "min_order_qty"),
    orderMultiple: pickNum(r.order_multiple, cat, "order_multiple"),
    maxOrderQty: pickNum(r.max_order_qty, cat, "max_order_qty"),
    };
  });
  const productById = new Map(products.map((p) => [p.id, p]));

  // ---- 工作日历（P0-4） ----
  // 只认「默认 + 启用」的日历；没有就传 null，引擎退化为自然日
  //（这是契约：老租户不维护日历，升级后下达日必须与 deploy_114 之前逐位一致）。
  // 例外日一次性全捞：工厂日历的例外日一年也就几十条，没必要按区间再切一次。
  let workCalendar: MrpWorkCalendarInput | null = null;
  {
    const { data: calendarRows, error } = await supabase
      .from(T.workCalendars)
      .select("id, calendar_name, work_days, is_default")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .eq("is_active", true);
    if (error) throw error;

    const calendars = asRows(calendarRows);
    const chosen = calendars.find((c) => c.is_default === true);
    if (chosen) {
      const calendarId = num(chosen.id);
      const { data: dayRows, error: dayErr } = await supabase
        .from(T.workCalendarDays)
        .select("calendar_date, is_workday")
        .eq("tenant_id", tenantId)
        .eq("calendar_id", calendarId)
        .eq("is_deleted", "n");
      if (dayErr) throw dayErr;

      const exceptions: Record<string, boolean> = {};
      for (const d of asRows(dayRows)) {
        const key = toDateKey(d.calendar_date);
        if (key) exceptions[key] = Boolean(d.is_workday);
      }

      workCalendar = {
        calendarId,
        calendarName: String(chosen.calendar_name ?? ""),
        workDays: (Array.isArray(chosen.work_days) ? chosen.work_days : []).map((v) => num(v)),
        exceptions,
      };
    }
  }

  // ---- BOM（每产品一个：默认优先，其次第一个 active）----
  const { data: bomRows, error: bomErr } = await supabase
    .from(T.boms)
    .select("id, product_id, quantity, is_phantom, is_default, is_active")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n")
    .eq("is_active", true);
  if (bomErr) throw bomErr;

  const chosenBoms = new Map<number, Record<string, unknown>>();
  for (const row of asRows(bomRows)) {
    const pid = num(row.product_id);
    const existing = chosenBoms.get(pid);
    if (!existing || (row.is_default && !existing.is_default)) chosenBoms.set(pid, row);
  }
  const bomIds = [...chosenBoms.values()].map((b) => num(b.id));

  let detailRows: Record<string, unknown>[] = [];
  if (bomIds.length > 0) {
    const { data, error } = await supabase
      .from(T.bomDetails)
      .select("bom_id, material_id, quantity, loss_rate, line_no")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .in("bom_id", bomIds);
    if (error) throw error;
    detailRows = asRows(data);
  }
  const linesByBom = new Map<number, { materialId: number; quantity: number; lossRate: number }[]>();
  for (const d of detailRows) {
    const bomId = num(d.bom_id);
    const list = linesByBom.get(bomId) ?? [];
    list.push({
      materialId: num(d.material_id),
      quantity: num(d.quantity),
      // ⚠️ 库里存的是「小数」不是百分数（与前端 BomEditableTreeGraph 的 InputNumber max=1
      //    与显示 ×100、deploy_57 BOM 展开的 (1 + loss_rate) 一致）。曾误写成 /100，会让损耗率失效。
      lossRate: num(d.loss_rate),
    });
    linesByBom.set(bomId, list);
  }

  const boms: MrpBomInput[] = [...chosenBoms.values()].map((b) => ({
    id: num(b.id),
    productId: num(b.product_id),
    quantity: num(b.quantity) || 1,
    isPhantom: Boolean(b.is_phantom),
    lines: linesByBom.get(num(b.id)) || [],
  }));

  // ---- 参与计划的仓库 ----
  const { data: warehouseRows, error: whErr } = await supabase
    .from(T.warehouses)
    .select("id, is_mrp_participating")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", "n");
  if (whErr) throw whErr;
  const participating = asRows(warehouseRows)
    .filter((w) => w.is_mrp_participating !== false)
    .map((w) => num(w.id));
  // 一个参与仓库都没有时退化为全部仓库，避免把库存整体算成 0
  const warehouseFilter = participating.length > 0 ? participating : null;

  // ---- 期初库存 ----
  let inventoryRows: Record<string, unknown>[] = [];
  {
    let query = supabase
      .from(T.inventory)
      .select("product_id, quantity")
      .eq("tenant_id", tenantId);
    if (warehouseFilter) query = query.in("warehouse_id", warehouseFilter);
    const { data, error } = await query;
    if (error) throw error;
    inventoryRows = asRows(data);
  }
  const supplies: MrpSupplyInput[] = [];
  const demands: MrpDemandInput[] = [];
  const onHandByProduct = new Map<number, number>();
  for (const r of inventoryRows) {
    const pid = num(r.product_id);
    onHandByProduct.set(pid, num(onHandByProduct.get(pid)) + num(r.quantity));
  }
  for (const [pid, qty] of onHandByProduct) {
    if (qty > 0) {
      supplies.push({
        productId: pid,
        date: plan.start_date,
        quantity: qty,
        sourceType: "inventory",
        sourceId: null,
      });
    }
  }

  // ---- 销售订单：剩余未交付 = 毛需求 ----
  {
    const { data, error } = await supabase
      .from(T.salesOrders)
      .select("id, order_date, delivery_date, status, is_deleted")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n");
    if (error) throw error;
    const openOrders = asRows(data).filter(
      (o) => !TERMINAL_STATUSES.has(String(o.status || "")),
    );
    const orderIds = openOrders.map((o) => num(o.id));
    if (orderIds.length > 0) {
      const { data: details, error: dErr } = await supabase
        .from(T.salesOrderDetails)
        .select("id, order_id, product_id, quantity, delivered_quantity")
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .in("order_id", orderIds);
      if (dErr) throw dErr;
      const orderById = new Map(openOrders.map((o) => [num(o.id), o]));
      for (const d of asRows(details)) {
        const remaining = num(d.quantity) - num(d.delivered_quantity);
        if (remaining <= 0) continue;
        const order = orderById.get(num(d.order_id));
        const date =
          String((order?.delivery_date as string) || (order?.order_date as string) || plan.start_date) ||
          plan.start_date;
        demands.push({
          productId: num(d.product_id),
          date,
          quantity: remaining,
          sourceType: "sales_order",
          sourceId: num(d.id),
        });
      }
    }
  }

  // ---- 采购在途：剩余未收 = 预约收入 ----
  {
    const { data, error } = await supabase
      .from(T.purchaseOrders)
      .select("id, order_date, delivery_date, status")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n");
    if (error) throw error;
    const openOrders = asRows(data).filter(
      (o) => !TERMINAL_STATUSES.has(String(o.status || "")),
    );
    const orderIds = openOrders.map((o) => num(o.id));
    if (orderIds.length > 0) {
      const { data: details, error: dErr } = await supabase
        .from(T.purchaseOrderDetails)
        .select("id, order_id, product_id, quantity, received_quantity")
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .in("order_id", orderIds);
      if (dErr) throw dErr;
      const orderById = new Map(openOrders.map((o) => [num(o.id), o]));
      for (const d of asRows(details)) {
        const remaining = num(d.quantity) - num(d.received_quantity);
        if (remaining <= 0) continue;
        const order = orderById.get(num(d.order_id));
        supplies.push({
          productId: num(d.product_id),
          date:
            String((order?.delivery_date as string) || (order?.order_date as string) || plan.start_date) ||
            plan.start_date,
          quantity: remaining,
          sourceType: "purchase_order",
          sourceId: num(d.id),
        });
      }
    }
  }

  // ---- 生产订单：成品剩余 = 预约收入；子件剩余 = 毛需求 ----
  {
    const { data, error } = await supabase
      .from(T.productionOrders)
      .select(
        "id, order_no, order_date, product_id, bom_id, planned_quantity, completed_quantity, " +
          "scrapped_quantity, planned_start_date, planned_end_date, status",
      )
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n");
    if (error) throw error;
    const openOrders = asRows(data).filter(
      (o) => !TERMINAL_STATUSES.has(String(o.status || "")),
    );
    const orderIds = openOrders.map((o) => num(o.id));

    // 成品供给
    for (const o of openOrders) {
      const remaining =
        num(o.planned_quantity) - num(o.completed_quantity) - num(o.scrapped_quantity);
      if (remaining <= 0) continue;
      supplies.push({
        productId: num(o.product_id),
        date: String(o.planned_end_date || o.planned_start_date || plan.start_date) || plan.start_date,
        quantity: remaining,
        sourceType: "production_order",
        sourceId: num(o.id),
      });
    }

    // 子件需求：优先用订单明细；没有明细时按默认 BOM 展开一层
    let prodDetails: Record<string, unknown>[] = [];
    if (orderIds.length > 0) {
      const { data: pd, error: pdErr } = await supabase
        .from(T.productionOrderDetails)
        .select("id, order_id, material_id, planned_quantity, issued_quantity")
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .in("order_id", orderIds);
      if (pdErr) throw pdErr;
      prodDetails = asRows(pd);
    }
    const ordersWithDetails = new Set(prodDetails.map((d) => num(d.order_id)));
    const orderById = new Map(openOrders.map((o) => [num(o.id), o]));

    for (const d of prodDetails) {
      const remaining = num(d.planned_quantity) - num(d.issued_quantity);
      if (remaining <= 0) continue;
      const order = orderById.get(num(d.order_id));
      demands.push({
        productId: num(d.material_id),
        date: String((order?.planned_start_date as string) || (order?.order_date as string) || plan.start_date) || plan.start_date,
        quantity: remaining,
        sourceType: "production_order",
        sourceId: num(d.id),
      });
    }

    for (const o of openOrders) {
      if (ordersWithDetails.has(num(o.id))) continue;
      const remaining = num(o.planned_quantity) - num(o.completed_quantity) - num(o.scrapped_quantity);
      if (remaining <= 0) continue;
      const bom = boms.find((b) => b.id === num(o.bom_id)) ?? boms.find((b) => b.productId === num(o.product_id));
      if (!bom) continue; // 没有 BOM 的生产订单展开不出子件需求，只能跳过
      const date = String(o.planned_start_date || o.order_date || plan.start_date) || plan.start_date;
      for (const line of bom.lines) {
        demands.push({
          productId: line.materialId,
          date,
          quantity: (remaining * line.quantity * (1 + line.lossRate)) / bom.quantity,
          sourceType: "production_order",
          sourceId: num(o.id),
        });
      }
    }
  }

  // ---- 主生产计划 MPS：已确认但未下推的 mps_qty = 计划供给 ----
  // 已下推的部分会成为真实生产订单（上面 production_order 块已计为供给），
  // 这里只补「确认了但还没下推」的差额，避免 MRP 把计划员已锁定的产量再算一遍。
  // forecast_qty 刻意不接入需求源（见 mpsService 头部注释）。
  {
    const { data: mpsPlans, error } = await supabase
      .from(T.mpsPlans)
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("is_deleted", "n")
      .eq("status", "confirmed");
    if (error) throw error;
    const planIds = asRows(mpsPlans).map((p) => num(p.id));
    if (planIds.length > 0) {
      const { data: mpsLines, error: lErr } = await supabase
        .from(T.mpsDetails)
        .select("id, product_id, requirement_date, mps_qty, pushed_quantity")
        .eq("tenant_id", tenantId)
        .eq("is_deleted", "n")
        .in("plan_id", planIds);
      if (lErr) throw lErr;
      for (const d of asRows(mpsLines)) {
        const remaining = num(d.mps_qty) - num(d.pushed_quantity);
        if (remaining <= 0) continue;
        supplies.push({
          productId: num(d.product_id),
          date:
            String(d.requirement_date as string) || plan.start_date,
          quantity: remaining,
          sourceType: "mps",
          sourceId: num(d.id),
        });
      }
    }
  }

  return {
    startDate: plan.start_date,
    endDate: plan.end_date,
    products,
    boms,
    demands,
    supplies,
    workCalendar,
  };
}

// ---------------------------------------------------------------------------
// 结果写回
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 500;

export async function persistResult(
  tenantId: number,
  planId: number,
  result: MrpEngineResult,
): Promise<void> {
  // 先清旧结果（重跑场景），再整批写入。
  // ⚠️ 只清「未转单」的行：已转单的行是既成事实（下游单据已经存在），删掉会丢失转单追踪，
  //    下次转单就会对同一需求重复下单。转单后的供给会作为在途被引擎重新算进 supply，
  //    所以保留它们不会造成重复计需求。
  const del = await supabase
    .from(T.requirements)
    .delete()
    .eq("tenant_id", tenantId)
    .eq("plan_id", planId)
    .is("converted_document_id", null);
  if (del.error) throw del.error;

  const payload = result.rows.map((row) => ({
    plan_id: planId,
    product_id: row.productId,
    requirement_date: row.requirementDate,
    gross_requirement: row.grossRequirement,
    scheduled_receipts: row.scheduledReceipts,
    projected_on_hand: row.projectedOnHand,
    net_requirement: row.netRequirement,
    planned_order_receipt: row.plannedOrderReceipt,
    planned_order_release: row.plannedOrderRelease,
    order_release_date: row.orderReleaseDate,
    source_type: row.sourceType,
    source_id: row.sourceId,
    tenant_id: tenantId, // ⚠️ service_role 不过 RLS，租户列必须显式带
    is_deleted: "n",
  }));

  for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
    const chunk = payload.slice(i, i + CHUNK_SIZE);
    const { error } = await supabase.from(T.requirements).insert(chunk);
    if (error) throw error;
  }
}

// ---------------------------------------------------------------------------
// 编排：加锁 → 取数 → 计算 → 写回
// ---------------------------------------------------------------------------

export interface RunMrpOutcome {
  plan: MrpPlanRow;
  result: MrpEngineResult;
  skippedDemands: number;
}

export async function runMrpForPlan(tenantId: number, planId: number): Promise<RunMrpOutcome> {
  const plan = await loadPlan(tenantId, planId);
  if (plan.end_date < plan.start_date) {
    throw new Error(`计划 ${plan.plan_no} 的结束日期早于开始日期，请先修正计划。`);
  }

  const acquired = await tryAcquirePlan(planId);
  if (!acquired) {
    throw new Error(`计划 ${plan.plan_no} 当前状态不允许运算（仅 draft/failed 可运算），或已有运算正在进行。`);
  }

  try {
    const input = await loadEngineInput(tenantId, plan);
    const result = computeMrp(input);
    await persistResult(tenantId, planId, result);
    // 置 completed —— 同时触发 trg_mrp_notify 给 mrp_manager 推送「MRP 运算完成」通知。
    // 必须在 persistResult 之后：失败则走 catch 置 failed，不会误报完成。
    await finishPlan(planId, "completed");
    return { plan, result, skippedDemands: 0 };
  } catch (err) {
    await finishPlan(planId, "failed").catch(() => undefined);
    throw err;
  }
}
