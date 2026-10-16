-- ============================================================================
-- deploy_127_mrp_analysis_stats.sql — MRP 分析报告结构化统计落库
--
-- 背景：MRP 运算完成后，引擎输出的结构化 stats（缺口清单、汇总数字、警告）
-- 目前只喂给 LLM 生成文字报告，结果只落 analysis_report（text），stats 本身
-- 没有持久化 —— 历史报告「回看」时拿不到任何结构化数据，前端只能渲染纯文字。
-- 本次新增 analysis_stats（jsonb）把引擎 stats 一并落库，供前端报告弹窗画图
-- （汇总指标卡 + 缺口 Top 条形图 + 缺口日期趋势），文字报告保持不变。
--
-- 内容口径：与 mrpEngine.MrpEngineResult.stats 同构（含 shortages / warnings 由
-- 引擎 stats 内嵌，warnings 仍单独返回不落本列 —— 见 deploy_60 约定）。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

-- 1. 加列（幂等）
ALTER TABLE public.erp_mrp_plans_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS analysis_stats jsonb;

-- 2. 自检：缺列直接报错，绝不静默半成品
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(missing_col, ', ') INTO v_missing
  FROM (
    SELECT 'erp_mrp_plans_s_539dcf81_b.analysis_stats' AS missing_col
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'erp_mrp_plans_s_539dcf81_b'
        AND c.column_name = 'analysis_stats'
    )
  ) s;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_127 缺列：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_127 OK：erp_mrp_plans.analysis_stats 列已就绪';
END;
$$;
