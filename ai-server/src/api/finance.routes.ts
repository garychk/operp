/**
 * 财务（多币别）HTTP 路由：期末调汇、往来核销。
 *
 * 为什么财务动作需要服务端入口：调汇是**期间性批量动作**（每月末对全部外币
 * 往来重估），既不该让人逐笔点，也需要可被定时任务/AI 触发。
 *
 * ⚠️ 租户上下文：这里调用的都是 `service_*` 系列 RPC，它们会在**同一个事务内**
 * 用 set_config 注入 request.jwt.claims + app.tenant_id。
 * 原因见 supabase/tables/deploy_76_service_role_finance_entry.sql 的文件头：
 * ai-server 用 service_role 经 PostgREST 连库时 current_tenant_id() 恒为 NULL，
 * 直接调业务 RPC 会报 `No tenant context`。
 * 所以：**传 p_tenant_id 时必须传 resolveTenantContext 校验过的那个值**，
 * 不要直接透传请求体里的 tenant_id。
 *
 * ⚠️ 鉴权（同 MRP/MPS 口径）：全部端点过 requireAuth —— 身份链路 Supabase JWT →
 * sys_users.auth_id → 租户解析，body/query 明文 user_id 只做一致性校验（不符 403）。
 * service_* RPC 的 p_user_id 一律传 JWT 解析出的 identity.userId。
 *
 * ⚠️ 角色：财务动作只允许 super_admin / tenant_admin / finance_manager。
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { TenantScopeError } from "../config/tenantContext.js";
import { userHasRole } from "../services/roleGuard.js";
import { extractErrorMessage } from "../services/errors.js";
import { getIdentity, requireAuth, type RequestIdentity } from "../services/authGuard.js";

export const financeRouter = Router();

// 所有端点（含只读查询）都要登录：租户上下文由中间件统一解析
financeRouter.use(requireAuth);

/** 财务动作白名单：与 deploy_71/deploy_74 的表权限基线保持一致 */
const FINANCE_ROLES = new Set(["super_admin", "tenant_admin", "finance_manager"]);

const FX_REVALUATION_TABLE = "erp_fx_revaluation_s_539dcf81_b";
const FX_OPEN_VIEW = "vw_erp_ar_ap_open";

// user_id/tenant_id 仅为兼容旧客户端保留：requireAuth 已核过一致性，处理逻辑一律用 identity
const baseQuerySchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  tenant_id: z.coerce.number().int().positive().optional(),
});

const runRevaluationSchema = baseQuerySchema.extend({
  period_id: z.coerce.number().int().positive(),
  revaluation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "revaluation_date 需要 YYYY-MM-DD"),
  currency: z.string().trim().min(1).max(10).optional(),
  idempotency_key: z.string().uuid().optional(),
});

const reverseRevaluationSchema = baseQuerySchema.extend({
  revaluation_id: z.coerce.number().int().positive(),
  idempotency_key: z.string().uuid().optional(),
});

const runSettlementSchema = baseQuerySchema.extend({
  settlement_type: z.enum(["receivable", "payable"]),
  source_id: z.coerce.number().int().positive(),
  period_id: z.coerce.number().int().positive(),
  amount: z.coerce.number().positive(),
  settlement_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** 核销汇率（1 外币 = N 本位币）。不传则由数据库按核销日即期汇率取 */
  settlement_rate: z.coerce.number().positive().optional(),
  remark: z.string().max(500).optional(),
  idempotency_key: z.string().uuid().optional(),
});

/** 校验财务角色（身份来自 JWT）。校验不过时直接写响应并返回 -1。 */
async function requireFinanceActor(
  res: import("express").Response,
  identity: RequestIdentity,
): Promise<number> {
  const allowed = await userHasRole(identity.userId, FINANCE_ROLES);
  if (!allowed) {
    res.status(403).json({
      ok: false,
      error:
        "当前用户没有执行财务动作的角色（需要 super_admin / tenant_admin / finance_manager）。",
    });
    return -1;
  }
  return identity.tenantId;
}

/** 把数据库抛出的错误码映射成合适的 HTTP 状态码 */
function statusForDbError(message: string): number {
  // 已调汇 / 重复幂等键
  if (/already has an active FX revaluation/i.test(message)) return 409;
  // 期间锁定、已关闭、未启用
  if (/Accounting period is (locked|closed|not enabled)/i.test(message)) return 409;
  // 缺汇率、缺科目、期间不存在
  if (/No effective exchange rate|are required|does not exist/i.test(message)) return 422;
  // 跨租户（deploy_73/74 的 42501）
  if (/belongs to tenant|is not allowed to act on tenant/i.test(message)) return 403;
  if (/Settlement amount exceeds outstanding balance|is not balanced|must be positive/i.test(message))
    return 422;
  return 500;
}

function handleError(res: import("express").Response, scope: string, err: unknown): void {
  if (err instanceof TenantScopeError) {
    res.status(403).json({ ok: false, error: err.message });
    return;
  }
  // ⚠️ 必须走 extractErrorMessage：数据库 RAISE 经 PostgREST 抛出的是**普通对象**，
  // 直接 String(err) 会得到 "[object Object]" 且状态码全部退化成 500
  const message = extractErrorMessage(err);
  const status = statusForDbError(message);
  if (status >= 500) console.error(`[ai-server] ${scope} failed:`, err);
  res.status(status).json({ ok: false, error: message });
}

/* ------------------------------------------------------------------ *
 * 读：外币未核销余额（调汇前的体检表）
 * ------------------------------------------------------------------ */
financeRouter.get("/fx-open", async (req, res) => {
  const parsed = baseQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const actor = await requireFinanceActor(res, getIdentity(req));
    if (actor < 0) return;

    const { data, error } = await supabase
      .from(FX_OPEN_VIEW)
      .select("*")
      .eq("tenant_id", actor)
      .order("due_date", { ascending: true });

    if (error) throw error;
    res.json({ ok: true, tenant_id: actor, rows: data ?? [] });
  } catch (err) {
    handleError(res, "fx open list", err);
  }
});

/* ------------------------------------------------------------------ *
 * 读：调汇记录
 * ------------------------------------------------------------------ */
financeRouter.get("/fx-revaluation", async (req, res) => {
  const schema = baseQuerySchema.extend({
    period_id: z.coerce.number().int().positive().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const { period_id } = parsed.data;
    const actor = await requireFinanceActor(res, getIdentity(req));
    if (actor < 0) return;

    let query = supabase
      .from(FX_REVALUATION_TABLE)
      .select("*")
      .eq("tenant_id", actor)
      .eq("is_deleted", "n")
      .order("revaluation_date", { ascending: false });
    if (period_id !== undefined) query = query.eq("period_id", period_id);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, tenant_id: actor, rows: data ?? [] });
  } catch (err) {
    handleError(res, "fx revaluation list", err);
  }
});

/* ------------------------------------------------------------------ *
 * 写：执行期末调汇
 * ------------------------------------------------------------------ */
financeRouter.post("/fx-revaluation/run", async (req, res) => {
  const parsed = runRevaluationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const { period_id, revaluation_date, currency } = parsed.data;
    const identity = getIdentity(req);
    const actor = await requireFinanceActor(res, identity);
    if (actor < 0) return;

    const idempotencyKey = parsed.data.idempotency_key ?? randomUUID();

    const { data, error } = await supabase.rpc("service_run_fx_revaluation", {
      p_user_id: identity.userId,
      p_tenant_id: actor,
      p_period_id: period_id,
      p_revaluation_date: revaluation_date,
      p_idempotency_key: idempotencyKey,
      p_currency: currency ?? null,
    });
    if (error) throw error;

    res.json({ ok: true, idempotency_key: idempotencyKey, result: data });
  } catch (err) {
    handleError(res, "fx revaluation run", err);
  }
});

/* ------------------------------------------------------------------ *
 * 写：作废一次调汇
 * ------------------------------------------------------------------ */
financeRouter.post("/fx-revaluation/reverse", async (req, res) => {
  const parsed = reverseRevaluationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const { revaluation_id } = parsed.data;
    const identity = getIdentity(req);
    const actor = await requireFinanceActor(res, identity);
    if (actor < 0) return;

    const idempotencyKey = parsed.data.idempotency_key ?? randomUUID();

    const { data, error } = await supabase.rpc("service_reverse_fx_revaluation", {
      p_user_id: identity.userId,
      p_tenant_id: actor,
      p_revaluation_id: revaluation_id,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;

    res.json({ ok: true, idempotency_key: idempotencyKey, result: data });
  } catch (err) {
    handleError(res, "fx revaluation reverse", err);
  }
});

/* ------------------------------------------------------------------ *
 * 写：往来核销（带核销汇率 → 产生汇兑损益）
 * ------------------------------------------------------------------ */
financeRouter.post("/settlement/run", async (req, res) => {
  const parsed = runSettlementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const { settlement_type, source_id, period_id, amount } = parsed.data;
    const identity = getIdentity(req);
    const actor = await requireFinanceActor(res, identity);
    if (actor < 0) return;

    const idempotencyKey = parsed.data.idempotency_key ?? randomUUID();

    const { data, error } = await supabase.rpc("service_settle_ar_ap", {
      p_user_id: identity.userId,
      p_tenant_id: actor,
      p_settlement_type: settlement_type,
      p_source_id: source_id,
      p_period_id: period_id,
      p_amount: amount,
      p_settlement_date: parsed.data.settlement_date ?? null,
      p_remark: parsed.data.remark ?? null,
      p_idempotency_key: idempotencyKey,
      p_settlement_rate: parsed.data.settlement_rate ?? null,
    });
    if (error) throw error;

    res.json({ ok: true, idempotency_key: idempotencyKey, result: data });
  } catch (err) {
    handleError(res, "settlement run", err);
  }
});

/* ------------------------------------------------------------------ *
 * 读：可选会计期间（前端/调用方拿 period_id 用）
 * ------------------------------------------------------------------ */
financeRouter.get("/periods", async (req, res) => {
  const schema = baseQuerySchema.extend({
    year: z.coerce.number().int().min(1900).max(2999).optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }
  try {
    const { year } = parsed.data;
    const actor = await requireFinanceActor(res, getIdentity(req));
    if (actor < 0) return;

    let query = supabase
      .from("erp_accounting_periods_s_539dcf81_b")
      .select("id, year, month, start_date, end_date, is_enabled, is_locked, is_closed")
      .eq("tenant_id", actor)
      .eq("is_deleted", "n")
      .order("year", { ascending: false })
      .order("month", { ascending: false });
    if (year !== undefined) query = query.eq("year", year);

    const { data, error } = await query;
    if (error) throw error;
    res.json({ ok: true, tenant_id: actor, rows: data ?? [] });
  } catch (err) {
    handleError(res, "periods list", err);
  }
});
