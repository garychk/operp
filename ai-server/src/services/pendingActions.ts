/**
 * AI 写库确认回路。
 *
 * 背景：此前 AI 创建/修改实体是「推断完字段直接 insert/update」，
 * LLM 幻觉或误判一个字段就直接落库。现在改为两段式：
 *   1. prepare 阶段（erpTools）：推断 + 校验 + 组装 payload，存成
 *      sys_ai_pending_actions 一条 pending 草稿，**不写业务表**；
 *   2. confirm 阶段：用户在对话里回复「确认」（或调 POST /api/ai/confirm），
 *      这里才真正写库，并记录审计。
 *
 * 草稿 30 分钟过期；执行时校验 user/tenant 归属，不能确认别人的草稿。
 * erpTools 不反向依赖本模块（避免循环依赖），tenantScoped 等
 * 由 prepare 阶段算好放进 context JSONB。
 */
import { supabase } from "../config/supabase.js";
import { logAiOperation } from "./aiAudit.js";

export const PENDING_ACTION_TTL_MINUTES = 30;

export class PendingActionError extends Error {
  constructor(
    readonly code: "not_found" | "expired" | "forbidden" | "already_handled",
    message: string,
  ) {
    super(message);
    this.name = "PendingActionError";
  }
}

/** prepare 阶段冻结的展示/执行上下文（存 JSONB，执行时不再解析实体目录） */
export interface PendingActionContext {
  action: "create" | "update";
  label?: string;
  tableTag?: string;
  display?: string;
  fieldLines?: string[];
  route?: string;
  routeLabel?: string;
  tenantScoped?: boolean;
}

export interface PendingActionInput {
  sessionId: string;
  userId: number;
  tenantId: number;
  /** entity.create | entity.update */
  actionType: string;
  entityKey: string;
  tableName: string;
  payload: Record<string, unknown>;
  existingId?: number | null;
  context: PendingActionContext;
}

export interface PendingActionRef {
  id: number;
  actionType: string;
  entityKey: string;
}

const nowIso = () => new Date().toISOString();

export async function createPendingAction(input: PendingActionInput): Promise<number> {
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MINUTES * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("sys_ai_pending_actions")
    .insert({
      session_id: input.sessionId,
      user_id: input.userId,
      tenant_id: input.tenantId,
      action_type: input.actionType,
      entity_key: input.entityKey,
      table_name: input.tableName,
      payload: input.payload,
      existing_id: input.existingId ?? null,
      context: input.context,
      status: "pending",
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error) throw error;
  return Number((data as { id: number }).id);
}

/** 取会话里最新一条未处理草稿（供对话式「确认/取消」命中），过期惰性置失效。 */
export async function loadLatestPendingAction(
  sessionId: string | undefined,
  userId: number | undefined,
): Promise<PendingActionRef | null> {
  if (!sessionId || typeof userId !== "number") return null;
  const { data, error } = await supabase
    .from("sys_ai_pending_actions")
    .select("id, action_type, entity_key, status, expires_at")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const row = data as {
    id: number;
    action_type: string;
    entity_key: string;
    expires_at: string;
  } | null;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await supabase
      .from("sys_ai_pending_actions")
      .update({ status: "expired", updated_at: nowIso() })
      .eq("id", row.id);
    return null;
  }
  return { id: Number(row.id), actionType: row.action_type, entityKey: row.entity_key };
}

export async function executePendingAction(
  pendingActionId: number,
  identity: { userId: number; tenantId: number },
): Promise<{ reply: string; focus: Record<string, unknown>; route?: string; routeLabel?: string }> {
  const { data: row, error } = await supabase
    .from("sys_ai_pending_actions")
    .select("*")
    .eq("id", pendingActionId)
    .maybeSingle();
  if (error) throw error;
  const action = row as
    | {
        id: number;
        session_id: string;
        user_id: number;
        tenant_id: number | null;
        action_type: string;
        entity_key: string;
        table_name: string;
        payload: Record<string, unknown>;
        existing_id: number | null;
        context: PendingActionContext;
        status: string;
        expires_at: string;
      }
    | null;

  if (!action || action.status !== "pending") {
    throw new PendingActionError(
      action?.status === "executed" ? "already_handled" : "not_found",
      action?.status === "executed"
        ? "该草稿已经执行过，不能重复执行。"
        : "没有找到待确认的草稿（可能已取消或失效）。",
    );
  }
  if (Number(action.user_id) !== Number(identity.userId)) {
    throw new PendingActionError("forbidden", "只能确认自己会话产生的草稿。");
  }
  if (action.tenant_id !== null && Number(action.tenant_id) !== Number(identity.tenantId)) {
    throw new PendingActionError("forbidden", "该草稿属于其他租户，已拒绝执行。");
  }
  if (new Date(action.expires_at).getTime() < Date.now()) {
    await supabase
      .from("sys_ai_pending_actions")
      .update({ status: "expired", updated_at: nowIso() })
      .eq("id", action.id);
    throw new PendingActionError("expired", "草稿已过期（超过 30 分钟），请重新描述要处理的操作。");
  }

  const ctx = action.context || {};
  const payload: Record<string, unknown> = {
    ...(action.payload as Record<string, unknown>),
    updated_at: nowIso(),
  };

  let written: Record<string, unknown> | null = null;
  let writeError: unknown = null;
  if (ctx.action === "update" || action.action_type === "entity.update") {
    if (!action.existing_id) {
      throw new PendingActionError("not_found", "草稿缺少目标记录，无法执行修改。");
    }
    let query = supabase.from(action.table_name).update(payload).eq("id", action.existing_id);
    if (ctx.tenantScoped) query = query.eq("tenant_id", identity.tenantId);
    const response = await query.select().single();
    written = response.data as Record<string, unknown> | null;
    writeError = response.error;
  } else {
    const response = await supabase.from(action.table_name).insert(payload).select().single();
    written = response.data as Record<string, unknown> | null;
    writeError = response.error;
  }
  if (writeError) throw writeError;

  const rowId = Number(written?.id);
  await supabase
    .from("sys_ai_pending_actions")
    .update({
      status: "executed",
      executed_at: nowIso(),
      executed_row_id: Number.isFinite(rowId) ? rowId : null,
      updated_at: nowIso(),
    })
    .eq("id", action.id);

  const isUpdate = ctx.action === "update" || action.action_type === "entity.update";
  await logAiOperation({
    operation: isUpdate ? "ai.entity.execute_update" : "ai.entity.execute_create",
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: action.session_id,
    targetTable: action.table_name,
    targetId: Number.isFinite(rowId) ? rowId : null,
    request: payload,
    result: { pending_action_id: action.id, row_id: rowId },
  });

  const display = ctx.display || String(written?.id ?? "-");
  return {
    reply: `${isUpdate ? "已更新" : "已创建"}${ctx.label || ""}：${display}（写入表 ${ctx.tableTag || action.table_name}）`,
    focus: {
      type: action.entity_key,
      id: rowId,
      route: ctx.route,
      routeLabel: ctx.routeLabel,
    },
    route: ctx.route,
    routeLabel: ctx.routeLabel,
  };
}

export async function cancelPendingAction(
  pendingActionId: number,
  identity: { userId: number; tenantId: number },
): Promise<void> {
  const { data, error } = await supabase
    .from("sys_ai_pending_actions")
    .select("id, user_id, tenant_id, status")
    .eq("id", pendingActionId)
    .maybeSingle();
  if (error) throw error;
  const row = data as { id: number; user_id: number; tenant_id: number | null; status: string } | null;
  if (!row || row.status !== "pending") {
    throw new PendingActionError("not_found", "没有找到待确认的草稿。");
  }
  if (Number(row.user_id) !== Number(identity.userId)) {
    throw new PendingActionError("forbidden", "只能取消自己会话产生的草稿。");
  }
  if (row.tenant_id !== null && Number(row.tenant_id) !== Number(identity.tenantId)) {
    throw new PendingActionError("forbidden", "该草稿属于其他租户，已拒绝操作。");
  }
  const { error: updateError } = await supabase
    .from("sys_ai_pending_actions")
    .update({ status: "cancelled", updated_at: nowIso() })
    .eq("id", row.id);
  if (updateError) throw updateError;
  await logAiOperation({
    operation: "ai.entity.cancel",
    tenantId: identity.tenantId,
    userId: identity.userId,
    targetId: row.id,
  });
}
