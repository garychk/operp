/**
 * HTTP 请求身份守卫。
 *
 * 为什么必须存在：/api/ai/chat 此前完全不验 JWT，user_id 由请求体提供 ——
 * 任何能访问 ai-server 的人知道一个 sys_users.id 就能冒充该用户
 * （租户、焦点、会话记忆全跟着走）。CORS 只挡浏览器，挡不住脚本调用。
 *
 * 现在的身份链路（不可跳过任何一环）：
 *   1. Authorization: Bearer <Supabase access_token> → supabase.auth.getUser(token)
 *      验签、验过期（GoTrue 校验，无法伪造）；
 *   2. auth.users.id（uuid）→ sys_users.auth_id 映射出业务用户；
 *   3. resolveTenantContext 解析租户（复用既有缓存/超管/停用判定）；
 *   4. 请求体里的 user_id 只做一致性校验：与 JWT 身份不符直接 403。
 *
 * ⚠️ 部署提醒：前端必须在请求头带上 access_token（AIChatPanel / KnowledgeBase
 * 已同步改造）。没带 token 的旧客户端会得到 401，这是刻意行为。
 */
import type { Request, RequestHandler, Response, NextFunction } from "express";
import { supabase } from "../config/supabase.js";
import { resolveTenantContext, TenantScopeError } from "../config/tenantContext.js";

export interface RequestIdentity {
  /** GoTrue auth.users.id（uuid） */
  authId: string;
  /** sys_users.id（业务用户 id，后续审计/记忆/工具全部用它） */
  userId: number;
  tenantId: number;
  username?: string;
  isSuperAdmin: boolean;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const extractBearerToken = (req: Request): string => {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/** 宽松数字解析：query 里全是字符串，body 里可能是 number，统一收敛成 number | undefined */
const parseNumericParam = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
};

/** 完整解析一次请求身份。任何一环失败都抛 AuthError / TenantScopeError。 */
export async function resolveRequestIdentity(req: Request): Promise<RequestIdentity> {
  const token = extractBearerToken(req);
  if (!token) {
    throw new AuthError(401, "缺少 Authorization: Bearer <access_token>，请先登录。");
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError(401, "访问令牌无效或已过期，请重新登录。");
  }

  const { data: sysUser, error: mapError } = await supabase
    .from("sys_users")
    .select("id, username")
    .eq("auth_id", data.user.id)
    .maybeSingle();
  if (mapError) throw mapError;
  if (!sysUser) {
    throw new AuthError(403, "登录账号未绑定系统用户（sys_users.auth_id 缺失映射），已拒绝访问。");
  }

  // body 与 query 都要过一致性校验：POST 路由带 body.user_id，
  // GET 路由（mrp/mps/finance 的只读端点）带 query.user_id，都是明文不可信。
  const claimedUserId =
    parseNumericParam(req.body?.user_id) ?? parseNumericParam(req.query?.user_id);
  if (claimedUserId !== undefined && Number(claimedUserId) !== Number(sysUser.id)) {
    throw new AuthError(
      403,
      "请求里的 user_id 与登录身份不一致，已拒绝本次请求（身份以 JWT 为准）。",
    );
  }

  const claimedTenantId =
    parseNumericParam(req.body?.tenant_id) ?? parseNumericParam(req.query?.tenant_id);
  const context = await resolveTenantContext(Number(sysUser.id), claimedTenantId);

  return {
    authId: data.user.id,
    userId: context.userId || 0,
    tenantId: context.tenantId,
    username: context.username ?? (sysUser.username as string | undefined) ?? undefined,
    isSuperAdmin: context.isSuperAdmin,
  };
}

/** Express 中间件：解析身份挂在 req.identity 上，失败直接写响应。 */
export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    (req as Request & { identity?: RequestIdentity }).identity =
      await resolveRequestIdentity(req);
    next();
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.status).json({ ok: false, error: error.message });
      return;
    }
    if (error instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: error.message });
      return;
    }
    console.error("[ai-server] requireAuth 未预期错误:", error);
    res.status(401).json({ ok: false, error: "身份校验失败。" });
  }
};

/** 从 req 上取身份（必须先过 requireAuth，否则抛错 = 编排错误，fail-loud）。 */
export function getIdentity(req: Request): RequestIdentity {
  const identity = (req as Request & { identity?: RequestIdentity }).identity;
  if (!identity) {
    throw new AuthError(500, "身份未解析（路由缺少 requireAuth 中间件）。");
  }
  return identity;
}
