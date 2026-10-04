import type { AiGraphState } from "../state.js";

export async function plannerNode(state: AiGraphState): Promise<AiGraphState> {
  const plan =
    state.intent === "confirm_execute"
      ? [{ step: "execute_pending_action", tool: "entity.execute_pending", input: { pendingActionId: state.pendingAction?.id } }]
      : state.intent === "cancel_action"
        ? [{ step: "cancel_pending_action", tool: "entity.cancel_pending", input: { pendingActionId: state.pendingAction?.id } }]
      : state.intent === "baq"
      ? [{ step: "create_or_update_baq", tool: "baq.upsert", input: { text: state.text, currentFocus: state.currentFocus } }]
      : state.intent === "create"
        ? [{ step: "create_entity", tool: "entity.create", input: { text: state.text } }]
        : state.intent === "update"
          ? [{ step: "update_entity", tool: "entity.update", input: { text: state.text, currentFocus: state.currentFocus } }]
      : state.intent === "analysis"
            ? state.domain === "master_data"
              ? [{ step: "master_data_count", tool: "master_data.count", input: { text: state.text, target: state.target, queryMode: state.queryMode } }]
              : [{ step: "business_analysis", tool: "business.analysis", input: { text: state.text, target: state.target, queryMode: state.queryMode, responseMode: state.responseMode } }]
            : state.intent === "knowledge"
              ? [{ step: "knowledge_lookup", tool: "knowledge.search", input: { text: state.text } }]
              : [{ step: "draft_reply", tool: "chat.respond", input: { text: state.text } }];

  // Keep the plan explicit so the executor and the streamed trace agree on
  // the operation that is actually going to be performed.
  return { ...state, plan };
}
