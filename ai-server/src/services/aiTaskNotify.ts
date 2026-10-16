/**
 * AI 任务完成通知。
 *
 * 触发规则（与用户约定）：
 *   1. 只在实际「办成了事」时通知 —— AI 建单 / 改单 / 转单 / 过账 / 确认落库 /
 *      建 BAQ / 页面设计等真正写了数据的任务；
 *   2. 纯聊天、查数据、问菜单、知识库问答等只读回合**不**通知；
 *   3. 「待确认草稿」（needConfirmation）阶段**不算完成**，不通知 —— 用户点确认、
 *      草稿真正落库那一回合才通知。
 *
 * 实现复用 deploy_31 的 notify_push()（task_completed 类型），前端铃铛 / 工作台
 * 跑马灯自动展示，无需额外改动。软失败：通知发不出去不影响任务本身结果。
 */
import { supabase } from "../config/supabase.js";

/**
 * 写操作的 step 白名单（toolResults 里累积的 step 名）。
 * 只有命中这些 step 的回合才可能触发通知。
 */
const WRITE_STEP_PREFIXES = [
  "create_entity",
  "update_entity",
  "create_or_update_entity",
  "create_document",
  "create_or_update_baq",
  "design_custom_page",
  "execute_pending",
];

/** document.action 产生的 step 名形如 document_<action>，只读动作需排除 */
const READ_ONLY_DOCUMENT_ACTIONS = new Set(["query", "get", "detail", "list", "count"]);

function isWriteStep(step: unknown): boolean {
  const name = String(step ?? "");
  if (WRITE_STEP_PREFIXES.some((prefix) => name === prefix)) return true;
  if (name.startsWith("document_")) {
    const action = name.slice("document_".length);
    if (READ_ONLY_DOCUMENT_ACTIONS.has(action)) return false;
    // document_create / document_post / document_convert / document_submit … 都是写操作
    return true;
  }
  return false;
}

/** 判定某回合是否「实际办成了事」：有至少一个成功（ok !== false）的写步骤 */
export function shouldNotifyOnComplete(state: {
  needConfirmation?: boolean;
  toolResults?: unknown[];
}): boolean {
  // 待确认草稿阶段不算完成
  if (state.needConfirmation) return false;
  const results = Array.isArray(state.toolResults) ? state.toolResults : [];
  return results.some((item) => {
    const record = item as Record<string, unknown>;
    if (record.ok === false) return false;
    return isWriteStep(record.step);
  });
}

/**
 * 发送「AI 任务已完成」通知给当前用户。
 * 返回是否发送成功（软失败不抛错，调用方照常走完流程）。
 */
export async function notifyAiTaskComplete(input: {
  userId?: number;
  summary?: string;
}): Promise<boolean> {
  const userId = input.userId;
  if (typeof userId !== "number" || !Number.isFinite(userId)) return false;

  const summary = (input.summary ?? "").trim();
  const title = "AI 任务已完成";
  const content = summary
    ? `AI 已为你完成任务：${summary.slice(0, 180)}`
    : "AI 已完成本次任务，可到对应页面查看结果。";

  try {
    const { error } = await supabase.rpc("notify_push", {
      p_notification_type: "task_completed",
      p_severity: "info",
      p_title: title,
      p_content: content,
      p_source_type: "ai_task",
      p_source_id: null,
      p_source_no: null,
      p_link_path: null,
      p_dedup_key: null,
      p_recipient_user_ids: [userId],
      p_recipient_role_code: null,
      p_dedup_window_hours: 24,
    });
    return !error;
  } catch (error) {
    console.error("[ai-server] 任务完成通知发送失败（软失败）:", error);
    return false;
  }
}
