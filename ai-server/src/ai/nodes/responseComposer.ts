import type { AiGraphState } from "../state.js";
import { stripTenantSuffixInText } from "../../tools/entityRegistry.js";

/**
 * 组装最终回复。
 *
 * 多步计划（第三批）：toolResults 现在会累积多步，主回复取**最后一步**，
 * 并在前面附一段「执行过程」清单，让用户看清哪几步成功 / 失败。
 */
export async function responseComposerNode(state: AiGraphState): Promise<AiGraphState> {
  const results = Array.isArray(state.toolResults)
    ? (state.toolResults as Array<Record<string, unknown>>)
    : [];
  const last = results.length ? results[results.length - 1] : undefined;
  const toolReply = last && typeof last.reply === "string" ? String(last.reply).trim() : "";
  const toolStatus = last && typeof last.status === "string" ? String(last.status) : "";
  const toolData = last?.data;

  const body =
    state.reply?.trim() ||
    toolReply ||
    (toolStatus === "needs_more"
      ? "还需要补充一些信息后才能继续处理。"
      : toolStatus === "error"
        ? "任务执行失败，请查看上方步骤中的错误信息。"
        : toolData
          ? `任务已完成。\n\n${JSON.stringify(toolData, null, 2)}`
          : "任务已完成。");

  // 多步执行时给出过程摘要（单步保持原样，不引入噪音）
  const trail =
    results.length > 1
      ? results
          .map((item, index) => {
            const name = String(item.step ?? `step${index + 1}`);
            const ok = item.ok !== false;
            const error = !ok && item.error ? `：${String(item.error)}` : "";
            return `${index + 1}. ${name} ${ok ? "✓" : "✗"}${error}`;
          })
          .join("  \n")
      : "";

  const composed = trail ? `**执行过程**\n${trail}\n\n---\n\n${body}` : body;

  return {
    ...state,
    reply: stripTenantSuffixInText(composed),
  };
}
