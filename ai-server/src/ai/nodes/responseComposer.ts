import type { AiGraphState } from "../state.js";

export async function responseComposerNode(state: AiGraphState): Promise<AiGraphState> {
  return {
    ...state,
    reply: state.reply || "已完成。",
  };
}
