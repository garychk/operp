import type { AiGraphState } from "../state.js";

export async function toolExecutorNode(state: AiGraphState): Promise<AiGraphState> {
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const toolResults = plan.map((item) => ({
    step: (item as { step: string }).step,
    ok: true,
    output: `placeholder for ${(item as { tool: string }).tool}`,
  }));

  return {
    ...state,
    toolResults,
    reply: state.intent === "baq"
      ? "BAQ 处理已进入服务端流程骨架。"
      : state.intent === "knowledge"
        ? "知识库检索流程已接入骨架。"
        : "聊天流程已接入服务端骨架。",
  };
}
