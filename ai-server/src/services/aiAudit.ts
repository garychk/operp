/**
 * AI 操作审计。
 *
 * 之前 AI 的写入（建实体/改实体/存 BAQ/跑分析 SQL）不留任何痕迹，
 * 出了问题只能翻 console.log。现在所有「AI 发起的动作」都写一条
 * sys_ai_operation_logs：谁、哪个租户、哪个会话、对哪张表、请求与结果。
 *
 * 设计取舍：审计写失败只告警不阻断业务（console.warn）——
 * 审计是旁路，不能因为它挂掉把整条对话拖死；但告警必须可见。
 */
import { supabase } from "../config/supabase.js";

export interface AiOperationLogInput {
  /** 例：ai.entity.draft / ai.entity.execute_create / ai.baq.upsert / ai.analysis.sql */
  operation: string;
  tenantId?: number | null;
  userId?: number | null;
  sessionId?: string | null;
  targetTable?: string | null;
  targetId?: number | null;
  request?: unknown;
  result?: unknown;
  status?: "success" | "error";
}

const toJsonb = (value: unknown) =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

export async function logAiOperation(input: AiOperationLogInput): Promise<void> {
  try {
    const { error } = await supabase.from("sys_ai_operation_logs").insert({
      operation: input.operation,
      tenant_id: input.tenantId ?? null,
      user_id: input.userId ?? null,
      session_id: input.sessionId ?? null,
      target_table: input.targetTable ?? null,
      target_id: input.targetId ?? null,
      request: toJsonb(input.request),
      result: toJsonb(input.result),
      status: input.status ?? "success",
    });
    if (error) throw error;
  } catch (err) {
    console.warn("[ai-server] AI 操作审计写入失败:", err);
  }
}
