import type { AiGraphState } from "../state.js";

export async function plannerNode(state: AiGraphState): Promise<AiGraphState> {
  const plan =
    state.intent === "baq"
      ? [{ step: "create_or_update_baq", tool: "baq.upsert", input: { text: state.text, currentFocus: state.currentFocus } }]
      : state.intent === "master_data"
        ? [{ step: "create_or_update_entity", tool: "entity.upsert", input: { text: state.text, currentFocus: state.currentFocus } }]
        : state.intent === "finance"
          ? [{ step: "finance_summary", tool: "finance.summary", input: { text: state.text } }]
          : [{ step: "draft_reply", tool: "chat.respond", input: { text: state.text } }];

  // Keep the plan explicit so the executor and the streamed trace agree on
  // the operation that is actually going to be performed.
  return { ...state, plan };
}
