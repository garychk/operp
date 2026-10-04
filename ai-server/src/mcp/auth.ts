import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { resolveTenantContext, type TenantContext } from "../config/tenantContext.js";

/**
 * MCP 身份解析。
 *
 * MCP 客户端不会带 sys_users.id，身份必须由服务端从凭据反查，所以这里把
 * 「出示的凭据 → user_id」这一步显式做掉，再交给 resolveTenantContext 得到租户上下文。
 * 复用而不重写租户解析，是为了继承 ai-server 已有的 fail-closed 语义：
 * 解析不出租户就抛错，绝不退化成「不过滤 tenant_id」。
 *
 * ── 凭据的两个来源，按优先级 ────────────────────────────────────────────────
 *
 *   1. 数据库 sys_mcp_api_keys（deploy_55）—— 推荐路径
 *      用户在前端「MCP 服务 → 我的密钥」里自助生成，只存 SHA-256 摘要。
 *      支持吊销与过期，每次命中回写 last_used_at 供审计。
 *
 *   2. .env 的 MCP_API_KEYS 静态映射 —— 兼容路径
 *      形如 key1=1,key2=2。保留它有两个理由：
 *        a) 本地调试时不必先建表就能跑通；
 *        b) 数据库不可用（或尚未执行 deploy_55）时有确定的身份来源，
 *           避免「查不到库 → 认证整体失效」。
 *      注意降级方向是安全的：查库失败只是**跳过**该来源，
 *      最终仍要过 .env 比对，对不上一样拒绝，不会因为故障而放行。
 *
 * ── 配置模型（客户端 env 与服务器 .env 各司其职） ───────────────────────────
 *   - MCP_API_KEY   ：本进程「出示」的凭据。由 MCP 客户端在 env 里注入。
 *   - MCP_API_KEYS  ：服务端维护的「凭据 → user_id」静态映射表。
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

/** 凭据最终是从哪儿认出来的，用于启动日志与排障 */
export type CredentialSource = "database" | "env-map" | "env-single" | "unresolved";

let credentialCache: Credential[] | null = null;
let lastSource: CredentialSource = "unresolved";

export const getCredentialSource = (): CredentialSource => lastSource;

/** SHA-256 十六进制小写。前端用 Web Crypto 算的摘要必须与此完全一致。 */
const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

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

interface DbKeyRow {
  id: number;
  user_id: number | null;
  name: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * 到 sys_mcp_api_keys 里核对出示的 Key。
 *
 * 返回 user_id 表示认证通过；返回 null 表示「这个来源没有结论」，
 * 由调用方继续尝试下一个来源 —— 包括查询本身失败的情况。
 * 这里刻意不抛错：查库失败是运维故障，不是认证结论，抛出去会把
 * 「数据库短暂不可用」变成「任何人都进不来」（反之若放行则是灾难，两者都不选）。
 */
async function lookupKeyInDatabase(token: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("sys_mcp_api_keys")
    .select("id, user_id, name, expires_at, revoked_at")
    .eq("key_hash", sha256Hex(token))
    .eq("is_deleted", "n")
    .maybeSingle();

  if (error) {
    console.warn(
      `[mcp] 查询 sys_mcp_api_keys 失败（${error.message}），本次仅回退到 MCP_API_KEYS 静态映射。` +
        "若尚未执行 supabase/tables/deploy_55_mcp_api_keys.sql，这是预期行为。",
    );
    return null;
  }
  if (!data) return null;

  const row = data as DbKeyRow;

  // 已吊销 / 已过期都算「查到了但这把不能用」，明确记录后按未命中处理
  if (row.revoked_at) {
    console.error(`[mcp] 出示的凭据「${row.name || row.id}」已被吊销，拒绝访问。`);
    return null;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
    console.error(`[mcp] 出示的凭据「${row.name || row.id}」已于 ${row.expires_at} 过期，拒绝访问。`);
    return null;
  }
  if (!row.user_id) {
    console.error(`[mcp] 凭据记录 ${row.id} 没有归属用户，拒绝访问。`);
    return null;
  }

  // 回写使用时间：审计字段，失败不影响本次认证，所以不 await
  void (async () => {
    try {
      const { error: touchError } = await supabase
        .from("sys_mcp_api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", row.id);
      if (touchError) {
        console.warn(`[mcp] last_used_at 回写失败：${touchError.message}`);
      }
    } catch (cause) {
      console.warn("[mcp] last_used_at 回写异常：", cause);
    }
  })();

  return row.user_id;
}

/**
 * 把「出示的凭据」解析成 sys_users.id。
 *
 * 任何一条路径都不允许静默降级：
 *  - 出示了凭据但两个来源都查不到 → 拒绝（不回落成单身份）
 *  - 没出示凭据但配了映射表     → 拒绝
 *  - 什么都没配                 → 拒绝
 */
export async function resolveMcpUserId(): Promise<number> {
  const presented = String(env.MCP_API_KEY || "").trim();
  const credentials = loadCredentials();

  if (presented) {
    // ① 数据库（自助生成、可吊销、有审计）
    const fromDatabase = await lookupKeyInDatabase(presented);
    if (fromDatabase !== null) {
      lastSource = "database";
      return fromDatabase;
    }

    // ② .env 静态映射（本地调试与既有部署的兼容通道）
    const matched = credentials.find((item) => safeEqual(item.token, presented));
    if (matched) {
      lastSource = "env-map";
      return matched.userId;
    }

    if (!credentials.length && env.MCP_USER_ID !== undefined) {
      // 单身份模式：只配了 MCP_API_KEY + MCP_USER_ID，没有映射表
      lastSource = "env-single";
      return env.MCP_USER_ID;
    }

    lastSource = "unresolved";
    throw new McpAuthError(
      `出示的 MCP_API_KEY（${maskToken(presented)}）在 sys_mcp_api_keys 与 MCP_API_KEYS 中均无匹配，已拒绝访问。`,
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
    lastSource = "env-single";
    return env.MCP_USER_ID;
  }

  lastSource = "unresolved";
  throw new McpAuthError(
    "未配置 MCP 凭据：请设置 MCP_API_KEYS（推荐）或 MCP_API_KEY + MCP_USER_ID。",
  );
}

/** 解析本次 MCP 会话的身份与租户，失败即拒绝。 */
export async function resolveMcpIdentity(): Promise<TenantContext> {
  const userId = await resolveMcpUserId();
  const context = await resolveTenantContext(userId, env.MCP_TENANT_ID);

  if (env.MCP_TENANT_ID !== undefined && env.MCP_TENANT_ID !== context.tenantId) {
    console.log(
      `[mcp] 超管 ${context.username || userId} 跨租户操作：自身租户 ${context.tenantId} → 目标租户 ${env.MCP_TENANT_ID}`,
    );
  }

  return context;
}

/** 启动时打印一行脱敏身份信息，方便确认连的是谁、凭据从哪儿认出来的 */
export function describeMcpIdentity(context: TenantContext): string {
  const presented = String(env.MCP_API_KEY || "").trim();
  return [
    `user=${context.username || context.userId}`,
    `user_id=${context.userId}`,
    `tenant_id=${context.tenantId}`,
    `super_admin=${context.isSuperAdmin ? "yes" : "no"}`,
    presented ? `key=${maskToken(presented)}` : "key=(none)",
    `source=${lastSource}`,
  ].join(" ");
}
