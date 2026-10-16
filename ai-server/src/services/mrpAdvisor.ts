/**
 * MRP 分析报告生成（LLM 解释层）。
 *
 * 边界（2026-10-02 与用户确认的设计）：LLM 只「解读」引擎输出，绝不参与计算。
 * - 喂给模型的是引擎 stats 的紧凑摘要（Top 缺口 + 警告），不是全量需求行。
 * - 明确要求模型不得编造数字；所有数字只能来自输入数据。
 * - LLM 失败 / 未配置 provider 时回退到确定性摘要 —— 报告生成失败绝不影响运算结果
 *   （计划状态此时已是 completed，引擎结果已落库）。
 */
import { callChatModel } from "../config/llm.js";
import { resolveDefaultProvider } from "./aiProvider.js";
import type { MrpEngineResult } from "./mrpEngine.js";
import type { MrpPlanRow } from "./mrpService.js";

export interface MrpReportOutcome {
  report: string;
  generatedBy: "llm" | "fallback";
  llmError?: string;
}

/** 喂给 LLM 的短缺行上限：防止上下文膨胀，Top 缺口足够解读用 */
const MAX_SHORTAGES = 30;
const MAX_WARNINGS = 20;

function buildFallbackReport(plan: MrpPlanRow, result: MrpEngineResult): string {
  const { stats } = result;
  const lines: string[] = [
    `## MRP 运算摘要（${plan.plan_no}）`,
    "",
    `- 计划区间：${plan.start_date} ~ ${plan.end_date}（${stats.bucketDays} 天）`,
    `- 参与运算物料：${stats.relevantProducts} 个，其中 ${stats.plannedProducts} 个产生了计划行`,
    `- 出现缺口物料：${stats.productsWithShortage} 个，净需求合计 ${stats.totalNetRequirement}`,
    `- 生成计划订单：${stats.plannedOrders} 张`,
  ];

  // P0-4：订货点补货与工作日历会影响数字解读，摘要里必须点出来
  //（否则计划员看到「净需求」里混着补货量会以为哪里算错了）
  if (stats.reorderPointProducts > 0) {
    lines.push(
      `- 订货点补货：${stats.reorderPointProducts} 个物料启用了订货点，本次触发 ${stats.reorderTriggers} 次补货（补货量已计入上面的净需求合计）`,
    );
  }
  lines.push(
    stats.workCalendar
      ? `- 提前期口径：按工作日历「${stats.workCalendar}」倒推下达日`
      : "- 提前期口径：未启用工作日历，按自然日倒推下达日（下达日可能落在周末/节假日）",
  );

  if (stats.shortages.length > 0) {
    lines.push("", "### 缺口清单", "", "| 物料 | 首次缺口日 | 净需求合计 | 计划订单数 | 首次下达日 |", "|---|---|---|---|---|");
    for (const s of stats.shortages.slice(0, MAX_SHORTAGES)) {
      lines.push(
        `| ${s.code} ${s.name} | ${s.firstShortDate} | ${s.totalNetRequirement} | ${s.plannedOrderCount} | ${s.firstPlannedReleaseDate ?? "-"} |`,
      );
    }
  } else {
    lines.push("", "计划区间内未发现物料缺口。");
  }

  if (result.warnings.length > 0) {
    lines.push("", "### 警告", "");
    for (const w of result.warnings.slice(0, MAX_WARNINGS)) {
      lines.push(`- [${w.code}] ${w.message}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(plan: MrpPlanRow, result: MrpEngineResult): { system: string; user: string } {
  const { stats } = result;
  const compact = {
    plan: {
      no: plan.plan_no,
      window: `${plan.start_date} ~ ${plan.end_date}`,
      days: stats.bucketDays,
    },
    totals: {
      relevantProducts: stats.relevantProducts,
      plannedProducts: stats.plannedProducts,
      productsWithShortage: stats.productsWithShortage,
      totalNetRequirement: stats.totalNetRequirement,
      plannedOrders: stats.plannedOrders,
      // P0-4：让 LLM 知道净需求里含订货点补货、以及提前期是按哪种口径倒推的
      reorderPointProducts: stats.reorderPointProducts,
      reorderTriggers: stats.reorderTriggers,
      workCalendar: stats.workCalendar,
    },
    // 只给 Top 缺口，不给全量需求行 —— 模型不需要也不应该看到逐行数据
    shortages: stats.shortages.slice(0, MAX_SHORTAGES),
    warnings: result.warnings.slice(0, MAX_WARNINGS).map((w) => `[${w.code}] ${w.message}`),
  };

  const system = [
    "你是一名 ERP 物料计划顾问。用户刚跑完一次 MRP 运算，引擎已经算出全部数字。",
    "你的任务是用简体中文写一份给计划员看的分析报告，帮助他决定先做什么。",
    "硬性规则：",
    "1. 你不是计算引擎：报告中出现的所有数字必须原样引用输入数据，禁止自己加总、推算或编造任何数字。",
    "2. 不要输出全量数据表格，重点写解读和建议（优先级、风险、需要人工确认的动作）。",
    "3. 输出用 Markdown，控制在 400 字以内，结构建议：总体结论 → 需要立即关注 → 建议动作。",
    "4. 如果没有缺口，直接说明计划区间内供需平衡，并给 1-2 条保持库存健康的建议。",
  ].join("\n");

  const user = `MRP 引擎输出摘要（JSON）：\n${JSON.stringify(compact, null, 2)}\n\n请基于以上数据撰写分析报告。`;

  return { system, user };
}

export async function generateMrpReport(plan: MrpPlanRow, result: MrpEngineResult): Promise<MrpReportOutcome> {
  const fallback = buildFallbackReport(plan, result);

  try {
    const provider = await resolveDefaultProvider(plan.tenant_id);
    const { system, user } = buildPrompt(plan, result);
    const response = await callChatModel(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        endpoint: provider.endpoint,
        apiKey: provider.apiKey,
        model: provider.model,
        apiType: provider.apiType,
        temperature: provider.temperature ?? 0.2,
      },
      "mrp_advisor",
    );

    const content = String(response.content || "").trim();
    if (!content) {
      return { report: fallback, generatedBy: "fallback", llmError: "模型返回空内容" };
    }
    return { report: content, generatedBy: "llm" };
  } catch (err) {
    return {
      report: fallback,
      generatedBy: "fallback",
      llmError: err instanceof Error ? err.message : String(err),
    };
  }
}
