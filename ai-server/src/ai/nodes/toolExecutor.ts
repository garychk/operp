import type { AiGraphState } from "../state.js";
import { callChatModel } from "../../config/llm.js";
import { countMasterDataTool, createOrUpdateBaqTool, createOrUpdateEntityTool, financeSummaryTool } from "../../tools/erpTools.js";
import { searchKnowledgeDocs } from "../../services/knowledgeBase.js";

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

  if (tool?.tool === "business.analysis" || tool?.tool === "production.analysis" || tool?.tool === "inventory.summary") {
    const systemPrompt = [
      "你是 OPERP 的通用业务分析助手。",
      "请根据用户问题、上下文和已知焦点，判断用户到底想查什么、应该如何分析、答案应该用什么形式展现。",
      "分析时必须先给出：目标对象、要查的指标、建议的数据范围/时间范围、展示形式。",
      "如果对象不明确，先给出最合理的默认判断，并明确说明依据；实在不够信息时，主动追问最少必要字段。",
      "如果用户是在问数量、趋势、明细、异常，请明确选择相应的默认 query mode，不要一律输出财务分析。",
      `意图：${state.intent || "analysis"}`,
      `目标：${state.target || "unknown"}`,
      `查询模式：${state.queryMode || "summary"}`,
      `响应模式：${state.responseMode || "text"}`,
      state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
      `用户原话：${state.text}`,
    ].join("\n");

    const { content } = await callChatModel(
      [{ role: "system", content: systemPrompt }],
      state.provider,
    );
    return {
      ...state,
      toolResults: [{ step: "business_analysis", ok: true, output: "model_response" }],
      reply: content || "已完成业务分析。",
    };
  }

  if (tool?.tool === "knowledge.search") {
    const docs = await searchKnowledgeDocs(state.text, 5).catch(() => []);
    if (!docs.length) {
      return {
        ...state,
        toolResults: [{ step: "knowledge_search", ok: true, output: [] }],
        reply: "暂未检索到相关知识库内容。我可以继续按当前业务上下文给你建议，或者你补充更具体的关键词。",
      };
    }

    const knowledgePrompt = [
      "你是 ERP 知识库问答助手，只能基于给定知识回答，不要编造。",
      "如果知识不足，明确说知识库里没有找到足够信息，并给出下一步建议。",
      `用户问题：${state.text}`,
      `知识库内容：${JSON.stringify(docs, null, 2)}`,
      "请输出适合用户阅读的简洁答案，必要时给出条目式总结。",
    ].join("\n");

    const { content } = await callChatModel(
      [{ role: "system", content: knowledgePrompt }],
      state.provider,
    );
    return {
      ...state,
      toolResults: [{ step: "knowledge_search", ok: true, output: docs }],
      reply: content || docs.map((doc) => `${doc.title}: ${String(doc.content).slice(0, 120)}`).join("\n"),
    };
  }

  if (tool?.tool === "master_data.count") {
    const result = await countMasterDataTool(state);
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
