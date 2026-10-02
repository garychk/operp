/**
 * MRP 运算 HTTP 路由。
 *
 * ⚠️ 这是 ai-server 里第一个「写业务数据」的端点，鉴权比 chat/知识库严格一档：
 * - 请求体明文 user_id/tenant_id 只用来「找到人」，权限必须在服务端查角色表核实，
 *   绝不信任请求方自称的角色。
 * - 允许角色：super_admin / tenant_admin / mrp_manager（白名单写在 MRP_RUN_ROLES）。
 * - 租户互斥：同一租户同一时刻只允许一个 running 计划（mrpService.tryAcquirePlan）。
 */
import { Router } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase.js";
import { resolveTenantContext, TenantScopeError } from "../config/tenantContext.js";
import { generateMrpReport } from "../services/mrpAdvisor.js";
import { runMrpForPlan, saveAnalysisReport } from "../services/mrpService.js";

export const mrpRouter = Router();

const MRP_RUN_ROLES = new Set(["super_admin", "tenant_admin", "mrp_manager"]);

const runSchema = z.object({
  user_id: z.coerce.number().int().positive(),
  tenant_id: z.coerce.number().int().positive().optional(),
  plan_id: z.coerce.number().int().positive(),
});

/** 服务端核实用户是否持有允许运行 MRP 的角色（不信任请求体的任何自称） */
async function userHasMrpRole(userId: number): Promise<boolean> {
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
    return roleCode ? MRP_RUN_ROLES.has(roleCode) : false;
  });
}

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
    const allowed = await userHasMrpRole(user_id);
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
    if (/不允许运算|正在进行/.test(message)) {
      res.status(409).json({ ok: false, error: message });
      return;
    }
    console.error("[ai-server] MRP run failed:", err);
    res.status(500).json({ ok: false, error: message });
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
