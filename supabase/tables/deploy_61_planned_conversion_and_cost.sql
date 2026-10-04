-- ============================================================
-- 阶段 4 · 计划转单追踪 + 成本卷算前置（deploy_61）
--
-- 交付两件事：
--   1) MRP 计划订单（erp_mrp_requirements 的 planned_order_receipt 行）
--      转成下游单据后，把「转成了哪张单」记回计划行 —— 转单追踪 + 防重复转单。
--   2) 成本卷算（erp_cost_calculations）按「期间 × 产品」幂等 upsert 的唯一索引。
--
-- 设计取舍（刻意如此）：
--   · 追踪列放在 erp_mrp_requirements 上，不新建关联表：计划行本身就是计划订单，
--     一对一最直接，且页面上能直接显示「已转单 PO...」。
--   · ⚠️ 因此 ai-server 的 persistResult 必须改成「只删未转单的行」——
--     否则重跑 MRP 会把已转单的行的追踪列一起抹掉，下次转单就会重复下单。
--   · 部分唯一索引 = 同一计划内「同一物料同一天」只能转一次单（并发/重复点击的兜底）。
--
-- 注：脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================

-- ------------------------------------------------------------
-- 1) erp_mrp_requirements：转单追踪
-- ------------------------------------------------------------
ALTER TABLE public.erp_mrp_requirements_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS converted_document_type VARCHAR(30),
  ADD COLUMN IF NOT EXISTS converted_document_id   INTEGER,
  ADD COLUMN IF NOT EXISTS converted_document_no   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS converted_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS converted_by_user_id    INTEGER;

COMMENT ON COLUMN public.erp_mrp_requirements_s_539dcf81_b.converted_document_type IS
  '转单去向：purchase_order / production_order；NULL = 尚未转单';
COMMENT ON COLUMN public.erp_mrp_requirements_s_539dcf81_b.converted_document_id IS
  '转单生成的单据 id（按 converted_document_type 指向不同表）';
COMMENT ON COLUMN public.erp_mrp_requirements_s_539dcf81_b.converted_document_no IS
  '转单生成的单据号（冗余展示，避免页面跨表 join）';
COMMENT ON COLUMN public.erp_mrp_requirements_s_539dcf81_b.converted_by_user_id IS
  '发起转单的 sys_users.id（审计用；服务端写入时不信任 body 自称，用核实过的 user_id）';

-- 防重复转单：同一计划内同一物料同一天的已转单行只允许存在一条
CREATE UNIQUE INDEX IF NOT EXISTS uq_mrp_requirements_converted
  ON public.erp_mrp_requirements_s_539dcf81_b (plan_id, product_id, requirement_date)
  WHERE is_deleted = 'n' AND converted_document_id IS NOT NULL;

-- 按下游单据反查来源计划行（撤销单据时要回滚追踪）
CREATE INDEX IF NOT EXISTS idx_mrp_requirements_converted_doc
  ON public.erp_mrp_requirements_s_539dcf81_b (converted_document_type, converted_document_id)
  WHERE converted_document_id IS NOT NULL;

-- ------------------------------------------------------------
-- 2) erp_cost_calculations：期间 × 产品 幂等键（成本卷算 upsert 用）
--    该表此前是死表（0 行），加唯一索引无历史数据冲突
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_calculations_period_product
  ON public.erp_cost_calculations_s_539dcf81_b (tenant_id, period_id, product_id)
  WHERE is_deleted = 'n';

CREATE INDEX IF NOT EXISTS idx_cost_calculations_period
  ON public.erp_cost_calculations_s_539dcf81_b (tenant_id, period_id)
  WHERE is_deleted = 'n';

-- ------------------------------------------------------------
-- 3) 报工单 DocType（报工页取号用 RPT{YYYY}{####}）
--    报工不产生库存流水 → 不需要 sys_document_transaction_types 映射
-- ------------------------------------------------------------
INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order, status)
VALUES
  ('production_report', '报工单', 'mrp', '/mrp/production-reports',
   'erp_production_reports_s_539dcf81_b', 'RPT{YYYY}{####}', 66, '1')
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code   = EXCLUDED.module_code,
  route_path    = EXCLUDED.route_path,
  table_name    = EXCLUDED.table_name,
  naming_rule   = EXCLUDED.naming_rule,
  sort_order    = EXCLUDED.sort_order,
  updated_at    = NOW();

-- ------------------------------------------------------------
-- 4) 自检：缺任何一项直接报错（不静默）
-- ------------------------------------------------------------
DO $$
DECLARE
  v_missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'erp_mrp_requirements_s_539dcf81_b'
      AND column_name = 'converted_document_id'
  ) THEN
    v_missing := v_missing || 'erp_mrp_requirements.converted_document_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'erp_mrp_requirements_s_539dcf81_b'
      AND column_name = 'converted_by_user_id'
  ) THEN
    v_missing := v_missing || 'erp_mrp_requirements.converted_by_user_id';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_mrp_requirements_converted'
  ) THEN
    v_missing := v_missing || 'index uq_mrp_requirements_converted';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'uq_cost_calculations_period_product'
  ) THEN
    v_missing := v_missing || 'index uq_cost_calculations_period_product';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sys_document_types
    WHERE document_type = 'production_report' AND naming_rule = 'RPT{YYYY}{####}'
  ) THEN
    v_missing := v_missing || 'sys_document_types.production_report';
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'deploy_61 自检失败，缺少: %', array_to_string(v_missing, ', ');
  END IF;

  RAISE NOTICE 'deploy_61 OK: 转单追踪列 + 成本幂等索引 + 报工单 DocType 已就绪';
END $$;
