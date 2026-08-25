import type { AiGraphState } from "../state.js";

export async function plannerNode(state: AiGraphState): Promise<AiGraphState> {
  const plan =
    state.intent === "baq"
      ? [{ step: "create_or_update_baq", tool: "baq.createOrUpdate", input: { text: state.text } }]
      : state.intent === "knowledge"
        ? [{ step: "search_kb", tool: "knowledge.search", input: { query: state.text } }]
        : [{ step: "draft_reply", tool: "chat.respond", input: { text: state.text } }];

  return { ...state, plan };
}
