/**
 * MRP 运算 HTTP 路由。
 *
 * ⚠️ 这是 ai-server 里第一个「写业务数据」的端点，鉴权比 chat/知识库严格一档：
 * - 请求体明文 user_id/tenant_id 只用来「找到人」，权限必须在服务端查角色表核实，
 *   绝不信任请求方自称的角色。
 * - 允许角色：super_admin / tenant_admin / mrp_manager（白名单写在 MRP_RUN_ROLES）。
 * - 租户互斥：同一租户同一时刻只允许一个 running 计划（mrpService.tryAcquirePlan）。
 *
 * 阶段 4 追加两个写端点：/convert（计划转单）、/cost-rollup（成本卷算）+ /cost（只读查询）。
 */
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { resolveTenantContext, TenantScopeError } from "../config/tenantContext.js";
import { generateMrpReport } from "../services/mrpAdvisor.js";
import { runMrpForPlan, saveAnalysisReport } from "../services/mrpService.js";
import {
  buildConversionPreview,
  convertPlanToDocuments,
  type ConversionFilter,
} from "../services/mrpConvertService.js";
import { loadCostRows, rollupProductionCost } from "../services/costRollupService.js";

export const mrpRouter = Router();

const MRP_RUN_ROLES = new Set(["super_admin", "tenant_admin", "mrp_manager"]);
/** 成本卷算同样限制在计划角色内（成本表对 mrp_manager 只授了只读，写入由 service_role 完成） */
const COST_ROLLUP_ROLES = MRP_RUN_ROLES;

const runSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  tenant_id: z.coerce.number().int().positive().optional(),
  plan_id: z.coerce.number().int().positive(),
});

const convertSchema = runSchema.extend({
  mode: z.enum(["preview", "apply"]).default("preview"),
  filter: z.enum(["all", "purchased", "manufactured"]).default("all"),
});

const costSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  tenant_id: z.coerce.number().int().positive().optional(),
  year: z.coerce.number().int().min(1900).max(2999),
  month: z.coerce.number().int().min(1).max(12),
  dry_run: z.coerce.boolean().optional().default(false),
});

/** 服务端核实用户是否持有允许运行 MRP 的角色（不信任请求体的任何自称） */
async function userHasRole(userId: number, allowed: Set<string>): Promise<boolean> {
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

/** 409：状态冲突（并发/重复运行/未完成运算就想转单） */
const isConflict = (message: string) => /不允许运算|正在进行|尚未完成运算/.test(message);

mrpRouter.post("/run", async (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid request", issues: parsed.error.issues });
    return;
  }

  try {
    const { user_id, tenant_id, plan_id } = parsed.data;

    // 1. 租户上下文（fail-closed：解析不出就 403）
    const context = await resolveTenantContext(user_id, tenant_id);

    // 2. 角色核实（与租户解析分离：有租户不代表能跑 MRP）
    const allowed = await userHasRole(user_id, MRP_RUN_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有运行 MRP 运算的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    // 3. 运算（内部含计划状态锁：仅 draft/failed 可跑，running 互斥）
    const { plan, result } = await runMrpForPlan(context.tenantId, plan_id);

    // 4. LLM 报告（generateMrpReport 内部捕获一切异常，失败回退确定性摘要，不影响运算结果）
    const reportOutcome = await generateMrpReport(plan, result);
    await saveAnalysisReport(context.tenantId, plan_id, reportOutcome.report);

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
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
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
    const { user_id, tenant_id, plan_id, mode, filter } = parsed.data;
    const context = await resolveTenantContext(user_id, tenant_id);

    const allowed = await userHasRole(user_id, MRP_RUN_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有执行计划转单的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    if (mode === "preview") {
      const preview = await buildConversionPreview(
        context.tenantId,
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
      context.tenantId,
      plan_id,
      user_id,
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
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
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
    const { user_id, tenant_id, year, month, dry_run } = parsed.data;
    const context = await resolveTenantContext(user_id, tenant_id);

    const allowed = await userHasRole(user_id, COST_ROLLUP_ROLES);
    if (!allowed) {
      res.status(403).json({
        ok: false,
        error: "当前用户没有执行成本卷算的角色（需要 super_admin / tenant_admin / mrp_manager）。",
      });
      return;
    }

    const outcome = await rollupProductionCost(context.tenantId, year, month, { dryRun: dry_run });
    res.json({ ok: true, ...outcome });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    console.error("[ai-server] cost rollup failed:", err);
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** 读取已保存的成本行（成本页列表，只读） */
mrpRouter.get("/cost", async (req, res) => {
  const userId = Number(req.query.user_id);
  const tenantId = req.query.tenant_id === undefined ? undefined : Number(req.query.tenant_id);
  const year = Number(req.query.year);
  const month = Number(req.query.month);

  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const context = await resolveTenantContext(userId, tenantId);
    const { periodId, rows } = await loadCostRows(context.tenantId, year, month);
    res.json({ ok: true, year, month, period_id: periodId, rows });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** 读取已保存的分析报告（计划详情页展示用） */
mrpRouter.get("/report/:planId", async (req, res) => {
  const userId = Number(req.query.user_id);
  const tenantId = req.query.tenant_id === undefined ? undefined : Number(req.query.tenant_id);
  const planId = Number(req.params.planId);

  if (!Number.isInteger(planId) || planId <= 0 || !Number.isInteger(userId)) {
    res.status(400).json({ ok: false, error: "Invalid request" });
    return;
  }

  try {
    const context = await resolveTenantContext(userId, tenantId);
    const { data, error } = await supabase
      .from("erp_mrp_plans_s_539dcf81_b")
      .select("analysis_report, plan_no")
      .eq("id", planId)
      .eq("tenant_id", context.tenantId)
      .eq("is_deleted", "n")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      res.status(404).json({ ok: false, error: "计划不存在或不属于当前租户。" });
      return;
    }
    res.json({ ok: true, plan_no: data.plan_no, report: data.analysis_report });
  } catch (err) {
    if (err instanceof TenantScopeError) {
      res.status(403).json({ ok: false, error: err.message });
      return;
    }
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
