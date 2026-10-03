/**
 * 主生产计划 MPS HTTP 路由（阶段 5）。
 *
 * 鉴权口径与 /api/mrp 完全一致：
 * - body 明文 user_id/tenant_id 只用来「找到人」，写操作的角色必须在服务端查
 *   sys_user_roles 核实（super_admin / tenant_admin / mrp_manager）。
 * - 读端点（overview / rccp）不核角色，只核租户归属 —— 与 GET /api/mrp/cost 同口径。
 *
 * 端点：
 *   GET  /api/mps/overview?user_id&plan_id  计划行汇总（含订单参考量/剩余可下推）
 *   GET  /api/mps/rccp?user_id&plan_id      粗能力校验（工作中心 × 月负荷，纯计算）
 *   POST /api/mps/confirm                   确认 / 取消确认
 *   POST /api/mps/push                      下推生产订单（一行一张 MO，台账防重复）
 */
import { Router } from "express";
import { z } from "zod";
import { resolveTenantContext, TenantScopeError } from "../config/tenantContext.js";
import {
  computeRccp,
  errorMessage,
  loadMpsOverview,
  pushPlanToProductionOrders,
  setPlanConfirmed,
} from "../services/mpsService.js";
import { supabase } from "../config/supabase.js";

export const mpsRouter = Router();

const MPS_ROLES = new Set(["super_admin", "tenant_admin", "mrp_manager"]);

const planSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  tenant_id: z.coerce.number().int().positive().optional(),
  plan_id: z.coerce.number().int().positive(),
});

const confirmSchema = planSchema.extend({
  confirm: z.coerce.boolean(),
});

const pushSchema = planSchema.extend({
  line_ids: z.array(z.coerce.number().int().positive()).optional(),
});

/** 服务端核实角色（不信任请求体的任何自称）—— 与 mrp.routes.userHasRole 同构 */
async function userHasRole(userId: number, allowed: Set<string>): Promise<boolean> {
  const { data, error } = await supabase
    .from("sys_user_roles")
    .select("sys_roles!inner(role_code)")
    .eq("user_id", userId)
    .eq("is_deleted", "n")
    .eq("sys_roles.is_deleted", "n");
  if (error) return false;
  return (data || []).some((row: unknown) => {
    const roleCode = (row as { sys_roles?: { role_code?: string } } | null)?.sys_roles?.role_code;
    return roleCode ? allowed.has(roleCode) : false;
  });
}

/** 409：状态冲突（重复确认 / 已下推还想取消确认 / 未确认就想下推） */
const isConflict = (message: string) =>
  /已经确认|已锁定|尚未确认|已有.*行下推|没有任何 MPS/.test(message);

/** 计划不存在 / 不属于当前租户 → 404 */
const isNotFound = (message: string) => /不存在或不属于当前租户/.test(message);

mpsRouter.get("/overview", async (req, res) => {
  const userId = Number(req.query.user_id);
  const tenantId = req.query.tenant_id === undefined ? undefined : Number(req.query.tenant_id);
  const planId = Number(req.query.plan_id);

  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(planId) || planId <= 0) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const context = await resolveTenantContext(userId, tenantId);
    const overview = await loadMpsOverview(context.tenantId, planId);
    res.json({ ok: true, ...overview });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = errorMessage(err);
    if (isNotFound(message)) {
      res.status(404).json({ ok: false, error: message });
      return;
    }
    res.status(500).json({ ok: false, error: message });
  }
});

mpsRouter.get("/rccp", async (req, res) => {
  const userId = Number(req.query.user_id);
  const tenantId = req.query.tenant_id === undefined ? undefined : Number(req.query.tenant_id);
  const planId = Number(req.query.plan_id);

  if (!Number.isInteger(userId) || userId <= 0 || !Number.isInteger(planId) || planId <= 0) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const context = await resolveTenantContext(userId, tenantId);
    const outcome = await computeRccp(context.tenantId, planId);
    res.json({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = errorMessage(err);
    if (isNotFound(message)) {
      res.status(404).json({ ok: false, error: message });
      return;
    }
    res.status(500).json({ ok: false, error: message });
  }
});

mpsRouter.post("/confirm", async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { user_id, tenant_id, plan_id, confirm } = parsed.data;
    const context = await resolveTenantContext(user_id, tenant_id);

    const allowed = await userHasRole(user_id, MPS_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有确认主生产计划的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const plan = await setPlanConfirmed(context.tenantId, plan_id, confirm);
    res.json({ ok: true, plan_id: plan.id, plan_no: plan.plan_no, status: plan.status });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = errorMessage(err);
    if (isConflict(message)) {
      res.status(409).json({ ok: false, error: message });
      return;
    }
    if (isNotFound(message)) {
      res.status(404).json({ ok: false, error: message });
      return;
    }
    console.error("[ai-server] MPS confirm failed:", err);
    res.status(500).json({ ok: false, error: message });
  }
});

mpsRouter.post("/push", async (req, res) => {
  const parsed = pushSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { user_id, tenant_id, plan_id, line_ids } = parsed.data;
    const context = await resolveTenantContext(user_id, tenant_id);

    const allowed = await userHasRole(user_id, MPS_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有下推主生产计划的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const outcome = await pushPlanToProductionOrders(
      context.tenantId,
      plan_id,
      user_id,
      line_ids,
    );
    res.json({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = errorMessage(err);
    if (isConflict(message)) {
      res.status(409).json({ ok: false, error: message });
      return;
    }
    if (isNotFound(message)) {
      res.status(404).json({ ok: false, error: message });
      return;
    }
    console.error("[ai-server] MPS push failed:", err);
    res.status(500).json({ ok: false, error: message });
  }
});
