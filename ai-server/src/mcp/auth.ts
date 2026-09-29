import { timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { resolveTenantContext, type TenantContext } from "../config/tenantContext.js";

/**
 * MCP 身份解析。
 *
 * MCP 客户端不会带 sys_users.id，身份必须由服务端从凭据反查，所以这里把
 * 「出示的凭据 → user_id」这一步显式做掉，再交给 resolveTenantContext 得到租户上下文。
 * 复用而不重写租户解析，是为了继承 ai-server 已有的 fail-closed 语义：
 * 解析不出租户就抛错，绝不退化成「不过滤 tenant_id」。
 *
 * 配置模型（客户端 env 与服务器 .env 各司其职）：
 *   - MCP_API_KEY   ：本进程「出示」的凭据。由 MCP 客户端在 env 里注入。
 *   - MCP_API_KEYS  ：服务端维护的「凭据 → user_id」映射表，形如 key1=1,key2=2。
 *   - MCP_USER_ID   ：单身份模式的兜底，仅在没有映射表时生效。
 *   - MCP_TENANT_ID ：显式指定租户，仅该用户为超管时才允许跨租户。
 *
 * dotenv 不会覆盖已存在的 process.env，所以客户端注入的 MCP_API_KEY 优先于 .env 里的同名项，
 * 这条特性正是上面「出示 vs 映射表」两个变量能共存的原因。
 */

export class McpAuthError extends Error {
  readonly code = "MCP_AUTH_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

interface Credential {
  token: string;
  userId: number;
}

let credentialCache: Credential[] | null = null;

/** 常量时间比较，避免用 token 前缀做时序侧信道探测 */
const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const maskToken = (token: string): string => {
  if (token.length <= 8) return "***";
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
};

/** 解析 MCP_API_KEYS 映射表：`key1=1,key2=2` */
function loadCredentials(): Credential[] {
  if (credentialCache) return credentialCache;

  const list: Credential[] = [];
  const raw = String(env.MCP_API_KEYS || "").trim();

  if (raw) {
    for (const entry of raw.split(",")) {
      const item = entry.trim();
      if (!item) continue;

      // 用 lastIndexOf：凭据本身允许含 '='（base64 padding 很常见）
      const separator = item.lastIndexOf("=");
      if (separator <= 0) {
        throw new McpAuthError(
          `MCP_API_KEYS 存在格式错误的条目「${item}」，应为 <apiKey>=<userId>。`,
        );
      }

      const token = item.slice(0, separator).trim();
      const userId = Number(item.slice(separator + 1).trim());

      if (!token) {
        throw new McpAuthError(`MCP_API_KEYS 中存在空凭据：「${item}」。`);
      }
      if (!Number.isInteger(userId) || userId <= 0) {
        throw new McpAuthError(
          `MCP_API_KEYS 中「${maskToken(token)}」对应的 user_id 不是正整数。`,
        );
      }

      list.push({ token, userId });
    }
  }

  credentialCache = list;
  return list;
}

/**
 * 把「出示的凭据」解析成 sys_users.id。
 *
 * 任何一条路径都不允许静默降级：
 *  - 出示了凭据但不在映射表里 → 拒绝（不回落成单身份）
 *  - 没出示凭据但配了映射表 → 拒绝
 *  - 什么都没配 → 拒绝
 */
export function resolveMcpUserId(): number {
  const credentials = loadCredentials();
  const presented = String(env.MCP_API_KEY || "").trim();

  if (presented) {
    const matched = credentials.find((item) => safeEqual(item.token, presented));
    if (matched) return matched.userId;

    if (!credentials.length && env.MCP_USER_ID !== undefined) {
      // 单身份模式：只配了 MCP_API_KEY + MCP_USER_ID，没有映射表
      return env.MCP_USER_ID;
    }

    throw new McpAuthError(
      `出示的 MCP_API_KEY（${maskToken(presented)}）不在 MCP_API_KEYS 映射表中，已拒绝访问。`,
    );
  }

  if (credentials.length) {
    throw new McpAuthError(
      "未提供 MCP_API_KEY，无法确定身份。请在 MCP 客户端的 env 中配置 MCP_API_KEY。",
    );
  }

  if (env.MCP_USER_ID !== undefined) {
    console.warn(
      `[mcp] 未配置任何凭据，退回到 MCP_USER_ID=${env.MCP_USER_ID}。该模式仅供本机调试，请勿用于生产。`,
    );
    return env.MCP_USER_ID;
  }

  throw new McpAuthError(
    "未配置 MCP 凭据：请设置 MCP_API_KEYS（推荐）或 MCP_API_KEY + MCP_USER_ID。",
  );
}

/** 解析本次 MCP 会话的身份与租户，失败即拒绝。 */
export async function resolveMcpIdentity(): Promise<TenantContext> {
  const userId = resolveMcpUserId();
  const context = await resolveTenantContext(userId, env.MCP_TENANT_ID);

  if (env.MCP_TENANT_ID !== undefined && env.MCP_TENANT_ID !== context.tenantId) {
    console.log(
      `[mcp] 超管 ${context.username || userId} 跨租户操作：自身租户 ${context.tenantId} → 目标租户 ${env.MCP_TENANT_ID}`,
    );
  }

  return context;
}

/** 启动时打印一行脱敏身份信息，方便确认连的是谁 */
export function describeMcpIdentity(context: TenantContext): string {
  const presented = String(env.MCP_API_KEY || "").trim();
  return [
    `user=${context.username || context.userId}`,
    `user_id=${context.userId}`,
    `tenant_id=${context.tenantId}`,
    `super_admin=${context.isSuperAdmin ? "yes" : "no"}`,
    presented ? `key=${maskToken(presented)}` : "key=(none)",
  ].join(" ");
}
