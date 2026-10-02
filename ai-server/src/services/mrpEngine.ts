/**
 * MRP 确定性运算引擎 · 纯函数核心。
 *
 * 设计原则（2026-10-02 与用户确认）：
 * - 计算主体是确定性算法，LLM 只做结果解读（mrpAdvisor），绝不参与计算。
 * - 本文件不 import 任何数据库客户端 —— 输入是纯数据、输出是纯数据，
 *   这样才能用断言测试覆盖多层级 BOM / 损耗率 / 批量规则 / 提前期倒排。
 * - 数据库取数与结果写回在 mrpService.ts。
 *
 * 算法：低层码（LLC）分层 → 逐层逐日净需求 → 批量规则 → 提前期倒排 → 子件毛需求递归。
 * 时间粒度：日（start_date..end_date 闭区间，自然日，v1 不做工作日历）。
 * 幻觉红线：所有输出数字都来自输入的算术组合，不存在任何估算或查表之外的来源。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type LotPolicy = "lot_for_lot" | "fixed_qty" | "multiples" | "max_qty";

export interface MrpProductInput {
  id: number;
  code: string;
  name: string;
  isManufactured: boolean;
  isPurchased: boolean;
  /** null 时引擎回退到 is_purchased || is_manufactured（deploy_60 刻意可空） */
  isMrpRelevant: boolean | null;
  safetyStock: number;
  leadTimePurchase: number;
  leadTimeProduction: number;
  lotPolicy: LotPolicy;
  minOrderQty: number;
  orderMultiple: number;
}

export interface MrpBomLineInput {
  materialId: number;
  /** 每单位父件的用量（相对 BOM.quantity 的分母在引擎内处理） */
  quantity: number;
  lossRate: number;
}

export interface MrpBomInput {
  id: number;
  productId: number;
  /** BOM 批量：一行用量是「做 quantity 个父件」的用料 */
  quantity: number;
  isPhantom: boolean;
  lines: MrpBomLineInput[];
}

export type MrpDemandSourceType =
  | "sales_order"
  | "production_order"
  | "mrp"
  | "safety_stock";

export interface MrpDemandInput {
  productId: number;
  /** YYYY-MM-DD，窗口外的日期由引擎夹取 */
  date: string;
  quantity: number;
  sourceType: MrpDemandSourceType;
  sourceId: number | null;
}

export type MrpSupplySourceType =
  | "inventory"
  | "purchase_order"
  | "production_order";

export interface MrpSupplyInput {
  productId: number;
  date: string;
  quantity: number;
  sourceType: MrpSupplySourceType;
  sourceId: number | null;
}

export interface MrpEngineInput {
  startDate: string;
  endDate: string;
  products: MrpProductInput[];
  /** 每个产品至多一个 BOM（默认优先、其次第一个 active），由 mrpService 挑好 */
  boms: MrpBomInput[];
  demands: MrpDemandInput[];
  supplies: MrpSupplyInput[];
}

export interface MrpRequirementRow {
  productId: number;
  requirementDate: string;
  grossRequirement: number;
  scheduledReceipts: number;
  projectedOnHand: number;
  netRequirement: number;
  plannedOrderReceipt: number;
  plannedOrderRelease: number;
  orderReleaseDate: string | null;
  sourceType: string | null;
  sourceId: number | null;
}

export interface MrpShortageSummary {
  productId: number;
  code: string;
  name: string;
  /** 第一次出现缺口的日期 */
  firstShortDate: string;
  totalNetRequirement: number;
  plannedOrderCount: number;
  firstPlannedReleaseDate: string | null;
}

export interface MrpEngineWarning {
  productId: number;
  code: string;
  message: string;
}

export interface MrpEngineResult {
  rows: MrpRequirementRow[];
  stats: {
    relevantProducts: number;
    plannedProducts: number;
    bucketDays: number;
    productsWithShortage: number;
    totalNetRequirement: number;
    plannedOrders: number;
    shortages: MrpShortageSummary[];
  };
  warnings: MrpEngineWarning[];
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** YYYY-MM-DD 的日加减（UTC，避免时区偏移） */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRange(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  let cur = startDate;
  let guard = 0;
  while (cur <= endDate && guard < 100000) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard += 1;
  }
  return out;
}

const clampDate = (date: string, startDate: string, endDate: string) =>
  date < startDate ? startDate : date > endDate ? endDate : date;

// ---------------------------------------------------------------------------
// 低层码（LLC）
// ---------------------------------------------------------------------------

/**
 * 计算每个物料在全部 BOM 中的最低层码。
 * 只有「当前层 = 低层码」时才生成净需求，共用件不会被重复计需求。
 * 不动点迭代，若超过迭代上限仍有变化说明 BOM 成环，直接抛错。
 */
export function computeLowLevelCodes(boms: MrpBomInput[], productIds: number[]): Map<number, number> {
  const llc = new Map<number, number>();
  for (const id of productIds) llc.set(id, 0);

  const maxIter = productIds.length + 1;
  for (let iter = 0; iter < maxIter; iter += 1) {
    let changed = false;
    for (const bom of boms) {
      const parentLevel = llc.get(bom.productId) ?? 0;
      for (const line of bom.lines) {
        const cur = llc.get(line.materialId);
        if (cur === undefined || cur < parentLevel + 1) {
          llc.set(line.materialId, parentLevel + 1);
          changed = true;
        }
      }
    }
    if (!changed) return llc;
  }
  throw new Error("BOM 存在循环引用（A→B→A），无法计算低层码，请检查 BOM 数据。");
}

// ---------------------------------------------------------------------------
// 批量规则
// ---------------------------------------------------------------------------

export function applyLotSizing(
  policy: LotPolicy,
  net: number,
  minOrderQty: number,
  orderMultiple: number,
): { qty: number; warning?: string } {
  if (net <= 0) return { qty: 0 };

  switch (policy) {
    case "lot_for_lot":
      return { qty: round6(net) };

    case "fixed_qty": {
      // 固定量：每张订单固定 min_order_qty；未维护（0）时退化为逐批补充
      if (minOrderQty <= 0) return { qty: round6(net) };
      const orders = Math.ceil(net / minOrderQty);
      return { qty: round6(orders * minOrderQty) };
    }

    case "multiples": {
      // 倍数批量：向上取整到 order_multiple，且不小于 min_order_qty
      const base = Math.max(net, minOrderQty > 0 ? minOrderQty : 0);
      if (orderMultiple <= 0) return { qty: round6(base) };
      const multiple = Math.ceil(base / orderMultiple) * orderMultiple;
      return { qty: round6(multiple) };
    }

    case "max_qty":
    default:
      // v1 未实现最大批量策略，回退逐批补充（数据库 CHECK 允许该值，但引擎先不支持）
      return { qty: round6(net), warning: `批量规则 max_qty 尚未实现，物料按逐批补充（lot_for_lot）计算` };
  }
}

// ---------------------------------------------------------------------------
// 主计算
// ---------------------------------------------------------------------------

interface BucketState {
  gross: number;
  scheduled: number;
  demandTypes: Map<string, number>;
}

export function computeMrp(input: MrpEngineInput): MrpEngineResult {
  const { startDate, endDate, products, boms, demands, supplies } = input;
  if (endDate < startDate) {
    throw new Error("计划结束日期不能早于开始日期。");
  }

  const buckets = dateRange(startDate, endDate);
  const warnings: MrpEngineWarning[] = [];

  const productById = new Map(products.map((p) => [p.id, p]));

  const isRelevant = (p: MrpProductInput): boolean =>
    p.isMrpRelevant === null || p.isMrpRelevant === undefined
      ? p.isPurchased || p.isManufactured
      : p.isMrpRelevant;

  const relevant = products.filter(isRelevant);
  const relevantIds = new Set(relevant.map((p) => p.id));

  const bomByProduct = new Map<number, MrpBomInput>();
  for (const bom of boms) {
    if (!bomByProduct.has(bom.productId)) bomByProduct.set(bom.productId, bom);
  }

  // ---- 低层码 + 处理顺序（父件先于子件） ----
  const llc = computeLowLevelCodes(boms, [...productById.keys()]);
  const ordered = [...relevant].sort(
    (a, b) => (llc.get(a.id) ?? 0) - (llc.get(b.id) ?? 0) || a.id - b.id,
  );

  // ---- 聚合桶：产品 × 日期 ----
  const stateByProduct = new Map<number, Map<string, BucketState>>();
  const ensureBuckets = (productId: number) => {
    let m = stateByProduct.get(productId);
    if (!m) {
      m = new Map();
      for (const d of buckets) m.set(d, { gross: 0, scheduled: 0, demandTypes: new Map() });
      stateByProduct.set(productId, m);
    }
    return m;
  };

  /** 毛需求入口：幻影 BOM 穿透（blow-through），窗口外日期夹取到窗口内 */
  const addDemand = (
    productId: number,
    date: string,
    qty: number,
    sourceType: MrpDemandSourceType,
    sourceId: number | null,
    depth = 0,
  ): void => {
    if (qty <= 0) return;
    const product = productById.get(productId);
    if (!product || !relevantIds.has(productId)) return;
    if (depth > 64) throw new Error(`BOM 穿透深度超过 64 层，疑似循环引用（物料 ${product.code}）。`);

    const bom = bomByProduct.get(productId);
    if (bom?.isPhantom) {
      // 幻觉红线：幻影件不落毛需求、不下计划订单，用料直接穿透到子件
      if (bom.quantity <= 0) throw new Error(`幻影件 ${product.code} 的 BOM 数量必须大于 0。`);
      for (const line of bom.lines) {
        addDemand(
          line.materialId,
          date,
          (qty * line.quantity * (1 + (line.lossRate || 0))) / bom.quantity,
          sourceType,
          sourceId,
          depth + 1,
        );
      }
      return;
    }

    const m = ensureBuckets(productId);
    const d = clampDate(date, startDate, endDate);
    const b = m.get(d);
    if (!b) return;
    b.gross = round6(b.gross + qty);
    const key = `${sourceType}:${sourceId ?? ""}`;
    b.demandTypes.set(key, (b.demandTypes.get(key) || 0) + 1);
  };

  for (const demand of demands) {
    addDemand(demand.productId, demand.date, demand.quantity, demand.sourceType, demand.sourceId);
  }

  // ---- 供给：期初库存 + 窗口内预约收入（采购在途 / 在产完工） ----
  const onHandStart = new Map<number, number>();
  const scheduledByProduct = new Map<number, Map<string, number>>();
  for (const supply of supplies) {
    if (!relevantIds.has(supply.productId) || supply.quantity <= 0) continue;
    if (supply.sourceType === "inventory") {
      onHandStart.set(supply.productId, round6((onHandStart.get(supply.productId) || 0) + supply.quantity));
      continue;
    }
    const m = scheduledByProduct.get(supply.productId) ?? new Map<string, number>();
    const d = clampDate(supply.date, startDate, endDate);
    m.set(d, round6((m.get(d) || 0) + supply.quantity));
    scheduledByProduct.set(supply.productId, m);
  }

  // ---- 安全库存：期初可用低于安全库存时，在首日补一条毛需求 ----
  for (const p of relevant) {
    if (bomByProduct.get(p.id)?.isPhantom) continue;
    const safety = p.safetyStock > 0 ? p.safetyStock : 0;
    const onHand = onHandStart.get(p.id) || 0;
    if (safety > onHand) {
      addDemand(p.id, startDate, round6(safety - onHand), "safety_stock", null);
    }
  }

  // ---- 结果聚合容器 ----
  const rowsByProduct = new Map<number, Map<string, MrpRequirementRow>>();
  const plannedOrdersByProduct = new Map<number, { date: string; qty: number }[]>();
  const ensureRows = (productId: number) => {
    let m = rowsByProduct.get(productId);
    if (!m) {
      m = new Map();
      rowsByProduct.set(productId, m);
    }
    return m;
  };
  const touchRow = (productId: number, date: string): MrpRequirementRow => {
    const m = ensureRows(productId);
    let row = m.get(date);
    if (!row) {
      row = {
        productId,
        requirementDate: date,
        grossRequirement: 0,
        scheduledReceipts: 0,
        projectedOnHand: 0,
        netRequirement: 0,
        plannedOrderReceipt: 0,
        plannedOrderRelease: 0,
        orderReleaseDate: null,
        sourceType: null,
        sourceId: null,
      };
      m.set(date, row);
    }
    return row;
  };

  // ---- 逐物料（升 LLC）逐日净需求 ----
  for (const product of ordered) {
    const bucketMap = stateByProduct.get(product.id);
    if (!bucketMap) continue;

    const isPhantom = bomByProduct.get(product.id)?.isPhantom ?? false;
    const hasBom = bomByProduct.has(product.id);
    // 提前期按物料属性选：制造件用生产提前期，其余（含带 BOM 的采购件，如需组装的外购半成品）用采购提前期
    const leadTime = product.isManufactured
      ? Math.max(0, Math.round(product.leadTimeProduction || 0))
      : Math.max(0, Math.round(product.leadTimePurchase || 0));

    const lotPolicy: LotPolicy = product.lotPolicy || "lot_for_lot";
    const lotSizingWarnings = new Set<string>();
    const plannedOrders: { date: string; qty: number }[] = [];

    let projected = onHandStart.get(product.id) || 0;
    // 每个桶结束时的预计可用量：下达行可能落在更早的日期桶（提前期倒排），
    // 事后创建时不能留 0，循环结束后用这里记录的值回填
    const projectedByDate = new Map<string, number>();

    for (const date of buckets) {
      const bucket = bucketMap.get(date);
      const gross = bucket?.gross ?? 0;
      const scheduled = scheduledByProduct.get(product.id)?.get(date) ?? 0;

      let net = 0;
      let receipt = 0;

      if (!isPhantom) {
        const availableBefore = round6(projected + scheduled);
        if (round6(availableBefore - gross) < 0) {
          net = round6(gross - availableBefore);
          const sized = applyLotSizing(lotPolicy, net, product.minOrderQty, product.orderMultiple);
          receipt = sized.qty;
          if (sized.warning) lotSizingWarnings.add(sized.warning);
        }
        projected = round6(availableBefore + receipt - gross);
      } else {
        // 幻影件本身不持有库存计划，投影值直接穿过
        projected = round6(projected + scheduled - gross);
      }
      projectedByDate.set(date, projected);

      const hasActivity = gross !== 0 || scheduled !== 0 || net !== 0 || receipt !== 0;
      if (!hasActivity) continue;

      const row = touchRow(product.id, date);
      row.grossRequirement = round6(row.grossRequirement + gross);
      row.scheduledReceipts = round6(row.scheduledReceipts + scheduled);
      row.netRequirement = round6(row.netRequirement + net);
      row.plannedOrderReceipt = round6(row.plannedOrderReceipt + receipt);
      row.projectedOnHand = projected;

      // 来源：桶内所有需求来自同一来源才标注，否则 mixed
      const types = bucket?.demandTypes;
      if (types && types.size > 0) {
        if (types.size === 1) {
          const key = [...types.keys()][0];
          const [type, idPart] = key.split(":");
          row.sourceType = type;
          row.sourceId = idPart ? Number(idPart) : null;
        } else {
          row.sourceType = "mixed";
          row.sourceId = null;
        }
      }

      // 计划收入 → 倒排计划下达
      if (receipt > 0) {
        const releaseDate = addDays(date, -leadTime);
        plannedOrders.push({ date: releaseDate, qty: receipt });
        row.orderReleaseDate = releaseDate;

        if (releaseDate < startDate) {
          warnings.push({
            productId: product.id,
            code: product.code,
            message: `计划下达日 ${releaseDate} 早于计划期开始（提前期 ${leadTime} 天），已夹取到 ${startDate}，需要尽快人工下达`,
          });
        }
        const releaseRow = touchRow(product.id, clampDate(releaseDate, startDate, endDate));
        releaseRow.plannedOrderRelease = round6(
          releaseRow.plannedOrderRelease + receipt,
        );
        // 子件毛需求挂在下达日（提前期 <= 0 时与收入同日）
        if (hasBom && !isPhantom) {
          const bom = bomByProduct.get(product.id)!;
          if (bom.quantity <= 0) {
            throw new Error(`物料 ${product.code} 的 BOM 数量必须大于 0（BOM ${bom.id}）。`);
          }
          const effectiveDate = clampDate(releaseDate, startDate, endDate);
          for (const line of bom.lines) {
            addDemand(
              line.materialId,
              effectiveDate,
              (receipt * line.quantity * (1 + (line.lossRate || 0))) / bom.quantity,
              "mrp",
              product.id,
            );
          }
        }
      }
    }

    // 回填：下达行可能创建于更早的日期桶，其 projectedOnHand 以该桶实际值为准
    const productRows = rowsByProduct.get(product.id);
    if (productRows) {
      for (const [d, row] of productRows) {
        const pv = projectedByDate.get(d);
        if (pv !== undefined) row.projectedOnHand = pv;
      }
    }

    if (lotSizingWarnings.size > 0) {
      for (const message of lotSizingWarnings) {
        warnings.push({ productId: product.id, code: product.code, message });
      }
    }
    plannedOrdersByProduct.set(product.id, plannedOrders);
  }

  // ---- 汇总输出 ----
  const rows: MrpRequirementRow[] = [];
  const shortages: MrpShortageSummary[] = [];
  let totalNet = 0;
  let productsWithShortage = 0;
  let plannedOrderCount = 0;

  for (const [productId, m] of rowsByProduct) {
    for (const row of m.values()) rows.push(row);
  }
  rows.sort((a, b) => a.productId - b.productId || (a.requirementDate < b.requirementDate ? -1 : 1));

  for (const product of ordered) {
    const m = rowsByProduct.get(product.id);
    if (!m) continue;
    let productNet = 0;
    let firstShortDate: string | null = null;
    for (const row of m.values()) {
      if (row.netRequirement > 0) {
        productNet = round6(productNet + row.netRequirement);
        if (!firstShortDate || row.requirementDate < firstShortDate) {
          firstShortDate = row.requirementDate;
        }
      }
    }
    const orders = plannedOrdersByProduct.get(product.id) || [];
    plannedOrderCount += orders.length;
    if (productNet > 0) {
      productsWithShortage += 1;
      totalNet = round6(totalNet + productNet);
      const sortedReleases = orders.map((o) => o.date).sort();
      shortages.push({
        productId: product.id,
        code: product.code,
        name: product.name,
        firstShortDate: firstShortDate || startDate,
        totalNetRequirement: productNet,
        plannedOrderCount: orders.length,
        firstPlannedReleaseDate: sortedReleases[0] || null,
      });
    }
  }
  shortages.sort((a, b) => (a.firstShortDate < b.firstShortDate ? -1 : 1));

  return {
    rows,
    stats: {
      relevantProducts: relevant.length,
      plannedProducts: rowsByProduct.size,
      bucketDays: buckets.length,
      productsWithShortage,
      totalNetRequirement: totalNet,
      plannedOrders: plannedOrderCount,
      shortages,
    },
    warnings,
  };
}
