/**
 * 把「任意抛出物」转成一句人能读的错误信息。
 *
 * 为什么不能只写 `err instanceof Error ? err.message : String(err)`：
 * supabase-js 调 RPC 时，数据库的 `RAISE EXCEPTION` 会被 PostgREST 包成一个
 * **普通对象**（PostgrestError：`{ message, details, hint, code }`）抛出，
 * 它不是 Error 实例 → 落到 `String(err)` 分支，用户看到的是 `[object Object]`；
 * 更糟的是按 message 做的 HTTP 状态码映射（409 冲突 / 422 校验…）会全部退化成
 * 500，调用方无法区分「重复调汇」和「服务炸了」。
 *
 * 实测用例：对同一期间同一币种重复执行期末调汇，数据库抛
 * `Period 3 already has an active FX revaluation for USD (id=4). Reverse it first.`，
 * 修复前响应是 `{"ok":false,"error":"[object Object]"}` + HTTP 500。
 */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;

  if (err && typeof err === "object") {
    const candidate = err as Record<string, unknown>;
    const parts = ["message", "details", "hint", "error_description"]
      .map((key) => candidate[key])
      .filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      );
    if (parts.length > 0) return parts.join(" | ");
  }

  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // 循环引用等：退回 String()
  }
  return String(err);
}

/** 数据库错误的归类结果（PG SQLSTATE + 命中的约束 / 列名，用于本地化文案） */
export interface PgErrorInfo {
  /** PG SQLSTATE，如 23505；取不到时为空串 */
  code: string;
  /** 唯一 / 外键 / check 约束名 */
  constraint: string;
  /** not-null 违规的列名 */
  column: string;
  /** 原始信息（兜底展示） */
  raw: string;
}

const pickString = (err: unknown, key: string): string => {
  if (!err || typeof err !== "object") return "";
  const value = (err as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/**
 * 归类 supabase-js / PG 抛出的写入错误。
 *
 * 抽出来是因为「确认操作执行失败，请稍后重试。」这种兜底文案会把真正的原因
 * （2026-10-16 事故里的 23505 duplicate key）整个吞掉，事后无从追查 ——
 * 归类后既能把约束名回显给用户，也能判断这张草稿还值不值得重试。
 */
export function classifyPgError(err: unknown): PgErrorInfo {
  const raw = extractErrorMessage(err);
  const direct = pickString(err, "code");
  const code = /^\d{5}$|^[0-9A-Z]{5}$/.test(direct) ? direct : (raw.match(/\b(2[0-9A-Z]{4})\b/)?.[1] ?? "");
  const constraint =
    raw.match(/unique constraint "([^"]+)"/i)?.[1] ??
    raw.match(/foreign key constraint "([^"]+)"/i)?.[1] ??
    raw.match(/check constraint "([^"]+)"/i)?.[1] ??
    "";
  const column =
    raw.match(/null value in column "([^"]+)"/i)?.[1] ??
    raw.match(/column "([^"]+)" of relation/i)?.[1] ??
    "";
  return { code, constraint, column, raw };
}

/** 该错误「同样内容再执行一次」是否可能成功（23xxx 约束类错误必然再失败） */
export const isRetryablePgError = (info: PgErrorInfo): boolean =>
  !(info.code.startsWith("23") || info.code.startsWith("22") || info.code === "42501");
