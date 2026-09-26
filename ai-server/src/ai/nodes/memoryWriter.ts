import type { AiGraphState } from "../state.js";
import { saveSessionMemory } from "../../services/aiMemory.js";

export async function memoryWriterNode(state: AiGraphState): Promise<AiGraphState> {
  const recentMessages = Array.isArray(state.recentMessages)
    ? state.recentMessages.slice(-20)
    : [];
  await saveSessionMemory({
    session_id: state.sessionId,
    user_id: state.userId,
    tenant_id: state.tenantId,
    recent_messages: recentMessages,
    last_intent: state.intent,
    last_target: state.target,
    last_query_mode: state.queryMode,
    last_response_mode: state.responseMode,
    last_route: state.route,
    last_route_label: state.routeLabel,
    last_focus: state.focus ?? state.currentFocus ?? null,
    updated_at: new Date().toISOString(),
  });
  return state;
}
