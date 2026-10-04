import type { AiGraphState } from "../state.js";
import { callChatModelStream } from "../../config/llm.js";
import { businessAnalysisTool, countMasterDataTool, createOrUpdateBaqTool, createOrUpdateEntityTool, financeSummaryTool } from "../../tools/erpTools.js";
import { searchKnowledgeRag } from "../../services/knowledgeBase.js";
import {
  cancelPendingAction,
  executePendingAction,
  PendingActionError,
} from "../../services/pendingActions.js";
import { TenantScopeError } from "../../config/tenantContext.js";
import { emitDelta } from "../streamContext.js";

const requireConfirmIdentity = (state: AiGraphState) => {
  if (typeof state.userId !== "number" || typeof state.tenantId !== "number") {
    throw new TenantScopeError("缺少用户或租户上下文，已拒绝执行确认操作。");
  }
  return { userId: state.userId, tenantId: state.tenantId };
};

const pendingErrorReply = (error: unknown) => {
  if (error instanceof PendingActionError) return error.message;
  if (error instanceof TenantScopeError) return error.message;
  return "确认操作执行失败，请稍后重试。";
};

export async function toolExecutorNode(state: AiGraphState): Promise<AiGraphState> {
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const tool = plan[0] as { tool?: string } | undefined;

  if (tool?.tool === "entity.execute_pending") {
    const pendingActionId = state.pendingAction?.id;
    if (!pendingActionId) {
      return { ...state, toolResults: [{ step: "execute_pending", ok: false }], reply: "没有找到待确认的草稿。" };
    }
    try {
      const result = await executePendingAction(pendingActionId, requireConfirmIdentity(state));
      return {
        ...state,
        toolResults: [{ step: "execute_pending", ok: true, output: result.focus }],
        reply: result.reply,
        focus: result.focus,
        route: result.route,
        routeLabel: result.routeLabel,
        needConfirmation: false,
      };
    } catch (error) {
      return {
        ...state,
        toolResults: [{ step: "execute_pending", ok: false, error: pendingErrorReply(error) }],
        reply: pendingErrorReply(error),
      };
    }
  }

  if (tool?.tool === "entity.cancel_pending") {
    const pendingActionId = state.pendingAction?.id;
    if (!pendingActionId) {
      return { ...state, toolResults: [{ step: "cancel_pending", ok: false }], reply: "没有找到待确认的草稿。" };
    }
    try {
      await cancelPendingAction(pendingActionId, requireConfirmIdentity(state));
      return {
        ...state,
        toolResults: [{ step: "cancel_pending", ok: true }],
        reply: "已取消，草稿未写入数据库。",
      };
    } catch (error) {
      return {
        ...state,
        toolResults: [{ step: "cancel_pending", ok: false, error: pendingErrorReply(error) }],
        reply: pendingErrorReply(error),
      };
    }
  }

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
    const result = await createOrUpdateEntityTool(state, state.action === "update" ? "update" : "create");
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
    const result = await createOrUpdateEntityTool(state, "create");
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
    const result = await createOrUpdateEntityTool(state, "update");
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

  if (tool?.tool === "business.analysis") {
    const result = await businessAnalysisTool(state);
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
    const docs = await searchKnowledgeRag(state.text, state.provider, 5, state.tenantId).catch(
      () => [],
    );
    if (!docs.length) {
      return {
        ...state,
        toolResults: [{ step: "knowledge_search", ok: true, output: [] }],
        reply: "暂未检索到相关知识库内容。我可以继续按当前业务上下文给你建议，或者你补充更具体的关键词。",
        sources: [],
      };
    }

    const knowledgePrompt = [
      "你是 ERP 知识库问答助手，只能基于给定知识回答，不要编造。",
      "如果知识不足，明确说知识库里没有找到足够信息，并给出下一步建议。",
      `用户问题：${state.text}`,
      `知识库内容：${JSON.stringify(docs, null, 2)}`,
      "请输出适合用户阅读的简洁答案，必要时给出条目式总结。",
    ].join("\n");

    // 真流式：知识库答案边生成边下发（emitDelta 在非流式请求下是 no-op）
    const content = await callChatModelStream(
      [{ role: "system", content: knowledgePrompt }],
      state.provider,
      emitDelta,
    );
    return {
      ...state,
      toolResults: [{ step: "knowledge_search", ok: true, output: docs }],
      reply:
        content ||
        docs
          .map((doc) => `${doc.title}: ${String(doc.content).slice(0, 120)}`)
          .join("\n"),
      sources: docs.map((doc) => ({
        title: doc.title,
        category: doc.category,
        sourceType: doc.sourceType,
        sourceRef: doc.sourceRef,
        docId: doc.docId,
        chunkId: doc.chunkId,
        similarity: doc.similarity,
      })),
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

  // 真流式：兜底闲聊 / 咨询回复边生成边下发
  const content = await callChatModelStream(
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
    emitDelta,
  );

  return {
    ...state,
    toolResults: [{ step: "draft_reply", ok: true, output: content ? "model_response" : "empty_response" }],
    reply: content || "模型未返回内容。",
  };
}
