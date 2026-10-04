import { TenantScopeError } from "../config/tenantContext.js";
import { McpAuthError } from "./auth.js";

/**
 * MCP 工具契约：结果形状 + 注解（annotations）。
 *
 * 抽出来的原因：工具集从「只读」扩到「只读 + 写入」之后，两个注册模块
 * （tools.ts / documentTools.ts）都要把异常收敛成 isError 结果，
 * 也都要声明同一套注解语义。这份契约只能有一份。
 */

export const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export const fail = (text: string) => ({
  content: [{ type: "text" as const, text }],
  isError: true,
});

export const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/**
 * 统一兜底：把异常转成 isError 结果，避免抛出去把 stdio 连接打挂。
 *
 * @param explain 把原始报错渲染成人能照着排查的说明；默认原样返回。
 */
export async function runTool(
  label: string,
  fn: () => Promise<string>,
  explain: (message: string) => string = (message) => `工具执行失败：${message}`,
) {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof TenantScopeError || error instanceof McpAuthError) {
      return fail(`拒绝访问：${error.message}`);
    }
    console.error(`[mcp] 工具 ${label} 执行失败：`, error);
    return fail(explain(formatError(error)));
  }
}

/** 纯查询：不改动任何数据，客户端可以放心自动调用 */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * 写入草稿：会落一行 sys_ai_pending_actions，但不动业务表。
 * 因此不是只读，也不具破坏性，且每次调用产生新草稿（非幂等）。
 */
export const WRITE_DRAFT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * 真正写业务库：破坏性、不可重复执行。
 * idempotentHint 为 true 是因为草稿本身一次性 —— 同一条草稿重复提交会被
 * already_handled 挡下，不会把单据过账两次。
 */
export const DESTRUCTIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
