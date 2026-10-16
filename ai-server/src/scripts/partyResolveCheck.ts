/**
 * 主数据引用解析自检（**真实代码路径 + 真实库，全程只读**）。
 *
 * 覆盖：客户 / 供应商 / 仓库 的引用支持「编码 · 名称 · 简称」三种写法。
 *
 * 为什么单独有这么一个脚本：`npm run eval` 是纯逻辑、不连库的，而这类 bug
 * 恰恰出在「SQL 条件写窄了」上 —— 历史事故：客户解析只按 `name` 列 ILIKE，
 * 用户直接报**客户编码**（Carrefour）时必然查不到，且报错还误导人（「请确认
 * 名称是否正确」）。这类回归只有打真实查询路径才拦得住。
 *
 * 用法（在 ai-server 目录下，需 .env 里配好本机 SUPABASE_URL / SERVICE_ROLE）：
 *   npm run resolve:check
 *
 * 断言口径：只写「解析出的 id 对不对」「错误里有没有明确提示」，
 * 不写「库里恰好几行」—— 别人往库里加客户不应该让本脚本红。
 */
import { DOCUMENT_TYPES, prepareDocumentInput } from "../services/documentService.js";
import type { AiGraphState } from "../ai/state.js";

let pass = 0;
let fail = 0;

const check = (title: string, ok: boolean, detail: string): void => {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${title}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${title}\n      ${detail}`);
  }
};

/** 构造最小可用 state：本脚本只跑 single-turn 的「抽取结果 → id 解析」这一步 */
const makeState = (tenantId: number, text: string): AiGraphState =>
  ({
    sessionId: "resolve-check",
    tenantId,
    text,
    skill: "erp",
    locale: "zh-CN",
    recentMessages: [],
  }) as unknown as AiGraphState;

const salesOrder = DOCUMENT_TYPES.sales_order;
const purchaseReceipt = DOCUMENT_TYPES.purchase_receipt;

/** 跑一次解析，返回归一结果（header.customer_id / header.warehouse_id / error / notes） */
const run = async (state: AiGraphState, meta: typeof salesOrder, raw: Record<string, unknown>) => {
  const result = await prepareDocumentInput(state, meta, raw as never);
  return {
    error: result.error,
    header: (result.prepared?.header || {}) as Record<string, unknown>,
    lines: result.prepared?.lines || [],
    notes: (result.prepared?.notes || []).join("\n"),
  };
};

const TENANT = 3;
/** 本机 dev 库里的确定性样本（见 scripts/verify/probe-*）：客户 55 沃尔玛/Walmart，75 家乐福/Carrefour */
const CARREFOUR_ID = 75;
const WALMART_ID = 55;
const FINISHED_WAREHOUSE_ID = 214;

(async () => {
  /* ---------- ① 客户：编码 ---------- */
  console.log("\n[客户] 编码写法");
  const byCode = await run(makeState(TENANT, "帮我新建一个销售订单，物料是P-2026-0020，数量100，客户Carrefour"), salesOrder, {
    party_name: "Carrefour",
    lines: [{ product_id: "P-2026-0020", quantity: 100 }],
  });
  check(
    "客户编码 Carrefour → 解析到 id 75",
    byCode.header.customer_id === CARREFOUR_ID,
    JSON.stringify({ error: byCode.error, header: byCode.header }),
  );
  check(
    "命中回显里带上匹配到的记录（用户能看出没填错）",
    /匹配到/.test(byCode.notes) && /家乐福/.test(byCode.notes),
    byCode.notes,
  );
  check(
    "明细物料 P-2026-0020 同时解析成功（id 708）",
    Number((byCode.lines[0] as Record<string, unknown> | undefined)?.product_id) === 708,
    JSON.stringify(byCode.lines),
  );

  const byLowerCode = await run(makeState(TENANT, "销售订单 客户 carrefour"), salesOrder, {
    party_name: "carrefour",
  });
  check(
    "编码大小写不敏感（carrefour）",
    byLowerCode.header.customer_id === CARREFOUR_ID,
    JSON.stringify({ error: byLowerCode.error, header: byLowerCode.header }),
  );

  const byPartialCode = await run(makeState(TENANT, "销售订单 客户 carre"), salesOrder, {
    party_name: "carre",
  });
  check(
    "编码包含匹配（carre）",
    byPartialCode.header.customer_id === CARREFOUR_ID,
    JSON.stringify({ error: byPartialCode.error, header: byPartialCode.header }),
  );

  /* ---------- ② 客户：名称（老行为不能回归） ---------- */
  console.log("\n[客户] 名称写法（原行为）");
  const byName = await run(makeState(TENANT, "销售订单 客户 家乐福"), salesOrder, {
    party_name: "家乐福",
  });
  check(
    "客户名称 家乐福 → 75 且不额外回显「匹配到」",
    byName.header.customer_id === CARREFOUR_ID && !/匹配到/.test(byName.notes),
    JSON.stringify({ error: byName.error, header: byName.header, notes: byName.notes }),
  );
  const walmart = await run(makeState(TENANT, "销售订单 客户 Walmart"), salesOrder, {
    party_name: "Walmart",
  });
  check(
    "另一个客户编码 Walmart → 55",
    walmart.header.customer_id === WALMART_ID,
    JSON.stringify({ error: walmart.error, header: walmart.header }),
  );

  /* ---------- ③ 查不到 / 租户隔离 ---------- */
  console.log("\n[客户] 查不到与租户隔离");
  const missing = await run(makeState(TENANT, "销售订单 客户 不存在公司"), salesOrder, {
    party_name: "不存在的客户XYZ",
  });
  check(
    "查不到时报错，且提示「名称或编码」（不再只提名称）",
    !!missing.error && /没有找到客户/.test(missing.error) && /名称或编码/.test(missing.error),
    String(missing.error),
  );
  const otherTenant = await run(makeState(1, "销售订单 客户 Carrefour"), salesOrder, {
    party_name: "Carrefour",
  });
  check(
    "租户隔离：tenant 1 查不到 tenant 3 的客户",
    !!otherTenant.error && otherTenant.header.customer_id === undefined,
    JSON.stringify({ error: otherTenant.error, header: otherTenant.header }),
  );

  /* ---------- ④ 仓库（编码 / 名称） ---------- */
  // 用销售订单做载体：采购入库单会先要求供应商，仓库那一段就走不到
  console.log("\n[仓库] 编码与名称");
  const whByCode = await run(makeState(TENANT, "销售订单 客户 家乐福 仓库 CPK"), salesOrder, {
    party_name: "家乐福",
    warehouse_name: "CPK",
  });
  check(
    "仓库编码 CPK → 214",
    whByCode.header.warehouse_id === FINISHED_WAREHOUSE_ID,
    JSON.stringify({ error: whByCode.error, header: whByCode.header }),
  );
  const whByName = await run(makeState(TENANT, "销售订单 客户 家乐福 仓库 成品库"), salesOrder, {
    party_name: "家乐福",
    warehouse_name: "成品库",
  });
  check(
    "仓库名称 成品库 → 214",
    whByName.header.warehouse_id === FINISHED_WAREHOUSE_ID,
    JSON.stringify({ error: whByName.error, header: whByName.header }),
  );

  /* ---------- ⑤ 供应商（编码 / 名称） ---------- */
  console.log("\n[供应商] 编码与名称");
  const supByCode = await run(makeState(TENANT, "采购入库单 供应商 WXZZ"), purchaseReceipt, {
    party_name: "WXZZ",
  });
  check(
    "供应商编码 WXZZ → 100",
    supByCode.header.supplier_id === 100,
    JSON.stringify({ error: supByCode.error, header: supByCode.header }),
  );
  const supByName = await run(makeState(TENANT, "采购入库单 供应商 无锡制造总公司"), purchaseReceipt, {
    party_name: "无锡制造总公司",
  });
  check(
    "供应商名称 无锡制造总公司 → 100",
    supByName.header.supplier_id === 100,
    JSON.stringify({ error: supByName.error, header: supByName.header }),
  );

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})();
