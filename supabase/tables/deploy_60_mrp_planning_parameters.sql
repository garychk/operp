-- =====================================================================
-- deploy_60_mrp_planning_parameters.sql
-- 阶段 3（P1）MRP 运算引擎 · 前置计划参数字段
--
-- 纯增量 DDL：只加列 / 加索引 / 加约束，不改既有数据、不建新表，
-- 因此不需要补基线授权、不需要重跑 clone（无新表）。
-- ⚠️ 执行器用 psql --single-transaction，本文件不得包含 BEGIN;/COMMIT;
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. erp_products · 计划参数（MRP 运算的逐物料输入）
--    is_mrp_relevant 刻意可空：NULL 时引擎回退到 is_purchased OR is_manufactured，
--    避免存量物料因 NOT NULL DEFAULT false 被整体排除在计划之外。
-- ---------------------------------------------------------------------
ALTER TABLE public.erp_products_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS lead_time_purchase  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_time_production numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lot_policy          varchar(20) NOT NULL DEFAULT 'lot_for_lot',
  ADD COLUMN IF NOT EXISTS min_order_qty       numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_multiple      numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_point         numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_mrp_relevant     boolean;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'erp_products_lot_policy_check'
      AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_products_s_539dcf81_b
      ADD CONSTRAINT erp_products_lot_policy_check
      CHECK (lot_policy IN ('lot_for_lot', 'fixed_qty', 'multiples', 'max_qty'));
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. erp_boms · 虚幻件标记（虚幻件的毛需求不落自身，直接穿透到子件）
-- ---------------------------------------------------------------------
ALTER TABLE public.erp_boms_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS is_phantom boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------
-- 3. erp_warehouses · 是否参与 MRP（默认参与，存量仓库不受影响）
-- ---------------------------------------------------------------------
ALTER TABLE public.erp_warehouses_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS is_mrp_participating boolean NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------
-- 4. erp_mrp_plans · 运算后由 LLM 生成的分析报告（引擎失败时回退确定性摘要）
-- ---------------------------------------------------------------------
ALTER TABLE public.erp_mrp_plans_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS analysis_report text;

-- ---------------------------------------------------------------------
-- 5. 供给/需求源的取数索引（按物料聚合是引擎的主访问路径）
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_order_details_product
  ON public.erp_sales_order_details_s_539dcf81_b (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_details_product
  ON public.erp_purchase_order_details_s_539dcf81_b (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_production_order_details_material
  ON public.erp_production_order_details_s_539dcf81_b (tenant_id, material_id);
CREATE INDEX IF NOT EXISTS idx_bom_details_material
  ON public.erp_bom_details_s_539dcf81_b (tenant_id, material_id);
CREATE INDEX IF NOT EXISTS idx_production_orders_product
  ON public.erp_production_orders_s_539dcf81_b (tenant_id, product_id);
CREATE INDEX IF NOT EXISTS idx_mrp_requirements_plan_product
  ON public.erp_mrp_requirements_s_539dcf81_b (plan_id, product_id);

-- ---------------------------------------------------------------------
-- 6. 自检：缺任一列直接报错，绝不静默半成品
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(missing_col, ', ') INTO v_missing
  FROM (
    SELECT u.col AS missing_col
    FROM unnest(ARRAY[
      'erp_products_s_539dcf81_b.lead_time_purchase',
      'erp_products_s_539dcf81_b.lead_time_production',
      'erp_products_s_539dcf81_b.lot_policy',
      'erp_products_s_539dcf81_b.min_order_qty',
      'erp_products_s_539dcf81_b.order_multiple',
      'erp_products_s_539dcf81_b.order_point',
      'erp_products_s_539dcf81_b.is_mrp_relevant',
      'erp_boms_s_539dcf81_b.is_phantom',
      'erp_warehouses_s_539dcf81_b.is_mrp_participating',
      'erp_mrp_plans_s_539dcf81_b.analysis_report'
    ]) AS u(col)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name || '.' || c.column_name = u.col
    )
  ) s;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_60 自检失败，缺少列: %', v_missing;
  END IF;

  RAISE NOTICE 'deploy_60 OK: MRP 计划参数字段已就绪';
END $$;
