import type { AiGraphState } from "../state.js";
import { callChatModel } from "../../config/llm.js";
import { createOrUpdateBaqTool, createOrUpdateEntityTool, financeSummaryTool } from "../../tools/erpTools.js";

export async function toolExecutorNode(state: AiGraphState): Promise<AiGraphState> {
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const tool = plan[0] as { tool?: string } | undefined;

  if (tool?.tool === "baq.upsert") {
    const result = await createOrUpdateBaqTool(state);
    return {
      ...state,
      toolResults: [result],
      reply: result.reply,
      focus: result.focus,
      route: result.route,
      routeLabel: result.routeLabel,
      needConfirmation: result.needConfirmation,
      nextQuestions: result.nextQuestions,
    };
  }

  if (tool?.tool === "entity.upsert") {
    const result = await createOrUpdateEntityTool(state, undefined, state.action === "update" ? "update" : "create");
    return {
      ...state,
      toolResults: [result],
      reply: result.reply,
      focus: result.focus,
      route: result.route,
      routeLabel: result.routeLabel,
      needConfirmation: result.needConfirmation,
      nextQuestions: result.nextQuestions,
    };
  }

  if (tool?.tool === "entity.create") {
    const result = await createOrUpdateEntityTool(state, undefined, "create");
    return {
      ...state,
      toolResults: [result],
      reply: result.reply,
      focus: result.focus,
      route: result.route,
      routeLabel: result.routeLabel,
      needConfirmation: result.needConfirmation,
      nextQuestions: result.nextQuestions,
    };
  }

  if (tool?.tool === "entity.update") {
    const result = await createOrUpdateEntityTool(state, undefined, "update");
    return {
      ...state,
      toolResults: [result],
      reply: result.reply,
      focus: result.focus,
      route: result.route,
      routeLabel: result.routeLabel,
      needConfirmation: result.needConfirmation,
      nextQuestions: result.nextQuestions,
    };
  }

  if (tool?.tool === "finance.summary") {
    const result = await financeSummaryTool(state);
    return {
      ...state,
      toolResults: [result],
      reply: result.reply,
      focus: result.focus,
      route: result.route,
      routeLabel: result.routeLabel,
      needConfirmation: result.needConfirmation,
      nextQuestions: result.nextQuestions,
    };
  }

  if (tool?.tool === "knowledge.search") {
    return {
      ...state,
      toolResults: [{ step: "knowledge_search", ok: true, output: "knowledge_stub" }],
      reply: "已识别为知识库查询意图，但当前知识库检索节点还未接入，先按已有上下文继续回答。",
    };
  }

  const systemPrompt = [
    "你是 OPERP ERP 助手。",
    "你正在通过 OPERP AI 服务工作。不要声称自己没有 ERP 写入权限；当计划中存在业务工具时，工具执行由服务端负责。",
    "优先根据用户意图、当前页面和历史上下文回答。",
    `意图：${state.intent || "chat"}`,
    `域：${state.domain || "general"}`,
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    plan.length ? `计划：${JSON.stringify(plan)}` : "计划：无",
    "如果当前只是普通咨询，直接回答用户问题；不要编造工具执行结果。",
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

  return {
    ...state,
    toolResults: [{ step: "draft_reply", ok: true, output: (raw as Record<string, unknown>).choices ? "model_response" : "raw_response" }],
    reply: content || "模型未返回内容。",
  };
}
