/**
 * MRP 引擎纯函数核心断言测试（不连数据库）。
 * 运行：npx tsx scripts/test-mrp-engine.ts
 */
import {
  addDays,
  applyLotSizing,
  computeLowLevelCodes,
  computeMrp,
  isWorkingDay,
  isoWeekday,
  snapToWorkingDay,
  subtractWorkingDays,
  type MrpBomInput,
  type MrpDemandInput,
  type MrpEngineInput,
  type MrpProductInput,
  type MrpSupplyInput,
  type MrpWorkCalendarInput,
} from "../src/services/mrpEngine.js";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}\n      期望: ${e}\n      实际: ${a}`);
  }
}

function product(partial: Partial<MrpProductInput> & { id: number; code: string }): MrpProductInput {
  return {
    name: partial.code,
    isManufactured: false,
    isPurchased: true,
    isMrpRelevant: null,
    safetyStock: 0,
    maxStock: 0,
    orderPoint: 0,
    leadTimePurchase: 0,
    leadTimeProduction: 0,
    lotPolicy: "lot_for_lot",
    minOrderQty: 0,
    orderMultiple: 0,
    maxOrderQty: 0,
    ...partial,
  };
}

/** 周一到周五上班的日历（ISO 1..5） */
const CAL_WEEKDAY: MrpWorkCalendarInput = {
  calendarId: 1,
  calendarName: "测试日历A",
  workDays: [1, 2, 3, 4, 5],
};

/** 周一到周五上班，但 10-07（周三）放假、10-10（周六）调休上班 */
const CAL_HOLIDAY: MrpWorkCalendarInput = {
  calendarId: 2,
  calendarName: "测试日历B",
  workDays: [1, 2, 3, 4, 5],
  exceptions: { "2026-10-07": false, "2026-10-10": true },
};

const baseInput = (): MrpEngineInput => ({
  startDate: "2026-10-05",
  endDate: "2026-10-12",
  products: [],
  boms: [],
  demands: [] as MrpDemandInput[],
  supplies: [] as MrpSupplyInput[],
});

// ---------------------------------------------------------------------------
console.log("\n[1] 三级 BOM + 损耗率 + 提前期倒排");
{
  // P1(成品, 制造, 提前期2) ← BOM10: P2×5 ← BOM1: P3×3(损耗10%)
  // P2(采购, 提前期3), P3(采购, 提前期0)
  const input = baseInput();
  input.products = [
    product({ id: 1, code: "P1", isManufactured: true, isPurchased: false, leadTimeProduction: 2 }),
    product({ id: 2, code: "P2", leadTimePurchase: 3 }),
    product({ id: 3, code: "P3", leadTimePurchase: 0 }),
  ];
  input.boms = [
    { id: 11, productId: 1, quantity: 10, isPhantom: false, lines: [{ materialId: 2, quantity: 5, lossRate: 0 }] },
    { id: 22, productId: 2, quantity: 1, isPhantom: false, lines: [{ materialId: 3, quantity: 3, lossRate: 0.1 }] },
  ];
  input.demands = [
    { productId: 1, date: "2026-10-10", quantity: 100, sourceType: "sales_order", sourceId: 9001 },
  ];
  input.supplies = [
    { productId: 2, date: "2026-10-05", quantity: 10, sourceType: "inventory", sourceId: null },
    { productId: 2, date: "2026-10-08", quantity: 20, sourceType: "purchase_order", sourceId: 8001 },
  ];

  const r = computeMrp(input);
  const byKey = new Map(r.rows.map((row) => [`${row.productId}@${row.requirementDate}`, row]));

  check("P1 收入行毛需求", byKey.get("1@2026-10-10")?.grossRequirement, 100);
  check("P1 收入行净需求", byKey.get("1@2026-10-10")?.netRequirement, 100);
  check("P1 收入行计划收入", byKey.get("1@2026-10-10")?.plannedOrderReceipt, 100);
  check("P1 收入行倒排下达日", byKey.get("1@2026-10-10")?.orderReleaseDate, "2026-10-08");
  check("P1 下达行计划下达", byKey.get("1@2026-10-08")?.plannedOrderRelease, 100);
  check("P1 期末投影", byKey.get("1@2026-10-10")?.projectedOnHand, 0);

  // P2: 毛需求 100×5/10=50 挂在下达日 10-08；供给 = 期初10 + 在途20
  check("P2 毛需求(子件展开)", byKey.get("2@2026-10-08")?.grossRequirement, 50);
  check("P2 预约收入(PO)", byKey.get("2@2026-10-08")?.scheduledReceipts, 20);
  check("P2 净需求", byKey.get("2@2026-10-08")?.netRequirement, 20);
  check("P2 计划收入", byKey.get("2@2026-10-08")?.plannedOrderReceipt, 20);
  check("P2 倒排下达日(提前期3)", byKey.get("2@2026-10-08")?.orderReleaseDate, "2026-10-05");
  check("P2 下达行计划下达", byKey.get("2@2026-10-05")?.plannedOrderRelease, 20);
  check("P2 下达行投影回填(期初10)", byKey.get("2@2026-10-05")?.projectedOnHand, 10);
  check("P2 期末投影(10+20+20-50)", byKey.get("2@2026-10-08")?.projectedOnHand, 0);

  // P3: 毛需求 20×3×1.1=66 挂在 P2 下达日 10-05；无库存 → 净 66
  check("P3 毛需求(含损耗率)", byKey.get("3@2026-10-05")?.grossRequirement, 66);
  check("P3 净需求", byKey.get("3@2026-10-05")?.netRequirement, 66);
  check("P3 计划收入", byKey.get("3@2026-10-05")?.plannedOrderReceipt, 66);

  check("统计: 缺口物料数", r.stats.productsWithShortage, 3);
  check("统计: 计划订单数", r.stats.plannedOrders, 3);
  check("统计: 净需求合计", r.stats.totalNetRequirement, 186);
}

// ---------------------------------------------------------------------------
console.log("\n[2] 安全库存：期初低于安全线 → 首日补需求");
{
  const input = baseInput();
  input.products = [product({ id: 4, code: "P4", safetyStock: 100, leadTimePurchase: 2 })];
  input.supplies = [
    { productId: 4, date: "2026-10-05", quantity: 30, sourceType: "inventory", sourceId: null },
  ];
  const r = computeMrp(input);
  const row = r.rows.find((x) => x.productId === 4);
  check("安全库存毛需求(100-30)", row?.grossRequirement, 70);
  check("安全库存来源标记", row?.sourceType, "safety_stock");
  check("倒排下达(首日-2天, 夹取)", row?.orderReleaseDate, "2026-10-03");
  check("过期下达产生警告", r.warnings.length > 0, true);
  check("过期下达夹取到窗口内", r.rows.find((x) => x.plannedOrderRelease > 0)?.requirementDate, "2026-10-05");
}

// ---------------------------------------------------------------------------
console.log("\n[3] 批量规则");
{
  check("lot_for_lot", applyLotSizing("lot_for_lot", 25, 0, 0).qty, 25);
  check("lot_for_lot: 单张", applyLotSizing("lot_for_lot", 25, 0, 0).lots, [25]);
  check("fixed_qty: ceil(25/10)*10", applyLotSizing("fixed_qty", 25, 10, 0).qty, 30);
  check("fixed_qty: 拆成 3 张 × 10", applyLotSizing("fixed_qty", 25, 10, 0).lots, [10, 10, 10]);
  check("fixed_qty: 未维护退化为逐批", applyLotSizing("fixed_qty", 25, 0, 0).qty, 25);
  check("multiples: max(25,50)=50→50", applyLotSizing("multiples", 25, 50, 10).qty, 50);
  check("multiples: ceil(25/10)*10", applyLotSizing("multiples", 25, 0, 10).qty, 30);
  check("净需求 0 → 无计划", applyLotSizing("lot_for_lot", 0, 0, 0).lots, []);
}

// ---------------------------------------------------------------------------
console.log("\n[4] 幻影 BOM 穿透");
{
  // P5 是幻影件（BOM: P6×2），销售要 10 个 P5 → 直接生成 P6 的需求 20，P5 零计划行
  const input = baseInput();
  input.products = [
    product({ id: 5, code: "P5", isManufactured: true, isPurchased: false }),
    product({ id: 6, code: "P6" }),
  ];
  input.boms = [
    { id: 55, productId: 5, quantity: 1, isPhantom: true, lines: [{ materialId: 6, quantity: 2, lossRate: 0 }] },
  ];
  input.demands = [
    { productId: 5, date: "2026-10-06", quantity: 10, sourceType: "sales_order", sourceId: 9002 },
  ];
  const r = computeMrp(input);
  check("幻影件自身无计划行", r.rows.filter((x) => x.productId === 5).length, 0);
  const p6 = r.rows.find((x) => x.productId === 6);
  check("穿透到子件的毛需求", p6?.grossRequirement, 20);
  check("穿透需求挂在同日", p6?.requirementDate, "2026-10-06");
}

// ---------------------------------------------------------------------------
console.log("\n[5] BOM 成环检测");
{
  try {
    computeLowLevelCodes(
      [
        { id: 1, productId: 1, quantity: 1, isPhantom: false, lines: [{ materialId: 2, quantity: 1, lossRate: 0 }] },
        { id: 2, productId: 2, quantity: 1, isPhantom: false, lines: [{ materialId: 1, quantity: 1, lossRate: 0 }] },
      ],
      [1, 2],
    );
    check("成环应抛错", "no-error", "error");
  } catch (err) {
    check("成环抛错含提示", err instanceof Error && err.message.includes("循环引用"), true);
  }
}

// ---------------------------------------------------------------------------
console.log("\n[6] 多来源同桶 → mixed；窗口外日期夹取");
{
  const input = baseInput();
  input.products = [product({ id: 7, code: "P7" })];
  input.demands = [
    { productId: 7, date: "2026-10-06", quantity: 5, sourceType: "sales_order", sourceId: 1 },
    { productId: 7, date: "2026-10-06", quantity: 7, sourceType: "sales_order", sourceId: 2 },
    // 早于窗口的逾期需求夹取到首日
    { productId: 7, date: "2026-10-01", quantity: 3, sourceType: "production_order", sourceId: 3 },
  ];
  const r = computeMrp(input);
  const mixed = r.rows.find((x) => x.requirementDate === "2026-10-06");
  check("同桶多来源 gross", mixed?.grossRequirement, 12);
  check("同桶多来源标记 mixed", mixed?.sourceType, "mixed");
  const clamped = r.rows.find((x) => x.requirementDate === "2026-10-05");
  check("逾期需求夹取到首日", clamped?.grossRequirement, 3);
}

// ---------------------------------------------------------------------------
console.log("\n[7] addDays");
{
  check("跨月", addDays("2026-10-31", 1), "2026-11-01");
  check("跨年", addDays("2026-12-31", 1), "2027-01-01");
  check("负数", addDays("2026-10-05", -5), "2026-09-30");
}

// ---------------------------------------------------------------------------
console.log("\n[8] 批量规则 max_qty（单张上限 → 拆单）");
{
  // 上限未维护：无法拆单，退化为逐批补充（旧参数兼容），必须发警告
  const fallback = applyLotSizing("max_qty", 25, 0, 0, 0);
  check("上限未维护 → 逐批", fallback.qty, 25);
  check("上限未维护 → 有警告", (fallback.warning ?? "").includes("max_qty"), true);

  // 25 拆成 3 张（ceil(25/10)），单张不得超过 10，总量不得小于净需求
  const split = applyLotSizing("max_qty", 25, 0, 0, 10);
  check("拆单张数 = ceil(25/10)", split.lots.length, 3);
  check("单张都不超上限", split.lots.every((q) => q <= 10), true);
  check("总量 ≥ 净需求（不吞缺口）", split.qty >= 25, true);
  check("无警告（上限已维护）", split.warning, undefined);

  // 整除场景：100 / 上限 30 → 4 张，均分 25，且倍数取整 5 后仍是 25
  const even = applyLotSizing("max_qty", 100, 0, 5, 30);
  check("100 上限 30 → 4 张", even.lots.length, 4);
  check("均分 25（5 的倍数）", even.lots, [25, 25, 25, 25]);
  check("总量 = 100", even.qty, 100);

  // 上限大于需求：不拆
  check("需求 10 上限 50 → 1 张 10", applyLotSizing("max_qty", 10, 0, 0, 50).lots, [10]);

  // min_order_qty 兜底：需求 5、单张下限 20 → 一张 20
  check("min_order_qty 兜底", applyLotSizing("max_qty", 5, 20, 0, 100).lots, [20]);
}

// ---------------------------------------------------------------------------
console.log("\n[9] 工作日历（提前期倒排 + 需求日对齐）");
{
  // 2026-10-05 周一 … 10-09 周五，10-10 周六，10-11 周日，10-12 周一
  check("ISO 星期：周一", isoWeekday("2026-10-05"), 1);
  check("ISO 星期：周日", isoWeekday("2026-10-11"), 7);

  check("无日历 → 天天上班", isWorkingDay("2026-10-11", null), true);
  check("周一~五上班：周六不上班", isWorkingDay("2026-10-10", CAL_WEEKDAY), false);
  check("周一~五上班：周五上班", isWorkingDay("2026-10-09", CAL_WEEKDAY), true);
  check("例外日放假优先于周规律", isWorkingDay("2026-10-07", CAL_HOLIDAY), false);
  check("例外日调休优先于周规律", isWorkingDay("2026-10-10", CAL_HOLIDAY), true);

  // 倒排：10-12（周一）往前 1 个工作日 = 10-09（周五），自然日则是 10-11（周日）
  check("倒排 1 个工作日", subtractWorkingDays("2026-10-12", 1, CAL_WEEKDAY), "2026-10-09");
  check("倒排 1 天（自然日）", subtractWorkingDays("2026-10-12", 1, null), "2026-10-11");
  check("倒排 0 个工作日 = 原日", subtractWorkingDays("2026-10-12", 0, CAL_WEEKDAY), "2026-10-12");
  // 10-12 往前 4 个工作日：10-09、10-08、10-07（放假跳过）、10-06 → 10-06
  check("倒排跨节假日", subtractWorkingDays("2026-10-12", 4, CAL_HOLIDAY), "2026-10-06");
  // 调休上班让 10-10 计入工作日
  check("倒排计入调休", subtractWorkingDays("2026-10-12", 2, CAL_HOLIDAY), "2026-10-09");

  // 需求日对齐：周日需求提前到周五
  check("周日需求→上周五", snapToWorkingDay("2026-10-11", CAL_WEEKDAY), "2026-10-09");
  check("工作日需求不变", snapToWorkingDay("2026-10-09", CAL_WEEKDAY), "2026-10-09");
  check("无日历不调整", snapToWorkingDay("2026-10-11", null), "2026-10-11");
  check("调休日需求不调整", snapToWorkingDay("2026-10-10", CAL_HOLIDAY), "2026-10-10");

  // 集成：10-12 的需求，按工作日倒排 3 个工作日 = 10-07；自然日 = 10-09
  const withCal = baseInput();
  withCal.products = [product({ id: 20, code: "C1", leadTimePurchase: 3 })];
  withCal.demands = [
    { productId: 20, date: "2026-10-12", quantity: 10, sourceType: "sales_order", sourceId: 1 },
  ];
  withCal.workCalendar = CAL_WEEKDAY;
  const rCal = computeMrp(withCal);
  check("工作日倒排下达日", rCal.rows.find((x) => x.plannedOrderReceipt > 0)?.orderReleaseDate, "2026-10-07");
  check("统计: 采用的工作日历", rCal.stats.workCalendar, "测试日历A");
  check("统计: 计划订单数", rCal.stats.plannedOrders, 1);

  const noCal = baseInput();
  noCal.products = [product({ id: 20, code: "C1", leadTimePurchase: 3 })];
  noCal.demands = [
    { productId: 20, date: "2026-10-12", quantity: 10, sourceType: "sales_order", sourceId: 1 },
  ];
  const rNoCal = computeMrp(noCal);
  check("无日历按自然日倒排", rNoCal.rows.find((x) => x.plannedOrderReceipt > 0)?.orderReleaseDate, "2026-10-09");
  check("统计: 无工作日历", rNoCal.stats.workCalendar, null);

  // 集成：周日需求被提前到周五（毛需求桶跟着走）
  const snap = baseInput();
  snap.products = [product({ id: 21, code: "C2" })];
  snap.demands = [
    { productId: 21, date: "2026-10-11", quantity: 8, sourceType: "sales_order", sourceId: 2 },
  ];
  snap.workCalendar = CAL_WEEKDAY;
  const rSnap = computeMrp(snap);
  check("周日需求挂到周五", rSnap.rows[0]?.requirementDate, "2026-10-09");
  check("周日需求数量不变", rSnap.rows[0]?.grossRequirement, 8);
}

// ---------------------------------------------------------------------------
console.log("\n[10] 订货点补货");
{
  const base = () => {
    const input = baseInput();
    input.startDate = "2026-10-05";
    input.endDate = "2026-10-14";
    return input;
  };

  // 10.1 只跌不涨：期初 5、订货点 20、最高库存 60 → 首日补到 60，其后不再触发
  {
    const input = base();
    input.products = [product({ id: 30, code: "R1", orderPoint: 20, maxStock: 60 })];
    input.supplies = [
      { productId: 30, date: "2026-10-05", quantity: 5, sourceType: "inventory", sourceId: null },
    ];
    const r = computeMrp(input);
    const row = r.rows.find((x) => x.productId === 30);
    check("补货桶数 = 1（补到位后不再重复）", r.rows.filter((x) => x.productId === 30).length, 1);
    check("补货桶无毛需求", row?.grossRequirement, 0);
    check("补到最高库存：净需求 = 60-5", row?.netRequirement, 55);
    check("计划收入 55", row?.plannedOrderReceipt, 55);
    check("补货后预计可用 = 60", row?.projectedOnHand, 60);
    check("来源标记 order_point", row?.sourceType, "order_point");
    check("统计: 订货点物料数", r.stats.reorderPointProducts, 1);
    check("统计: 触发次数", r.stats.reorderTriggers, 1);
  }

  // 10.2 未维护最高库存 → 补到订货点
  {
    const input = base();
    input.products = [product({ id: 31, code: "R2", orderPoint: 20 })];
    input.supplies = [
      { productId: 31, date: "2026-10-05", quantity: 5, sourceType: "inventory", sourceId: null },
    ];
    const r = computeMrp(input);
    const row = r.rows.find((x) => x.productId === 31);
    check("补到订货点：净需求 = 20-5", row?.netRequirement, 15);
    check("补到订货点：预计可用 = 20", row?.projectedOnHand, 20);
  }

  // 10.3 安全库存并入目标水位：不再单独生成首日安全库存需求（否则同一缺口补两次）
  {
    const input = base();
    input.products = [
      product({ id: 32, code: "R3", orderPoint: 20, safetyStock: 50 }),
    ];
    input.supplies = [
      { productId: 32, date: "2026-10-05", quantity: 5, sourceType: "inventory", sourceId: null },
    ];
    const r = computeMrp(input);
    const row = r.rows.find((x) => x.productId === 32);
    check("无安全库存毛需求（并入订货点）", row?.grossRequirement, 0);
    check("目标水位取 max(订货点, 安全库存)", row?.projectedOnHand, 50);
    check(
      "发提示说明安全库存已并入",
      r.warnings.some((w) => w.message.includes("安全库存") && w.message.includes("订货点")),
      true,
    );
  }

  // 10.4 先消耗再触发：期初 100、订货点 20、最高库存 50，10-08 出 90 → 补到 50
  {
    const input = base();
    input.products = [product({ id: 33, code: "R4", orderPoint: 20, maxStock: 50 })];
    input.supplies = [
      { productId: 33, date: "2026-10-05", quantity: 100, sourceType: "inventory", sourceId: null },
    ];
    input.demands = [
      { productId: 33, date: "2026-10-08", quantity: 90, sourceType: "sales_order", sourceId: 7 },
    ];
    const r = computeMrp(input);
    const row = r.rows.find((x) => x.productId === 33);
    check("触发日 = 消耗日", row?.requirementDate, "2026-10-08");
    check("消耗 90 + 补货 40 → 预计 50", row?.projectedOnHand, 50);
    check("净需求 = 需求驱动的 0 + 补货 40", row?.netRequirement, 40);
    check("计划收入 40", row?.plannedOrderReceipt, 40);
    check("与需求同桶 → mixed", row?.sourceType, "mixed");
    check("统计: 只触发一次", r.stats.reorderTriggers, 1);
  }

  // 10.5 订货点为 0 的物料完全不受影响（回归：别把普通物料也补货）
  {
    const input = base();
    input.products = [product({ id: 34, code: "R5", maxStock: 100 })];
    input.supplies = [
      { productId: 34, date: "2026-10-05", quantity: 5, sourceType: "inventory", sourceId: null },
    ];
    const r = computeMrp(input);
    check("无订货点 → 无计划行", r.rows.length, 0);
    check("无订货点 → 触发 0 次", r.stats.reorderTriggers, 0);
    check("无订货点 → 物料数 0", r.stats.reorderPointProducts, 0);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
