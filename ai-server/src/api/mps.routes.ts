/**
 * 主生产计划 MPS HTTP 路由（阶段 5）。
 *
 * 鉴权口径与 /api/mrp 完全一致：
 * - 全部端点过 requireAuth：身份链路 Supabase JWT → sys_users.auth_id → 租户解析，
 *   body/query 明文 user_id 只做一致性校验（不符直接 403），绝不作为身份来源。
 * - 写操作（confirm / push）的角色在服务端查 sys_user_roles 核实
 *   （super_admin / tenant_admin / mrp_manager），一律用 JWT 解析出的 identity.userId。
 * - 读端点（overview / rccp）不核角色，只核租户归属 —— 与 GET /api/mrp/cost 同口径。
 *
 * 端点：
 *   GET  /api/mps/overview?plan_id          计划行汇总（含订单参考量/剩余可下推）
 *   GET  /api/mps/rccp?plan_id              粗能力校验（工作中心 × 月负荷，纯计算）
 *   POST /api/mps/confirm                   确认 / 取消确认
 *   POST /api/mps/push                      下推生产订单（一行一张 MO，台账防重复）
 */
import { Router } from "express";
import { z } from "zod";
import {
  computeRccp,
  errorMessage,
  loadMpsOverview,
  pushPlanToProductionOrders,
  setPlanConfirmed,
} from "../services/mpsService.js";
import { userHasRole } from "../services/roleGuard.js";
import { getIdentity, requireAuth } from "../services/authGuard.js";
import { heavyActionRateLimit } from "../services/rateLimit.js";

export const mpsRouter = Router();

// 所有端点（含只读 overview / rccp）都要登录：租户上下文由中间件统一解析
mpsRouter.use(requireAuth);

// 确认 / 下推是重操作（批量建 MO），按用户限流
mpsRouter.use("/confirm", heavyActionRateLimit);
mpsRouter.use("/push", heavyActionRateLimit);

const MPS_ROLES = new Set(["super_admin", "tenant_admin", "mrp_manager"]);

// user_id/tenant_id 仅为兼容旧客户端保留：requireAuth 已核过一致性，处理逻辑一律用 identity
const planSchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  tenant_id: z.coerce.number().int().positive().optional(),
  plan_id: z.coerce.number().int().positive(),
});

const confirmSchema = planSchema.extend({
  confirm: z.coerce.boolean(),
});

const pushSchema = planSchema.extend({
  line_ids: z.array(z.coerce.number().int().positive()).optional(),
});

/** 409：状态冲突（重复确认 / 已下推还想取消确认 / 未确认就想下推） */
const isConflict = (message: string) =>
  /已经确认|已锁定|尚未确认|已有.*行下推|没有任何 MPS/.test(message);

/** 计划不存在 / 不属于当前租户 → 404 */
const isNotFound = (message: string) => /不存在或不属于当前租户/.test(message);

mpsRouter.get("/overview", async (req, res) => {
  const planId = Number(req.query.plan_id);

  if (!Number.isInteger(planId) || planId <= 0) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const identity = getIdentity(req);
    const overview = await loadMpsOverview(identity.tenantId, planId);
    res.json({ ok: true, ...overview });
  } catch (err) {
    const message = errorMessage(err);
    if (isNotFound(message)) {
      res.status(404).json({ ok: false, error: message });
      return;
    }
    res.status(500).json({ ok: false, error: message });
  }
});

mpsRouter.get("/rccp", async (req, res) => {
  const planId = Number(req.query.plan_id);

  if (!Number.isInteger(planId) || planId <= 0) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const identity = getIdentity(req);
    const outcome = await computeRccp(identity.tenantId, planId);
    res.json({ ok: true, ...outcome });
  } catch (err) {
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
    const { plan_id, confirm } = parsed.data;
    const identity = getIdentity(req);

    const allowed = await userHasRole(identity.userId, MPS_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有确认主生产计划的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const plan = await setPlanConfirmed(identity.tenantId, plan_id, confirm);
    res.json({ ok: true, plan_id: plan.id, plan_no: plan.plan_no, status: plan.status });
  } catch (err) {
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
    const { plan_id, line_ids } = parsed.data;
    const identity = getIdentity(req);

    const allowed = await userHasRole(identity.userId, MPS_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有下推主生产计划的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const outcome = await pushPlanToProductionOrders(
      identity.tenantId,
      plan_id,
      identity.userId,
      line_ids,
    );
    res.json({ ok: true, ...outcome });
  } catch (err) {
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
