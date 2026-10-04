/**
 * 角色校验：服务端自己查 sys_user_roles，**绝不信任请求体自称的角色**。
 *
 * 抽成公共模块的原因：MRP / MPS / 财务三个路由都要用同一条逻辑。
 * 之前 mrp.routes.ts 与 mps.routes.ts 各抄了一份（后者的注释还写着
 * "与 mrp.routes.userHasRole 同构"），再加一份就是三份 —— 这类复制最容易
 * 在某一份里漏掉 `.eq("sys_roles.is_deleted", "n")`，于是角色被软删之后
 * 仍然放行。
 */
import { supabase } from "../config/supabase.js";

/** 服务端核实用户是否持有 allowed 集合里的任一角色 */
export async function userHasRole(userId: number, allowed: Set<string>): Promise<boolean> {
  const { data, error } = await supabase
    .from("sys_user_roles")
    .select("sys_roles!inner(role_code)")
    .eq("user_id", userId)
    .eq("is_deleted", "n")
    .eq("sys_roles.is_deleted", "n");

  // 查询出错按无权限处理：宁可拒绝，不可放行
  if (error) return false;

  return (data || []).some((row: unknown) => {
    const roleCode = (row as { sys_roles?: { role_code?: string } } | null)?.sys_roles?.role_code;
    return roleCode ? allowed.has(roleCode) : false;
  });
}
