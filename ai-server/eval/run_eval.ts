/**
 * AI 链路简单 eval 集（#10）。
 *
 * 覆盖两类**确定性**逻辑（不调 LLM、不连库，秒级跑完，适合每次改动后回归）：
 *   1. intentRouter 的 ruleFallback 规则路由 —— prompt 一改、词表一动，
 *      在这里立刻能看出哪些意图分类退化；
 *   2. entityRegistry 的 evaluateWritePolicy / evaluateDeletePolicy ——
 *      写保护白名单（权限表 / sys_ai_* 只读）绝不允许静默放宽。
 *
 * LLM 依赖的链路（模型路由准确率、字段提取质量）属于在线评测，
 * 等有标注样本后可以在这里追加：跑真实 provider + 评分脚本。
 *
 * 运行：npm run eval（或 npx tsx eval/run_eval.ts）
 * 退出码：通过 0；任何失败 1 —— 可以直接挂 CI。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ruleFallback } from "../src/ai/nodes/intentRouter.js";
import { buildMultiStepPlan } from "../src/ai/nodes/planner.js";
import { detectDocumentAction, detectDocumentType } from "../src/services/documentService.js";
import { evaluateWritePolicy, evaluateDeletePolicy } from "../src/tools/entityRegistry.js";

interface IntentCase {
  text: string;
  expect: { intent: string; target?: string; queryMode?: string };
}
interface PolicyCase {
  table: string;
  writable: boolean;
}
interface DocumentCase {
  text: string;
  type: string | null;
  action: string | null;
}
interface PlanCase {
  text: string;
  tools: string[] | null;
  /** 可选：断言每一步的 input.action（多步计划里第二步的动作语义） */
  actions?: string[] | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf-8")) as {
  intent_cases: IntentCase[];
  policy_cases: PolicyCase[];
  document_cases: DocumentCase[];
  plan_cases: PlanCase[];
};

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log("== 意图路由 ruleFallback ==");

for (const item of cases.intent_cases) {
  const routed = ruleFallback({
    sessionId: "eval",
    text: item.text,
    skill: "auto",
  } as Parameters<typeof ruleFallback>[0]);

  const checks: Array<[string, unknown, unknown]> = [
    ["intent", routed.intent, item.expect.intent],
  ];
  if (item.expect.target !== undefined) checks.push(["target", routed.target, item.expect.target]);
  if (item.expect.queryMode !== undefined) {
    checks.push(["queryMode", routed.queryMode, item.expect.queryMode]);
  }

  const bad = checks.filter(([, got, want]) => got !== want);
  if (bad.length === 0) {
    pass += 1;
    console.log(`  PASS  ${item.text}`);
  } else {
    fail += 1;
    const detail = bad.map(([name, got, want]) => `${name}: got=${got} want=${want}`).join("; ");
    failures.push(`[intent] "${item.text}" → ${detail}`);
    console.log(`  FAIL  ${item.text} → ${detail}`);
  }
}

console.log("\n== 单据解析（类型 / 动作）==");

for (const item of cases.document_cases ?? []) {
  const gotType = detectDocumentType(item.text);
  const gotAction = detectDocumentAction(item.text);
  const bad: string[] = [];
  if (gotType !== item.type) bad.push(`type: got=${gotType} want=${item.type}`);
  if (gotAction !== item.action) bad.push(`action: got=${gotAction} want=${item.action}`);
  if (!bad.length) {
    pass += 1;
    console.log(`  PASS  ${item.text}`);
  } else {
    fail += 1;
    failures.push(`[document] "${item.text}" → ${bad.join("; ")}`);
    console.log(`  FAIL  ${item.text} → ${bad.join("; ")}`);
  }
}

console.log("\n== 多步计划 buildMultiStepPlan ==");

for (const item of cases.plan_cases ?? []) {
  const plan = buildMultiStepPlan({
    sessionId: "eval",
    text: item.text,
    skill: "auto",
    recentMessages: [],
  } as Parameters<typeof buildMultiStepPlan>[0]);
  const gotTools = plan ? plan.map((step) => step.tool) : null;
  const gotActions = plan
    ? plan.map((step) => String((step.input as Record<string, unknown> | undefined)?.action ?? ""))
    : null;
  const same =
    (gotTools === null && item.tools === null) ||
    (Array.isArray(gotTools) && Array.isArray(item.tools) && gotTools.join(",") === item.tools.join(","));
  const actionsSame =
    item.actions === undefined ||
    item.actions === null ||
    (gotActions !== null && gotActions.join(",") === item.actions.join(","));
  if (same && actionsSame) {
    pass += 1;
    console.log(`  PASS  ${item.text} → ${gotTools ? gotTools.join(" → ") : "单步"}${gotActions ? ` [${gotActions.map((a) => a || "-").join(", ")}]` : ""}`);
  } else {
    fail += 1;
    const detail = `got=${gotTools ? gotTools.join(",") : "single"}${actionsSame ? "" : ` actions=${gotActions ? gotActions.join(",") : "n/a"} want=${item.actions?.join(",")}`}`;
    failures.push(`[plan] "${item.text}" → ${detail}`);
    console.log(`  FAIL  ${item.text} → ${detail}`);
  }
}

console.log("\n== 写保护策略 evaluateWritePolicy ==");

for (const item of cases.policy_cases) {
  const got = evaluateWritePolicy(item.table).writable;
  if (got === item.writable) {
    pass += 1;
    console.log(`  PASS  ${item.table} → writable=${got}`);
  } else {
    fail += 1;
    failures.push(`[policy] ${item.table}: got=${got} want=${item.writable}`);
    console.log(`  FAIL  ${item.table}: got=${got} want=${item.writable}`);
  }
}

console.log("\n== 删除策略 evaluateDeletePolicy ==");

const deletePolicy = evaluateDeletePolicy();
if (!deletePolicy.writable) {
  pass += 1;
  console.log("  PASS  删除能力保持全禁");
} else {
  fail += 1;
  failures.push("[delete] 删除能力被放开了！");
  console.log("  FAIL  删除能力被放开了！");
}

const total = pass + fail;
console.log(`\n结果：${pass}/${total} 通过（准确率 ${((pass / total) * 100).toFixed(1)}%）`);

if (fail > 0) {
  console.log("\n失败明细：");
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
