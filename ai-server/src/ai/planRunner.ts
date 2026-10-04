/**
 * 多步计划续跑器。
 *
 * 场景：用户确认了一份「挂有多步剩余计划」的草稿（例如「建销售订单然后过账」的第一步），
 * 确认执行完第一步后，剩下的步骤（过账）要在**同一个请求**里接着跑，
 * 否则用户点了确认却要再等一轮。
 *
 * 这里的续跑与 graph 内的循环共用同一个执行器（toolExecutorNode + shouldContinuePlan），
 * 所以「遇到写操作产草稿就停」「某步失败就停」的行为完全一致 —— 不另起一套逻辑。
 */
import type { AiGraphState } from "./state.js";
import { shouldContinuePlan, toolExecutorNode } from "./nodes/toolExecutor.js";

const MAX_STEPS = 5;

export async function runRemainingPlan(
  steps: unknown[],
  baseState: AiGraphState,
): Promise<AiGraphState> {
  let state: AiGraphState = {
    ...baseState,
    plan: steps,
    planCursor: 0,
    planOutputs: [...(baseState.planOutputs || [])],
    toolResults: [],
  };

  let guard = 0;
  while (guard < MAX_STEPS) {
    guard += 1;
    if (!shouldContinuePlan(state)) break;
    state = await toolExecutorNode(state);
  }
  return state;
}

/** 从执行结果里取「下一个待确认草稿 id」（续跑又产草稿时前端可继续调 /confirm） */
export const nextPendingActionId = (state: AiGraphState): number | undefined => {
  const data = state.planOutputs?.[state.planOutputs.length - 1];
  const id = Number((data as Record<string, unknown> | undefined)?.pendingActionId);
  return Number.isFinite(id) ? id : undefined;
};
