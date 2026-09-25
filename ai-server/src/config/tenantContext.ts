import { supabase } from "./supabase.js";

/**
 * 租户上下文。
 *
 * ai-server 用 service_role 连接 PostgREST，RLS 对它完全无效
 * （service_role 带 BYPASSRLS），所以租户隔离必须在应用层显式完成：
 * 每一条 erp_* 查询都要带 tenant_id 过滤，每一笔写入都要带 tenant_id。
 *
 * 设计原则：
 * 1. fail-closed —— 解析不出租户就抛错，绝不回退到「不加过滤」。
 * 2. 租户来源优先取显式传入的 tenant_id，其次从 sys_users 查，
 *    两者冲突时校验归属，防止越权切换到别的租户。
 * 3. 短期缓存，避免同一轮对话里重复查库。
 */

export interface TenantContext {
  tenantId: number;
  userId?: number;
  username?: string;
  isSuperAdmin: boolean;
}

export class TenantScopeError extends Error {
  readonly code = "TENANT_SCOPE_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  context: TenantContext;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 运维手工调整了 sys_users.tenant_id 后，可调用它立即失效缓存。 */
export function invalidateTenantCache(userId?: number): void {
  if (userId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(`user:${userId}`);
}

interface UserTenantRow {
  id: number;
  username: string | null;
  tenant_id: number | null;
  is_deleted: string | null;
  status: string | null;
  is_super_admin?: boolean | null;
}

/**
 * 解析一次请求的租户上下文。
 *
 * @param userId        来自请求体的 sys_users.id
 * @param explicitTenantId 前端/运维显式指定的租户（可选）
 */
export async function resolveTenantContext(
  userId?: number,
  explicitTenantId?: number,
): Promise<TenantContext> {
  if (userId === undefined || userId === null) {
    throw new TenantScopeError("缺少 user_id，无法确定租户上下文，已拒绝本次数据访问。");
  }

  const cacheKey = `user:${userId}`;
  const cached = cache.get(cacheKey);
  const now = Date.now();

  let context: TenantContext | null = null;

  if (cached && cached.expiresAt > now) {
    context = cached.context;
  } else {
    const { data, error } = await supabase
      .from("sys_users")
      .select("id, username, tenant_id, is_deleted, status")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;

    const user = data as UserTenantRow | null;
    if (!user || user.is_deleted === "y") {
      throw new TenantScopeError(`用户 id=${userId} 不存在或已删除，无法确定租户。`);
    }
    if (user.status !== null && user.status !== undefined && String(user.status) !== "1") {
      throw new TenantScopeError(`用户 id=${userId} 已停用，无法确定租户。`);
    }
    if (user.tenant_id === null || user.tenant_id === undefined) {
      throw new TenantScopeError(
        `用户 id=${userId} 未分配租户（sys_users.tenant_id 为空），已拒绝本次数据访问。`,
      );
    }

    const isSuperAdmin = await isSuperAdminUser(userId);
    context = {
      tenantId: Number(user.tenant_id),
      userId,
      username: user.username ?? undefined,
      isSuperAdmin,
    };
    cache.set(cacheKey, { context, expiresAt: now + CACHE_TTL_MS });
  }

  // 显式指定租户：必须与自身租户一致，或者操作者是超管
  if (explicitTenantId !== undefined && explicitTenantId !== null) {
    const target = Number(explicitTenantId);
    if (!Number.isInteger(target)) {
      throw new TenantScopeError(`tenant_id 不是合法整数：${String(explicitTenantId)}`);
    }
    if (target !== context.tenantId && !context.isSuperAdmin) {
      throw new TenantScopeError(
        `用户 id=${userId} 不属于租户 ${target}，无权访问该租户数据。`,
      );
    }
    return { ...context, tenantId: target };
  }

  return context;
}

/**
 * 判断是否为超级管理员。
 *
 * 注意：没有复用数据库里的 public.current_user_is_super_admin()，
 * 因为那个函数依赖 auth.uid()，而 ai-server 用 service_role 连接，
 * auth.uid() 恒为 NULL，调用结果永远是 false。这里直接查角色关联表。
 */
async function isSuperAdminUser(userId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("sys_user_roles")
    .select("sys_roles!inner(role_code)")
    .eq("user_id", userId)
    .eq("is_deleted", "n")
    .eq("sys_roles.role_code", "super_admin")
    .eq("sys_roles.is_deleted", "n")
    .limit(1);

  // 查不到就按非超管处理：宁可收紧跨租户能力，也不放开。
  if (error || !data || data.length === 0) return false;
  return true;
}
