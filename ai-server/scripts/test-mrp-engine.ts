/**
 * MRP 引擎纯函数核心断言测试（不连数据库）。
 * 运行：npx tsx scripts/test-mrp-engine.ts
 */
import {
  addDays,
  applyLotSizing,
  computeLowLevelCodes,
  computeMrp,
  type MrpBomInput,
  type MrpDemandInput,
  type MrpEngineInput,
  type MrpProductInput,
  type MrpSupplyInput,
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
    leadTimePurchase: 0,
    leadTimeProduction: 0,
    lotPolicy: "lot_for_lot",
    minOrderQty: 0,
    orderMultiple: 0,
    ...partial,
  };
}

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
  check("fixed_qty: ceil(25/10)*10", applyLotSizing("fixed_qty", 25, 10, 0).qty, 30);
  check("fixed_qty: 未维护退化为逐批", applyLotSizing("fixed_qty", 25, 0, 0).qty, 25);
  check("multiples: max(25,50)=50→50", applyLotSizing("multiples", 25, 50, 10).qty, 50);
  check("multiples: ceil(25/10)*10", applyLotSizing("multiples", 25, 0, 10).qty, 30);
  check("max_qty 回退 lot_for_lot", applyLotSizing("max_qty", 25, 0, 0).qty, 25);
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
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
