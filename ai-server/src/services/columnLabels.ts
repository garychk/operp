/**
 * 查询结果的列名本地化（LLM 翻译）。
 *
 * 背景：分析类工具直接把 SQL 的列名当表头渲染（`product_id` / `total_cost`），
 * 用户看到的是数据库字段名 —— 既不友好，也在界面语言为英文时没法跟着切换。
 *
 * 做法：拿列名批量问一次模型，让它按**界面语言**给出业务口径的列名
 * （zh → 中文业务名词，en → 英文业务短语），再回填到 markdown 表头。
 *
 * 三条硬约束：
 *   1. 失败绝不影响分析结果 —— 任何异常都退回原始列名（try/catch 兜住）；
 *   2. 同一字段不重复翻译 —— 进程级缓存（键含语言），第二次问同一列直接命中；
 *   3. 只翻译「蛇形英文标识符」—— 中文别名、单单词列名原样保留，不浪费一次往返。
 */
import { callChatModel } from "../config/llm.js";
import type { AiChatRequest } from "../ai/state.js";
import { normalizeUiLocale, type UiLocale } from "./locale.js";
import { logger } from "./logger.js";

type ProviderConfig = AiChatRequest["provider"];

export type { UiLocale };

/** 蛇形英文标识符 = 大概率是数据库字段名；中文别名 / 单单词（`total`）不翻译 */
const SNAKE_CASE_FIELD = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i;

const CACHE_MAX = 1000;
/** key = `${locale}:${column}`（进程级，重启即失效；列名翻译不需要持久化） */
const labelCache = new Map<string, string>();

const cacheGet = (locale: UiLocale, column: string) =>
  labelCache.get(`${locale}:${column}`);

const cacheSet = (locale: UiLocale, column: string, label: string) => {
  if (labelCache.size >= CACHE_MAX) {
    // 简单 FIFO 淘汰：先删最早插入的一条，避免无上限增长
    const oldest = labelCache.keys().next().value;
    if (oldest !== undefined) labelCache.delete(oldest);
  }
  labelCache.set(`${locale}:${column}`, label);
};

const stripFence = (value: string) => {
  const trimmed = String(value || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
};

export interface ColumnLabelContext {
  /** 业务语境（如「库存」「销售订单」），只用于提示模型，不落地 */
  businessHint?: string;
  /** SQL 实际引用的表名（同样只作语境，模型不许把它们写进输出） */
  tables?: string[];
}

const buildPrompt = (
  columns: string[],
  locale: UiLocale,
  context: ColumnLabelContext,
) => {
  const languageRule =
    locale === "en"
      ? [
          "目标语言：English",
          "1. 用业务人员看得懂的英文短语（2-4 个单词），不要直译、不要出现下划线、不要出现中文；",
          "2. 不同字段必须译成不同名字，保持区分度；",
          "3. 只输出 JSON 对象：键为原字段名，值为英文列名，不要 Markdown、不要解释。",
        ]
      : [
          "目标语言：简体中文",
          "1. 用业务口径的短名词（2-8 个字），不要直译、不要保留英文、不要出现下划线；",
          "2. 不同字段必须译成不同名字，保持区分度；",
          "3. 只输出 JSON 对象：键为原字段名，值为中文列名，不要 Markdown、不要解释。",
        ];

  return [
    "你是 ERP 报表的列名本地化助手，负责把数据库字段名改写为界面展示用的列名。",
    ...languageRule,
    context.businessHint ? `业务语境：${context.businessHint}` : "",
    `字段列表：${JSON.stringify(columns)}`,
  ]
    .filter(Boolean)
    .join("\n");
};

/**
 * 批量解析列名 → 展示名。
 *
 * @returns 列名到展示名的映射（未翻译的列返回原列名，保证拿到的映射是完整的）
 */
export const resolveColumnLabels = async (
  columns: string[],
  options: {
    locale?: string;
    provider?: ProviderConfig;
    context?: ColumnLabelContext;
  } = {},
): Promise<Record<string, string>> => {
  const locale = normalizeUiLocale(options.locale);
  const result: Record<string, string> = {};
  const pending: string[] = [];

  for (const column of columns) {
    const name = String(column || "").trim();
    if (!name) continue;
    if (!SNAKE_CASE_FIELD.test(name)) {
      result[name] = name;
      continue;
    }
    const cached = cacheGet(locale, name);
    if (cached) result[name] = cached;
    else pending.push(name);
  }

  if (!pending.length) return result;

  try {
    const { content } = await callChatModel(
      [
        { role: "system", content: "你只输出 JSON 对象。" },
        {
          role: "user",
          content: buildPrompt(pending, locale, options.context || {}),
        },
      ],
      options.provider,
      "column_label",
    );
    const parsed = JSON.parse(stripFence(content)) as Record<string, unknown>;
    for (const name of pending) {
      const value = parsed && typeof parsed[name] === "string" ? String(parsed[name]).trim() : "";
      // 模型可能把字段名写进值里（如 "product_id"）→ 这种结果没有意义，退回原名
      const usable = value && value !== name && !value.includes("_");
      result[name] = usable ? value : name;
      if (usable) cacheSet(locale, name, value);
    }
    logger.debug("columnLabels", "translated", {
      locale,
      columns: pending.length,
      translated: pending.filter((name) => result[name] !== name).length,
    });
  } catch (error) {
    // 翻译失败不影响分析结果：退回原始列名
    logger.warn("columnLabels", "translate failed, fallback to raw names", {
      locale,
      columns: pending.length,
      error: logger.normalizeError(error),
    });
    for (const name of pending) result[name] = name;
  }

  return result;
};
