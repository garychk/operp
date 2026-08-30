import type { AiGraphState } from "../state.js";
import { loadSessionMemory } from "../../services/aiMemory.js";

export async function contextLoaderNode(state: AiGraphState): Promise<AiGraphState> {
  const memory = await loadSessionMemory(state.sessionId).catch(() => null);
  const recentMessages =
    (state.recentMessages?.length ? state.recentMessages : memory?.recent_messages) ?? [];
  return {
    ...state,
    memory,
    recentMessages,
    currentFocus: state.currentFocus ?? memory?.last_focus ?? null,
  };
}
