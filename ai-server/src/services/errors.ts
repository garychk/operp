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
