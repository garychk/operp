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
 *
 * 时间粒度：日（start_date..end_date 闭区间）。**桶本身仍是自然日**，但 P0-4
 *   （deploy_114）起，若租户维护了工作日历，则：
 *     * 提前期按**工作日**倒排 —— 计划下达日不会落在周末/节假日；
 *     * 非工作日需求**提前**到前一个工作日（与倒排同向，不出现「周六要货」）；
 *     * `workCalendar` 传 null 时**逐位退化为自然日**。这是契约不是兜底：
 *       没维护日历的租户，升级后历史计划的下达日必须一模一样。
 *
 * 订货点补货（P0-4）：物料 `order_point > 0` 时启用。逐日净算后若预计可用跌破
 *   订货点，追加一张计划订单把库存抬到目标水位
 *   `max_stock > 0 ? max_stock : order_point`（且不低于 `safety_stock`）；
 *   此时不再单独生成首日安全库存毛需求 —— 见 computeMrp 里安全库存段的注释。
 *
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
  /** 最高库存：订货点补货的目标水位（0 时退化为补到订货点） */
  maxStock: number;
  /** 订货点：> 0 表示该物料启用订货点补货（独立需求补货策略） */
  orderPoint: number;
  leadTimePurchase: number;
  leadTimeProduction: number;
  lotPolicy: LotPolicy;
  minOrderQty: number;
  orderMultiple: number;
  /** max_qty 批量规则的单张订单上限（0 = 未维护，退化为逐批补充） */
  maxOrderQty: number;
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
  | "safety_stock"
  /** 订货点补货（P0-4）：不由上层需求驱动，而是库存跌破订货点触发 */
  | "order_point";

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
  | "production_order"
  /** 主生产计划：已确认但未下推的 mps_qty（下推后即成为 production_order 供给，两者不会重复计） */
  | "mps";

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
  /**
   * 工作日历（P0-4）。null / undefined = 该租户没有启用日历，
   * 引擎按自然日计算（与 deploy_114 之前的行为逐位一致）。
   */
  workCalendar?: MrpWorkCalendarInput | null;
}

/**
 * 工作日历：周规律 + 例外日。
 * 由 mrpService 从 erp_work_calendars / erp_work_calendar_days 装配。
 */
export interface MrpWorkCalendarInput {
  calendarId: number;
  calendarName: string;
  /** 周规律，ISO 星期（1=周一 … 7=周日） */
  workDays: number[];
  /** 例外日覆盖：'YYYY-MM-DD' → 该日是否上班（缺省 = 跟随周规律） */
  exceptions?: Record<string, boolean> | null;
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
    /** 启用了订货点补货的物料数（order_point > 0 且参与运算） */
    reorderPointProducts: number;
    /** 订货点触发的补货次数（每次追加一张计划订单） */
    reorderTriggers: number;
    /** 本次运算实际采用的工作日历名；null = 未启用日历，按自然日计算 */
    workCalendar: string | null;
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
// 工作日历
// ---------------------------------------------------------------------------

/** ISO 星期：1=周一 … 7=周日（JS getUTCDay 是 0=周日，必须换算） */
export function isoWeekday(date: string): number {
  const js = new Date(`${date}T00:00:00Z`).getUTCDay();
  return js === 0 ? 7 : js;
}

/**
 * 某日是否上班。无日历 → 恒为 true（自然日语义）。
 * 例外日优先于周规律（节假日 FALSE / 调休 TRUE 都能表达）。
 */
export function isWorkingDay(
  date: string,
  calendar?: MrpWorkCalendarInput | null,
): boolean {
  if (!calendar) return true;
  const override = calendar.exceptions?.[date];
  if (override !== undefined && override !== null) return override;
  return calendar.workDays.includes(isoWeekday(date));
}

/**
 * 按工作日倒排：从 date 往前数 days 个工作日。
 * 无日历 → addDays(date, -days)（自然日，与旧行为逐位一致）。
 *
 * ⚠️ 循环有硬上限：日历配成「一个工作日都没有」时不能静默死循环，
 *    宁可抛错让计划员去修日历（DB 侧 deploy_114 已禁止空 work_days，
 *    这里防的是 workDays 全是不合法值的历史脏数据）。
 */
export function subtractWorkingDays(
  date: string,
  days: number,
  calendar?: MrpWorkCalendarInput | null,
): string {
  const n = Math.max(0, Math.round(days || 0));
  if (n === 0) return date;
  if (!calendar) return addDays(date, -n);

  if (!calendar.workDays.some((d) => d >= 1 && d <= 7)) {
    throw new Error(
      `工作日历「${calendar.calendarName}」没有任何有效工作日（周规律为空或越界），无法按工作日倒排提前期。`,
    );
  }

  let cur = date;
  let left = n;
  // 上限约 10 年：正常工厂日历绝不会触及，触到即说明配置有问题
  const guard = n * 30 + 3660;
  let steps = 0;
  while (left > 0) {
    cur = addDays(cur, -1);
    steps += 1;
    if (steps > guard) {
      throw new Error(
        `工作日历「${calendar.calendarName}」连续 ${guard} 天没有工作日，提前期倒排无法收敛，请检查日历配置。`,
      );
    }
    if (isWorkingDay(cur, calendar)) left -= 1;
  }
  return cur;
}

/**
 * 需求日对齐：非工作日需求**提前**到前一个工作日。
 * 方向选「提前」而不是「顺延」：与提前期倒排同向。若选顺延，
 * 一个周六的需求会先顺延到周一、再倒排提前期，等于把交期悄悄往后推 ——
 * 对客户承诺是不诚实的。提前的代价只是一个更紧的计划期，计划员看得见。
 * 无日历 → 原样返回。
 */
export function snapToWorkingDay(
  date: string,
  calendar?: MrpWorkCalendarInput | null,
): string {
  if (!calendar) return date;
  if (isWorkingDay(date, calendar)) return date;

  let cur = date;
  let steps = 0;
  const guard = 3660;
  while (!isWorkingDay(cur, calendar)) {
    cur = addDays(cur, -1);
    steps += 1;
    if (steps > guard) {
      throw new Error(
        `工作日历「${calendar.calendarName}」连续 ${guard} 天都不是工作日，需求日无法对齐到工作日，请检查日历配置。`,
      );
    }
  }
  return cur;
}

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

export interface LotSizingResult {
  /** 建议总批量（≥ 净需求） */
  qty: number;
  /**
   * 拆出的各张计划订单量（不拆单时长度为 1，净需求为 0 时为空数组）。
   * 各元素之和恒等于 qty —— 引擎据此生成「多张计划下达」。
   */
  lots: number[];
  warning?: string;
}

/**
 * 批量规则。
 *
 * P0-4 起支持 `max_qty`（最大批量 = 单张订单上限，超过则**拆单**），
 * 并让 `fixed_qty` 也如实拆成多张（原先只返回总量、由上层当一张单处理，
 * 计划员看不到「要下 3 张采购单」）。`lots` 之和恒等于 `qty`。
 */
export function applyLotSizing(
  policy: LotPolicy,
  net: number,
  minOrderQty: number,
  orderMultiple: number,
  maxOrderQty = 0,
): LotSizingResult {
  if (net <= 0) return { qty: 0, lots: [] };

  // min_order_qty 是「单张下限」，order_multiple 是「取整步长」
  const floorQty = minOrderQty > 0 ? minOrderQty : 0;
  const sum = (lots: number[]) => round6(lots.reduce((a, b) => a + b, 0));

  switch (policy) {
    case "lot_for_lot":
      return { qty: round6(net), lots: [round6(net)] };

    case "fixed_qty": {
      // 固定量：每张订单固定 min_order_qty；未维护（0）时退化为逐批补充
      if (floorQty <= 0) return { qty: round6(net), lots: [round6(net)] };
      const count = Math.ceil(net / floorQty);
      const lots = Array.from({ length: count }, () => round6(floorQty));
      return { qty: sum(lots), lots };
    }

    case "multiples": {
      // 倍数批量：向上取整到 order_multiple，且不小于 min_order_qty
      const base = Math.max(net, floorQty);
      const qty = orderMultiple > 0 ? Math.ceil(base / orderMultiple) * orderMultiple : base;
      return { qty: round6(qty), lots: [round6(qty)] };
    }

    case "max_qty":
    default: {
      // 最大批量：单张不得超过 max_order_qty，超过就拆成多张。
      // 未维护上限（0）时无法拆单，退化为逐批补充（仅为兼容旧参数，仍发警告）。
      if (maxOrderQty <= 0) {
        return {
          qty: round6(net),
          lots: [round6(net)],
          warning:
            "批量规则为 max_qty，但未维护「最大批量」（max_order_qty = 0），该物料按逐批补充（lot_for_lot）计算",
        };
      }

      // 先按 min_order_qty 兜底总量，再按上限决定张数（至少 1 张）
      const base = Math.max(net, floorQty);
      const count = Math.max(1, Math.ceil(base / maxOrderQty));
      // 均分到各张。⚠️ 必须**向上**取到 6 位小数：25 ÷ 3 向下截断会得到
      // 8.333333×3 = 24.999999 < 净需求 25 —— 拆单后总量小于需求是硬错误
      //（缺口被静默吞掉），宁可多出 1e-6。
      let each = Math.ceil((base / count) * 1e6) / 1e6;
      if (orderMultiple > 0) each = Math.ceil(each / orderMultiple) * orderMultiple;
      if (each < floorQty) each = floorQty;
      const lots = Array.from({ length: count }, () => round6(each));
      return { qty: sum(lots), lots };
    }
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

  // 工作日历：null = 本租户未启用日历 → 全文走自然日分支（旧行为）
  const calendar = input.workCalendar ?? null;

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
    // 非工作日需求提前到前一工作日；窗口夹取放最后（窗口边界优先）
    const d = clampDate(snapToWorkingDay(date, calendar), startDate, endDate);
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
    // ⚠️ 供给日**刻意不按工作日对齐**：收料/完工日期是供应商与车间的实际承诺，
    //    擅自提前等于凭日历替别人改交期（乐观化库存）。需求侧可以收紧，供给侧不行。
    const d = clampDate(supply.date, startDate, endDate);
    m.set(d, round6((m.get(d) || 0) + supply.quantity));
    scheduledByProduct.set(supply.productId, m);
  }

  // ---- 安全库存：期初可用低于安全库存时，在首日补一条毛需求 ----
  // ⚠️ 与订货点补货的互斥（P0-4）：order_point > 0 的物料走「订货点补货」，
  //    安全库存已作为目标水位的下界参与其中（见下方逐日净算）。若这里再补一条
  //    首日毛需求，同一批缺口会被补两次 —— 订货点物料只发一条提示，不生成需求。
  for (const p of relevant) {
    if (bomByProduct.get(p.id)?.isPhantom) continue;

    // ⚠️ 订货点补货是「没有任何上层需求也能产生计划」的唯一途径，而 stateByProduct
    //    是懒建的（只在 addDemand 时才建桶）。不在这里主动建桶，订货点物料会被
    //    整个跳过 —— 计划员会看到「设了订货点却永远不补货」的静默失效。
    //    只给订货点物料建桶，避免给全库物料都摊一份桶（大计划的内存/耗时回归）。
    if (p.orderPoint > 0) ensureBuckets(p.id);

    const safety = p.safetyStock > 0 ? p.safetyStock : 0;
    if (safety <= 0) continue;

    if (p.orderPoint > 0) {
      warnings.push({
        productId: p.id,
        code: p.code,
        message:
          `物料启用了订货点补货（订货点 ${p.orderPoint}），安全库存 ${safety} 已并入补货目标水位（取订货点与安全库存的较大者），` +
          `不再单独生成首日安全库存需求，避免同一缺口重复补货`,
      });
      continue;
    }

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
  let reorderPointProducts = 0;
  let totalReorderTriggers = 0;
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

    // 订货点补货的目标水位：优先「最高库存」，未维护则补到订货点；
    // 但不得低于安全库存 —— 否则补货后仍然低于安全线，下一桶又会立刻再补一次。
    const reorderTarget = Math.max(
      product.maxStock > 0 ? product.maxStock : product.orderPoint,
      product.safetyStock > 0 ? product.safetyStock : 0,
    );
    let reorderTriggers = 0;

    let projected = onHandStart.get(product.id) || 0;
    // 当前桶的批量拆分结果：计划下达时按张生成 plannedOrders（max_qty / fixed_qty 会拆单）
    let lastLots: number[] = [];
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
        const shortage = round6(gross - availableBefore);
        net = shortage > 0 ? shortage : 0;

        // 订货点补货：需求扣完之后预计可用仍低于订货点 → 追加补货到目标水位。
        // 与需求驱动的净需求**合并后只做一次批量取整**，否则同一桶会算出两张
        // 互相不知道对方的计划订单，取整误差翻倍。
        let reorderNet = 0;
        if (product.orderPoint > 0 && reorderTarget > 0) {
          const afterDemand = round6(availableBefore - gross);
          if (afterDemand < product.orderPoint) {
            reorderNet = round6(reorderTarget - afterDemand);
            reorderTriggers += 1;
            // 让来源标注认得出来：纯补货桶 → order_point；与需求同桶 → mixed
            const key = "order_point:";
            bucket?.demandTypes.set(key, (bucket.demandTypes.get(key) || 0) + 1);
          }
        }

        net = round6(net + reorderNet);
        const sized = applyLotSizing(
          lotPolicy,
          net,
          product.minOrderQty,
          product.orderMultiple,
          product.maxOrderQty,
        );
        receipt = sized.qty;
        if (sized.warning) lotSizingWarnings.add(sized.warning);
        projected = round6(availableBefore + receipt - gross);
        lastLots = sized.lots;
      } else {
        // 幻影件本身不持有库存计划，投影值直接穿过
        projected = round6(projected + scheduled - gross);
        lastLots = [];
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
        // 提前期按工作日倒排（无日历则自然日）
        const releaseDate = subtractWorkingDays(date, leadTime, calendar);
        // 一张「计划收入」按批量规则可能拆成多张计划订单（max_qty / fixed_qty）
        for (const lotQty of lastLots) plannedOrders.push({ date: releaseDate, qty: lotQty });
        if (lastLots.length === 0) plannedOrders.push({ date: releaseDate, qty: receipt });
        row.orderReleaseDate = releaseDate;

        if (releaseDate < startDate) {
          const unit = calendar ? "个工作日" : "天";
          const basis = calendar ? `按工作日历「${calendar.calendarName}」` : "按自然日";
          warnings.push({
            productId: product.id,
            code: product.code,
            message:
              `计划下达日 ${releaseDate} 早于计划期开始（${basis}倒排提前期 ${leadTime} ${unit}），` +
              `已夹取到 ${startDate}，需要尽快人工下达`,
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
    totalReorderTriggers += reorderTriggers;
    if (product.orderPoint > 0 && !isPhantom) reorderPointProducts += 1;
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
      reorderPointProducts,
      reorderTriggers: totalReorderTriggers,
      workCalendar: calendar ? calendar.calendarName : null,
    },
    warnings,
  };
}
