import type { AiGraphState } from "../state.js";
import { loadSessionMemory } from "../../services/aiMemory.js";
import { resolveTenantContext } from "../../config/tenantContext.js";

/**
 * 上下文加载：会话记忆 + 租户上下文。
 *
 * 租户在这里一次性解析并写进 state，后续所有 tool 都从 state.tenantId 取。
 * 解析失败直接抛错（fail-closed）——拿不到租户就不允许碰业务数据，
 * 宁可让这次对话失败，也不能退化成「不加过滤查全库」。
 */
export async function contextLoaderNode(state: AiGraphState): Promise<AiGraphState> {
  const [memory, tenant] = await Promise.all([
    loadSessionMemory(state.sessionId).catch(() => null),
    resolveTenantContext(state.userId, state.tenantId),
  ]);

  const recentMessages =
    (state.recentMessages?.length ? state.recentMessages : memory?.recent_messages) ?? [];

  return {
    ...state,
    tenantId: tenant.tenantId,
    memory,
    recentMessages,
    currentFocus: state.currentFocus ?? memory?.last_focus ?? null,
  };
}
