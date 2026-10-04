/**
 * 结构化日志（JSON lines → stdout）。
 *
 * 为什么不用 console.log：出了问题要能按 requestId / userId / 模块聚合检索，
 * 纯文本日志做不到。生产环境接 log 收集器（Loki / ELK / 云日志）时，
 * JSON 行可以直接解析，无需正则。
 *
 * 用法：
 *   logger.info("llm", "chat call ok", { durationMs: 812, model: "deepseek" });
 *   logger.warn("llm", "retry attempt", { attempt: 2, error: "timeout" });
 *
 * 级别由 LOG_LEVEL 控制（debug < info < warn < error），默认 info。
 * debug 级别在生产关闭，开发设 LOG_LEVEL=debug 打开。
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel: Level = ((): Level => {
  const raw = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error"
    ? (raw as Level)
    : "info";
})();

export type LogFields = Record<string, unknown>;

/** 常见错误对象收敛成可检索字符串（Error / PostgREST 普通对象 / 字符串） */
const normalizeError = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const write = (level: Level, module: string, message: string, fields?: LogFields) => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    module,
    message,
    ...(fields || {}),
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const logger = {
  debug: (module: string, message: string, fields?: LogFields) =>
    write("debug", module, message, fields),
  info: (module: string, message: string, fields?: LogFields) =>
    write("info", module, message, fields),
  warn: (module: string, message: string, fields?: LogFields) =>
    write("warn", module, message, fields),
  error: (module: string, message: string, fields?: LogFields) =>
    write("error", module, message, fields),
  normalizeError,
};
