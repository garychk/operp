import { AsyncLocalStorage } from "node:async_hooks";
import { supabase } from "../config/supabase.js";
import { logger } from "./logger.js";

/**
 * AI Token 消耗记录（旁路）。
 *
 * 之前 LLM 调用完全不统计 Token —— 谁、在哪个会话、消耗多少，一概不知。
 * 现在每次模型调用（对话 / 意图路由 / 字段提取 / BAQ 设计 / embedding / 分析）
 * 返回 usage 后，旁路写一条 sys_ai_token_usage。
 *
 * 设计取舍：
 *   · 旁路，不阻断 —— 记录写失败只 warn（token 统计不能把整条对话拖死）；
 *   · 身份用 AsyncLocalStorage 传递 —— 三个底层调用函数
 *     （callChatModel / callChatModelStream / callEmbeddingModel）签名不带
 *     user/tenant/session，且 embedding 在 reindex 时是批量循环，改签名侵入面太大。
 *     在 graph 入口（runChatGraph / runChatGraphStream）用 run() 包住整条节点链，
 *     底层函数内 getContext() 即可拿到身份，无需层层透传。
 */

export interface TokenUsageContext {
  userId?: number;
  tenantId?: number;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<TokenUsageContext>();

export const tokenUsageContext = {
  run: <T>(ctx: TokenUsageContext, fn: () => Promise<T>): Promise<T> =>
    storage.run(ctx, fn),
};

export const getTokenUsageContext = (): TokenUsageContext | undefined =>
  storage.getStore();

export interface TokenUsageInput {
  operation: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const toInt = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
};

/**
 * 旁路写一条 token 消耗。没有上下文（如脚本里直调模型）时跳过。
 * 写失败只告警，绝不影响主流程。
 */
export async function recordTokenUsage(input: TokenUsageInput): Promise<void> {
  const ctx = getTokenUsageContext();
  if (!ctx) return;

  const prompt = toInt(input.promptTokens);
  const completion = toInt(input.completionTokens);
  const total = toInt(input.totalTokens) || prompt + completion;
  // 三个字段全是 0（模型没回 usage）就没必要记，省得库里堆满空行
  if (prompt + completion + total === 0) return;

  try {
    const { error } = await supabase.from("sys_ai_token_usage").insert({
      tenant_id: ctx.tenantId ?? null,
      user_id: ctx.userId ?? null,
      session_id: ctx.sessionId ?? null,
      operation: input.operation,
      model: input.model ?? null,
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
    });
    if (error) throw error;
  } catch (err) {
    logger.warn("token-usage", "token 消耗记录写入失败", {
      operation: input.operation,
      error: logger.normalizeError(err),
    });
  }
}
