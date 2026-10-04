import type { AiGraphState } from "../state.js";
import { stripTenantSuffixInText } from "../../tools/entityRegistry.js";

export async function responseComposerNode(state: AiGraphState): Promise<AiGraphState> {
  const toolResult = Array.isArray(state.toolResults)
    ? (state.toolResults[0] as Record<string, unknown> | undefined)
    : undefined;
  const toolReply = toolResult && typeof toolResult.reply === "string" ? toolResult.reply.trim() : "";
  const toolStatus = toolResult && typeof toolResult.status === "string" ? toolResult.status : "";
  const toolData = toolResult?.data;

  const composedReply = stripTenantSuffixInText(
    state.reply?.trim() ||
      toolReply ||
      (toolStatus === "needs_more"
        ? "还需要补充一些信息后才能继续处理。"
        : toolStatus === "error"
          ? "任务执行失败，请查看上方步骤中的错误信息。"
          : toolData
            ? `任务已完成。\n\n${JSON.stringify(toolData, null, 2)}`
            : "任务已完成。"),
  );

  return {
    ...state,
    reply: composedReply,
  };
}
