import type { AiGraphState } from "../state.js";

export async function contextLoaderNode(state: AiGraphState): Promise<AiGraphState> {
  return {
    ...state,
    recentMessages: state.recentMessages ?? [],
  };
}
