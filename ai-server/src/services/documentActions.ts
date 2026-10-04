/**
 * 单据动作执行器（确认回路 confirm 阶段的「document」分支）。
 *
 * 与 entity 分支的区别：单据不是「单表 insert」，而是库内 RPC（deploy_83）：
 *   - 建单     → service_ai_create_document
 *   - 过账     → service_ai_post_document
 *   - 反过账   → service_ai_reverse_document
 *   - 审批动作 → service_ai_workflow_action
 *   - 转单     → service_ai_doc_flow_generate
 *
 * 所有 RPC 都会在同一事务里注入身份（set_config app.tenant_id + jwt claims），
 * 所以库内的 current_tenant_id() / RLS / 单据号取号都按真实租户工作。
 */
import { randomUUID } from "node:crypto";
import { supabase } from "../config/supabase.js";
import { extractErrorMessage } from "./errors.js";
import { logAiOperation } from "./aiAudit.js";
import { DOCUMENT_TYPES, actionLabel, statusLabel } from "./documentService.js";

export interface DocumentIdentity {
  userId: number;
  tenantId: number;
}

export interface DocumentExecutionContext {
  sessionId: string;
  documentType: string;
  documentId?: number | null;
  action: string;
  payload: Record<string, unknown>;
  /** 库里 RPC 返回的原始 jsonb */
  result: Record<string, unknown>;
}

export interface DocumentExecutionOutcome {
  reply: string;
  focus: Record<string, unknown>;
  route?: string;
  routeLabel?: string;
  /** 供多步计划后续步骤取用的数据（如新建单据的 id / 单号） */
  output: Record<string, unknown>;
}

export class DocumentActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentActionError";
  }
}

const callRpc = async (
  fn: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new DocumentActionError(extractErrorMessage(error));
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok === false) {
    throw new DocumentActionError(String(result.error || "单据操作失败"));
  }
  return result;
};

/** 执行一条单据草稿（由 pendingActions 分派进来） */
export async function executeDocumentAction(
  action: {
    id: number;
    session_id: string;
    action_type: string;
    entity_key: string;
    table_name: string;
    payload: Record<string, unknown>;
    context: Record<string, unknown>;
  },
  identity: DocumentIdentity,
): Promise<DocumentExecutionOutcome> {
  const payload = action.payload || {};
  const documentType = String(payload.documentType || action.entity_key || "");
  const meta = DOCUMENT_TYPES[documentType];
  if (!meta) {
    throw new DocumentActionError(`不支持的单据类型：${documentType}`);
  }

  const baseArgs = { p_user_id: identity.userId, p_tenant_id: identity.tenantId };
  const actionName = String(payload.action || action.context?.action || "create");

  let result: Record<string, unknown>;
  let operation: string;
  let targetId: number | null = Number(payload.documentId) || null;

  if (action.action_type === "document.create") {
    const header = (payload.header || {}) as Record<string, unknown>;
    const lines = (payload.lines || []) as Array<Record<string, unknown>>;
    result = await callRpc("service_ai_create_document", {
      ...baseArgs,
      p_document_type: documentType,
      p_header: header,
      p_lines: lines,
    });
    operation = "ai.document.create";
    targetId = Number(result.document_id) || null;
  } else if (actionName === "post" || actionName === "reverse") {
    result = await callRpc(
      actionName === "post" ? "service_ai_post_document" : "service_ai_reverse_document",
      {
        ...baseArgs,
        p_document_type: documentType,
        p_document_id: targetId,
        p_idempotency_key: randomUUID(),
        ...(actionName === "reverse" ? { p_reason: String(payload.comment || "AI 反过账") } : {}),
      },
    );
    operation = actionName === "post" ? "ai.document.post" : "ai.document.reverse";
  } else if (actionName === "convert") {
    const ruleCode = String(payload.ruleCode || "");
    if (!ruleCode) throw new DocumentActionError("缺少转单规则，无法执行。");
    result = await callRpc("service_ai_doc_flow_generate", {
      ...baseArgs,
      p_rule_code: ruleCode,
      p_source_document_id: targetId,
      p_line_mode: String(payload.lineMode || "remaining"),
      p_line_requests: payload.lineRequests ?? null,
    });
    operation = "ai.document.convert";
  } else if (["submit", "approve", "reject", "withdraw"].includes(actionName)) {
    result = await callRpc("service_ai_workflow_action", {
      ...baseArgs,
      p_document_type: documentType,
      p_document_id: targetId,
      p_action: actionName,
      p_comment: String(payload.comment || `AI ${actionLabel(actionName)}`),
    });
    operation = `ai.document.${actionName}`;
  } else {
    throw new DocumentActionError(`未支持的单据动作：${actionName}`);
  }

  await logAiOperation({
    operation,
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: action.session_id,
    targetTable: meta.headerTable,
    targetId,
    request: payload,
    result: {
      pending_action_id: action.id,
      ok: result.ok !== false,
      document_no: result.document_no ?? null,
      status: result.status ?? null,
    },
  });

  return {
    reply: renderOutcome(actionName, meta.label, result, action.context),
    focus: {
      type: meta.type,
      id: targetId ?? undefined,
      code: (result.document_no as string) || undefined,
      name: (result.document_no as string) || undefined,
      route: meta.route,
      routeLabel: meta.routeLabel,
    },
    route: meta.route,
    routeLabel: meta.routeLabel,
    output: result,
  };
}

const renderOutcome = (
  actionName: string,
  label: string,
  result: Record<string, unknown>,
  context: Record<string, unknown>,
): string => {
  if (actionName === "create") {
    const lineCount = result.line_count ?? context.lineCount ?? "-";
    const amount = result.total_amount;
    return [
      `已创建${label}：**${result.document_no}**（${lineCount} 行${amount ? `，金额 ${amount}` : ""}）`,
      "单据为草稿状态。需要的话可以继续说「提交审批」「审批通过」或「转成下游单据」。",
    ].join("\n");
  }
  if (actionName === "convert") {
    return [
      `已转单：${context.display || label} → **${result.target_document_no || result.target_document_id || "-"}**`,
      `新单据为草稿状态${result.target_initial_status ? `（${statusLabel(String(result.target_initial_status))}）` : ""}，可以继续「把它过账」。`,
    ].join("\n");
  }
  const status = result.status ? `（当前状态：${statusLabel(String(result.status))}）` : "";
  const idempotent = result.idempotent ? "（幂等命中：本次未重复执行）" : "";
  return `已${actionLabel(actionName)}：**${context.display || `${label} #${result.document_id ?? ""}`}**${status}${idempotent}`;
};
