import type { AiGraphState } from "../state.js";
import { callChatModel } from "../../config/llm.js";

export async function toolExecutorNode(state: AiGraphState): Promise<AiGraphState> {
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const systemPrompt = [
    "你是 OPERP ERP 助手。",
    "优先根据用户意图、当前页面和历史上下文回答。",
    `意图：${state.intent || "chat"}`,
    `域：${state.domain || "general"}`,
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    plan.length ? `计划：${JSON.stringify(plan)}` : "计划：无",
  ].join("\n");

  const { content, raw } = await callChatModel(
    [
      { role: "system", content: systemPrompt },
      ...state.recentMessages.map((item) => {
        const record = item as { role?: "user" | "assistant"; content?: string };
        return {
          role: record.role === "assistant" ? "assistant" : "user",
          content: record.content || "",
        } as const;
      }),
      { role: "user", content: state.text },
    ],
    state.provider,
  );

  const toolResults = plan.map((item) => ({
    step: (item as { step: string }).step,
    ok: true,
    output: (raw as Record<string, unknown>).choices ? "model_response" : "raw_response",
  }));

  return {
    ...state,
    toolResults,
    reply: content || "模型未返回内容。",
  };
}
