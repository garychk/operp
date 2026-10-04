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
import { executeDocumentAction } from "./documentActions.js";
// 仅用其纯函数（无环：entityRegistry 只依赖 config 层），展示时剥租户后缀
import { baseTableName as displayTableName } from "../tools/entityRegistry.js";

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
  action:
    | "create"
    | "update"
    | "post"
    | "reverse"
    | "submit"
    | "approve"
    | "reject"
    | "withdraw"
    | "convert";
  /** entity = 主数据单表写；document = 单据（走库内 RPC） */
  kind?: "entity" | "document";
  /** 单据类型（document 分支用） */
  documentType?: string;
  label?: string;
  tableTag?: string;
  display?: string;
  fieldLines?: string[];
  route?: string;
  routeLabel?: string;
  tenantScoped?: boolean;
  /**
   * 多步计划：本步确认执行后还要继续跑的剩余步骤。
   * 例「建销售订单然后过账」→ 第一步是建单草稿，remainingPlan=[{tool:'document.post',...}]
   */
  remainingPlan?: unknown[];
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
  /** 草稿上挂着的多步剩余计划（确认后要接着跑的步骤） */
  remainingPlan?: unknown[];
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
    .select("id, action_type, entity_key, status, expires_at, context")
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
    context?: PendingActionContext;
  } | null;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await supabase
      .from("sys_ai_pending_actions")
      .update({ status: "expired", updated_at: nowIso() })
      .eq("id", row.id);
    return null;
  }
  return {
    id: Number(row.id),
    actionType: row.action_type,
    entityKey: row.entity_key,
    remainingPlan: Array.isArray(row.context?.remainingPlan) ? row.context.remainingPlan : undefined,
  };
}

export async function executePendingAction(
  pendingActionId: number,
  identity: { userId: number; tenantId: number },
): Promise<{
  reply: string;
  focus: Record<string, unknown>;
  route?: string;
  routeLabel?: string;
  /** 供多步计划后续步骤取用的产出（如新建单据的 id / 单号） */
  output?: Record<string, unknown>;
  /** 本步之后还要继续跑的多步计划（/api/ai/confirm 会用它在同一请求里续跑） */
  remainingPlan?: unknown[];
}> {
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

  // 单据分支：走库内 RPC（deploy_83），不是单表 insert —— 审计在 documentActions 里记录
  if (action.action_type.startsWith("document.")) {
    const outcome = await executeDocumentAction(
      {
        id: action.id,
        session_id: action.session_id,
        action_type: action.action_type,
        entity_key: action.entity_key,
        table_name: action.table_name,
        payload: action.payload,
        context: ctx as unknown as Record<string, unknown>,
      },
      identity,
    );
    const focusId = Number((outcome.focus || {}).id);
    await supabase
      .from("sys_ai_pending_actions")
      .update({
        status: "executed",
        executed_at: nowIso(),
        executed_row_id: Number.isFinite(focusId) ? focusId : null,
        updated_at: nowIso(),
      })
      .eq("id", action.id);
    return {
      reply: outcome.reply,
      focus: outcome.focus,
      route: outcome.route,
      routeLabel: outcome.routeLabel,
      output: outcome.output,
      remainingPlan: Array.isArray(ctx.remainingPlan) ? ctx.remainingPlan : undefined,
    };
  }

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
    reply: `${isUpdate ? "已更新" : "已创建"}${ctx.label || ""}：${display}（写入表 ${ctx.tableTag || displayTableName(action.table_name)}）`,
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
