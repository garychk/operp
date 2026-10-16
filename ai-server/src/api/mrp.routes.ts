/**
 * MRP 运算 HTTP 路由。
 *
 * ⚠️ 这是 ai-server 里第一个「写业务数据」的端点，鉴权最严格一档：
 * - 全部端点过 requireAuth：身份链路 Supabase JWT → sys_users.auth_id → 租户解析，
 *   body/query 明文 user_id 只做一致性校验（不符直接 403），绝不作为身份来源。
 * - 允许角色：super_admin / tenant_admin / mrp_manager（白名单写在 MRP_RUN_ROLES），
 *   角色核实一律用 JWT 解析出的 identity.userId 查 sys_user_roles。
 * - 租户互斥：同一租户同一时刻只允许一个 running 计划（mrpService.tryAcquirePlan）。
 *
 * 阶段 4 追加两个写端点：/convert（计划转单）、/cost-rollup（成本卷算）+ /cost（只读查询）。
 */
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { generateMrpReport } from "../services/mrpAdvisor.js";
import { runMrpForPlan, saveAnalysisReport } from "../services/mrpService.js";
import {
  buildConversionPreview,
  convertPlanToDocuments,
  type ConversionFilter,
} from "../services/mrpConvertService.js";
import { loadCostRows, rollupProductionCost } from "../services/costRollupService.js";
import { userHasRole } from "../services/roleGuard.js";
import { extractErrorMessage } from "../services/errors.js";
import { getIdentity, requireAuth } from "../services/authGuard.js";
import { heavyActionRateLimit } from "../services/rateLimit.js";

export const mrpRouter = Router();

// 所有端点（含只读 /cost、/report）都要登录：租户上下文由中间件统一解析
mrpRouter.use(requireAuth);

// MRP 运算 / 转单 / 成本卷算是重操作（含 LLM 报告生成 / 批量建单），按用户限流
mrpRouter.use("/run", heavyActionRateLimit);
mrpRouter.use("/convert", heavyActionRateLimit);
mrpRouter.use("/cost-rollup", heavyActionRateLimit);

const MRP_RUN_ROLES = new Set(["super_admin", "tenant_admin", "mrp_manager"]);
/** 成本卷算同样限制在计划角色内（成本表对 mrp_manager 只授了只读，写入由 service_role 完成） */
const COST_ROLLUP_ROLES = MRP_RUN_ROLES;

// user_id/tenant_id 仅为兼容旧客户端保留：requireAuth 已核过一致性，处理逻辑一律用 identity
const runSchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  tenant_id: z.coerce.number().int().positive().optional(),
  plan_id: z.coerce.number().int().positive(),
});

const convertSchema = runSchema.extend({
  mode: z.enum(["preview", "apply"]).default("preview"),
  filter: z.enum(["all", "purchased", "manufactured"]).default("all"),
});

const costSchema = z.object({
  user_id: z.coerce.number().int().positive().optional(),
  tenant_id: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(1900).max(2999),
  month: z.coerce.number().int().min(1).max(12),
  dry_run: z.coerce.boolean().optional().default(false),
});

/** 409：状态冲突（并发/重复运行/未完成运算就想转单） */
const isConflict = (message: string) => /不允许运算|正在进行|尚未完成运算/.test(message);

mrpRouter.post("/run", async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { plan_id } = parsed.data;
    const identity = getIdentity(req);

    // 角色核实（与租户解析分离：有租户不代表能跑 MRP），身份一律用 JWT 解析值
    const allowed = await userHasRole(identity.userId, MRP_RUN_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有运行 MRP 运算的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    // 运算（内部含计划状态锁：仅 draft/failed 可跑，running 互斥）
    const { plan, result } = await runMrpForPlan(identity.tenantId, plan_id);

    // LLM 报告（generateMrpReport 内部捕获一切异常，失败回退确定性摘要，不影响运算结果）
    const reportOutcome = await generateMrpReport(plan, result);
    // 结构化 stats 随报告一起落库（deploy_127），历史报告回看也能画图
    await saveAnalysisReport(identity.tenantId, plan_id, reportOutcome.report, result.stats);

    res.json({
      ok: true,
      plan_id: plan.id,
      plan_no: plan.plan_no,
      status: "completed",
      stats: result.stats,
      warnings: result.warnings,
      report: reportOutcome.report,
      report_generated_by: reportOutcome.generatedBy,
      report_error: reportOutcome.llmError ?? null,
    });
  } catch (err) {
    const message = extractErrorMessage(err);
    // 计划状态不允许（并发/重复运行）属于请求冲突，不是服务端故障
    if (isConflict(message)) {
      res.status(409).json({ ok: false, error: message });
      return;
    }
    console.error("[ai-server] MRP run failed:", err);
    res.status(500).json({ ok: false, error: message });
  }
});

/**
 * 计划转单：把 MRP 计划订单落成采购订单草稿 / 生产订单。
 * mode=preview 只回候选清单（不写任何单据），mode=apply 才真正建单。
 */
mrpRouter.post("/convert", async (req, res) => {
  const parsed = convertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { plan_id, mode, filter } = parsed.data;
    const identity = getIdentity(req);

    const allowed = await userHasRole(identity.userId, MRP_RUN_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有执行计划转单的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    if (mode === "preview") {
      const preview = await buildConversionPreview(
        identity.tenantId,
        plan_id,
        filter as ConversionFilter,
      );
      res.json({
        ok: true,
        mode: "preview",
        plan_id: preview.plan.id,
        plan_no: preview.plan.plan_no,
        summary: preview.summary,
        candidates: preview.candidates,
        skipped: preview.skipped,
      });
      return;
    }

    const outcome = await convertPlanToDocuments(
      identity.tenantId,
      plan_id,
      identity.userId,
      filter as ConversionFilter,
    );
    res.json({
      ok: true,
      mode: "apply",
      plan_id: outcome.plan.id,
      plan_no: outcome.plan.plan_no,
      created: outcome.created,
      failed: outcome.failed,
      notified: outcome.notified,
      items: outcome.items,
      skipped: outcome.skipped,
    });
  } catch (err) {
    const message = extractErrorMessage(err);
    if (isConflict(message)) {
      res.status(409).json({ ok: false, error: message });
      return;
    }
    console.error("[ai-server] MRP convert failed:", err);
    res.status(500).json({ ok: false, error: message });
  }
});

/** 成本卷算：dry_run=true 只算不写 */
mrpRouter.post("/cost-rollup", async (req, res) => {
  const parsed = costSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { year, month, dry_run } = parsed.data;
    const identity = getIdentity(req);

    const allowed = await userHasRole(identity.userId, COST_ROLLUP_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有执行成本卷算的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const outcome = await rollupProductionCost(identity.tenantId, year, month, { dryRun: dry_run });
    res.json({ ok: true, ...outcome });
  } catch (err) {
    console.error("[ai-server] cost rollup failed:", err);
    res.status(500).json({ ok: false, error: extractErrorMessage(err) });
  }
});

/** 读取已保存的成本行（成本页列表，只读） */
mrpRouter.get("/cost", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const identity = getIdentity(req);
    const { periodId, rows } = await loadCostRows(identity.tenantId, year, month);
    res.json({ ok: true, year, month, period_id: periodId, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: extractErrorMessage(err) });
  }
});

/** 读取已保存的分析报告（计划详情页展示用） */
mrpRouter.get("/report/:planId", async (req, res) => {
  const planId = Number(req.params.planId);

  if (!Number.isInteger(planId) || planId <= 0) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const identity = getIdentity(req);
    const { data, error } = await supabase
      .from("erp_mrp_plans_s_539dcf81_b")
      .select("analysis_report, analysis_stats, plan_no")
      .eq("id", planId)
      .eq("tenant_id", identity.tenantId)
      .eq("is_deleted", "n")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      res.status(404).json({ ok: false, error: "计划不存在或不属于当前租户。" });
      return;
    }
    res.json({
      ok: true,
      plan_no: data.plan_no,
      report: data.analysis_report,
      stats: data.analysis_stats ?? null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: extractErrorMessage(err) });
  }
});
