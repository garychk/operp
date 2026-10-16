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
import { DOCUMENT_TYPES, actionLabel, documentLabel, statusLabel } from "./documentService.js";
import { toolText } from "./toolText.js";

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
  // 草稿上冻结的界面语言（创建草稿时写入），确认阶段沿用它渲染文案
  const locale = typeof action.context?.locale === "string" ? action.context.locale : undefined;
  const tt = toolText(locale);
  const documentType = String(payload.documentType || action.entity_key || "");
  const meta = DOCUMENT_TYPES[documentType];
  if (!meta) {
    throw new DocumentActionError(tt("doc.err.unsupportedType", { type: documentType }));
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
    if (!ruleCode) throw new DocumentActionError(tt("doc.err.missingRule"));
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
      // 审批意见会落进单据数据里 → 也按界面语言写
      p_comment: String(payload.comment || `AI ${actionLabel(actionName, locale)}`),
    });
    operation = `ai.document.${actionName}`;
  } else {
    throw new DocumentActionError(tt("doc.err.unsupportedAction", { action: actionName }));
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
    reply: renderOutcome(actionName, meta.label, result, action.context, locale),
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
  locale?: string,
): string => {
  const tt = toolText(locale);
  // 单据类型名按界面语言渲染（草稿 context 里存的是中文名，这里按 meta 反查更稳）
  const meta = Object.values(DOCUMENT_TYPES).find((item) => item.label === label);
  const displayLabel = meta ? documentLabel(meta, locale) : label;

  if (actionName === "create") {
    const lineCount = Number(result.line_count ?? context.lineCount ?? 0);
    const amount = result.total_amount;
    // 只建单头（用户没给明细）时用单独的文案，避免出现「0 行」这种别扭说法
    if (!Number.isFinite(lineCount) || lineCount <= 0) {
      return [
        tt("doc.exec.createdHeadOnly", {
          label: displayLabel,
          no: String(result.document_no ?? "-"),
        }),
        tt("doc.exec.createHint"),
      ].join("\n");
    }
    return [
      tt("doc.exec.created", {
        label: displayLabel,
        no: String(result.document_no ?? "-"),
        lines: String(lineCount),
        amount: amount ? tt("doc.exec.createdAmount", { amount: String(amount) }) : "",
      }),
      tt("doc.exec.createHint"),
    ].join("\n");
  }
  if (actionName === "convert") {
    return [
      tt("doc.exec.converted", {
        source: String(context.display || label),
        target: String(result.target_document_no || result.target_document_id || "-"),
      }),
      tt("doc.exec.convertHint", {
        status: result.target_initial_status
          ? tt("doc.exec.statusSuffix", { status: statusLabel(String(result.target_initial_status), locale) })
          : "",
      }),
    ].join("\n");
  }
  const status = result.status
    ? tt("doc.exec.statusSuffix", { status: statusLabel(String(result.status), locale) })
    : "";
  const idempotent = result.idempotent ? tt("doc.exec.idempotent") : "";
  return tt("doc.exec.done", {
    action: actionLabel(actionName, locale),
    display: String(context.display || `${displayLabel} #${result.document_id ?? ""}`),
    status,
    idempotent,
  });
};
