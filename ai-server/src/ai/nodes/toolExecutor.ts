import type { AiGraphState } from "../state.js";
import { callChatModelStream } from "../../config/llm.js";
import { businessAnalysisTool, countMasterDataTool, createOrUpdateBaqTool, createOrUpdateEntityTool, financeSummaryTool } from "../../tools/erpTools.js";
import {
  createDocumentTool,
  documentActionTool,
  queryDocumentTool,
  type DocumentActionName,
  type DocumentToolResult,
} from "../../tools/documentTools.js";
import { searchKnowledgeRag } from "../../services/knowledgeBase.js";
import {
  cancelPendingAction,
  executePendingAction,
  PendingActionError,
} from "../../services/pendingActions.js";
import { TenantScopeError } from "../../config/tenantContext.js";
import { emitDelta } from "../streamContext.js";
import type { PlanStep } from "./planner.js";

/** 知识召回是分片级的，同一篇文档常命中多个分片；来源列表按文档去重（保留相似度最高的一条） */
const dedupeSourcesByDoc = <
  T extends { docId?: number; title?: string; similarity?: number },
>(
  sources: T[],
): T[] => {
  const best = new Map<string, T>();
  for (const source of sources) {
    const key = source.docId != null ? `doc:${source.docId}` : `title:${source.title || ""}`;
    const prev = best.get(key);
    if (!prev || (source.similarity ?? 0) > (prev.similarity ?? 0)) {
      best.set(key, source);
    }
  }
  return [...best.values()].sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
};

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

interface StepOutcome {
  /** 合并回 state 的字段 */
  state: Partial<AiGraphState>;
  /** 本步产出（供 $prev 引用与多步汇总） */
  output?: Record<string, unknown>;
}

/** 工具结果 → 统一的 state 片段（主数据类工具返回结构一致） */
const fromToolResult = (
  step: string,
  result: { status: string; reply: string; data?: unknown; focus?: unknown; route?: string; routeLabel?: string; needConfirmation?: boolean; nextQuestions?: string[] },
): StepOutcome => ({
  state: {
    toolResults: [{ step, ok: result.status !== "error", status: result.status, reply: result.reply, data: result.data }],
    reply: result.reply,
    focus: result.focus,
    route: result.route,
    routeLabel: result.routeLabel,
    needConfirmation: result.needConfirmation,
    nextQuestions: result.nextQuestions,
  },
  output: (result.data as Record<string, unknown>) || undefined,
});

export async function toolExecutorNode(state: AiGraphState): Promise<AiGraphState> {
  const plan = Array.isArray(state.plan) ? (state.plan as PlanStep[]) : [];
  const cursor = typeof state.planCursor === "number" ? state.planCursor : 0;
  const step = plan[cursor];
  if (!step) return state;

  // 步骤输入：支持 "$prev.<field>" 引用上一步产出（多步计划里第二步常引用第一步建出的单据 id）
  const previousOutput = lastOutput(state);
  const input = resolvePlaceholders(step.input, previousOutput);

  const outcome = await dispatchTool(step, {
    ...state,
    stepInput: input,
    planRemaining: plan.slice(cursor + 1),
  });

  const merged: AiGraphState = { ...state, ...outcome.state };
  return {
    ...merged,
    planCursor: cursor + 1,
    planOutputs: [...(state.planOutputs || []), outcome.output || {}],
    // 累积各步结果（responseComposer 取最后一条作为主回复，并汇总过程）
    toolResults: [...(state.toolResults || []), ...((outcome.state.toolResults as unknown[]) || [])],
  };
}

const lastOutput = (state: AiGraphState): Record<string, unknown> | undefined => {
  const outputs = state.planOutputs || [];
  return outputs.length ? outputs[outputs.length - 1] : undefined;
};

/**
 * 多步计划：是否还要继续跑下一步。
 * 三种情况都要停：① 本步产出了待确认草稿（等用户确认）；② 本步失败；③ 计划已跑完。
 */
export const shouldContinuePlan = (state: AiGraphState): boolean => {
  if (state.needConfirmation) return false;
  const plan = Array.isArray(state.plan) ? (state.plan as PlanStep[]) : [];
  const cursor = typeof state.planCursor === "number" ? state.planCursor : 0;
  if (!plan[cursor]) return false;
  const results = (state.toolResults || []) as Array<Record<string, unknown>>;
  const last = results[results.length - 1];
  if (last && last.ok === false) return false;
  return true;
};

/** 把 input 里的 "$prev.x" 替换成上一步产出的字段值 */
export const resolvePlaceholders = (
  input: Record<string, unknown> | undefined,
  previous?: Record<string, unknown>,
): Record<string, unknown> => {
  if (!input) return {};
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.startsWith("$prev.")) {
      const field = value.slice("$prev.".length);
      const replacement = previous?.[field];
      if (replacement !== undefined && replacement !== null) resolved[key] = replacement;
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
};

async function dispatchTool(step: PlanStep, state: AiGraphState): Promise<StepOutcome> {
  const tool = step.tool;
  const input = state.stepInput || {};

  if (tool === "entity.execute_pending") {
    const pendingActionId = state.pendingAction?.id;
    if (!pendingActionId) {
      return {
        state: { toolResults: [{ step: "execute_pending", ok: false }], reply: "没有找到待确认的草稿。" },
      };
    }
    try {
      const result = await executePendingAction(pendingActionId, requireConfirmIdentity(state));
      return {
        state: {
          toolResults: [{ step: "execute_pending", ok: true, reply: result.reply, data: result.focus }],
          reply: result.reply,
          focus: result.focus,
          route: result.route,
          routeLabel: result.routeLabel,
          needConfirmation: false,
        },
        // 单据类草稿执行后返回 RPC 原始结果（含 document_id / target_document_id），供后续步骤引用
        output: result.output,
      };
    } catch (error) {
      return {
        state: {
          toolResults: [{ step: "execute_pending", ok: false, error: pendingErrorReply(error) }],
          reply: pendingErrorReply(error),
        },
      };
    }
  }

  if (tool === "entity.cancel_pending") {
    const pendingActionId = state.pendingAction?.id;
    if (!pendingActionId) {
      return {
        state: { toolResults: [{ step: "cancel_pending", ok: false }], reply: "没有找到待确认的草稿。" },
      };
    }
    try {
      await cancelPendingAction(pendingActionId, requireConfirmIdentity(state));
      return {
        state: { toolResults: [{ step: "cancel_pending", ok: true }], reply: "已取消，草稿未写入数据库。" },
      };
    } catch (error) {
      return {
        state: {
          toolResults: [{ step: "cancel_pending", ok: false, error: pendingErrorReply(error) }],
          reply: pendingErrorReply(error),
        },
      };
    }
  }

  // ---- 单据类工具（第三批）----
  if (tool === "document.create") {
    const result: DocumentToolResult = await createDocumentTool(state);
    return fromToolResult("create_document", result);
  }

  if (tool === "document.action") {
    const result: DocumentToolResult = await documentActionTool(state, {
      action: input.action as DocumentActionName | undefined,
      documentType: typeof input.documentType === "string" ? input.documentType : undefined,
      documentId: Number.isFinite(Number(input.documentId)) ? Number(input.documentId) : undefined,
    });
    return fromToolResult(`document_${String(input.action || "action")}`, result);
  }

  if (tool === "document.query") {
    const result: DocumentToolResult = await queryDocumentTool(state);
    return fromToolResult("query_document", result);
  }

  if (tool === "baq.upsert") {
    return fromToolResult("create_or_update_baq", await createOrUpdateBaqTool(state));
  }

  if (tool === "entity.upsert") {
    return fromToolResult("create_or_update_entity", await createOrUpdateEntityTool(state, state.action === "update" ? "update" : "create"));
  }

  if (tool === "entity.create") {
    return fromToolResult("create_entity", await createOrUpdateEntityTool(state, "create"));
  }

  if (tool === "entity.update") {
    return fromToolResult("update_entity", await createOrUpdateEntityTool(state, "update"));
  }

  if (tool === "finance.summary") {
    return fromToolResult("finance_summary", await financeSummaryTool(state));
  }

  if (tool === "business.analysis") {
    return fromToolResult("business_analysis", await businessAnalysisTool(state));
  }

  if (tool === "master_data.count") {
    return fromToolResult("master_data_count", await countMasterDataTool(state));
  }

  if (tool === "knowledge.search") {
    const docs = await searchKnowledgeRag(state.text, state.provider, 5, state.tenantId).catch(
      () => [],
    );
    if (!docs.length) {
      return {
        state: {
          toolResults: [{ step: "knowledge_search", ok: true, output: [] }],
          reply: "暂未检索到相关知识库内容。我可以继续按当前业务上下文给你建议，或者你补充更具体的关键词。",
          sources: [],
        },
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
      state: {
        toolResults: [{ step: "knowledge_search", ok: true, output: docs }],
        reply:
          content ||
          docs
            .map((doc) => `${doc.title}: ${String(doc.content).slice(0, 120)}`)
            .join("\n"),
        sources: dedupeSourcesByDoc(
          docs.map((doc) => ({
            title: doc.title,
            category: doc.category,
            sourceType: doc.sourceType,
            sourceRef: doc.sourceRef,
            docId: doc.docId,
            chunkId: doc.chunkId,
            similarity: doc.similarity,
          })),
        ),
      },
    };
  }

  // 兜底：闲聊 / 咨询
  const systemPrompt = [
    "你是 OPERP ERP 助手。",
    "你正在通过 OPERP AI 服务工作。不要声称自己没有 ERP 写入权限；当计划中存在业务工具时，工具执行由服务端负责。",
    "优先根据用户意图、当前页面和历史上下文回答。",
    `意图：${state.intent || "chat"}`,
    `域：${state.domain || "general"}`,
    state.currentFocus ? `当前焦点：${JSON.stringify(state.currentFocus)}` : "当前焦点：无",
    state.plan ? `计划：${JSON.stringify(state.plan)}` : "计划：无",
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
    state: {
      toolResults: [{ step: "draft_reply", ok: true, output: content ? "model_response" : "empty_response" }],
      reply: content || "模型未返回内容。",
    },
  };
}
