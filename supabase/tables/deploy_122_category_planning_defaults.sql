-- ============================================================================
-- deploy_122：计划参数「跟随类别默认」+ 默认供应商
-- ============================================================================
--
-- 背景：计划参数列（deploy_60/114）只能逐物料维护，新物料每条都要手填一遍
-- 提前期 / 批量规则。本次把「跟随」语义铺开到全部计划参数字段：
--
--   取值链：物料显式值（非 NULL）→ 类别默认（erp_product_categories 同名列）
--          → 现状默认（0 / lot_for_lot / 跟随物料属性）
--
-- 设计要点：
--   1. 不建新表。类别默认参数直接作为 erp_product_categories 的可空列 ——
--      与物料同名同类型，引擎按 category_id 取行即可，「跟随」= 物料列 NULL。
--   2. erp_products 的 7 个计划参数列去 NOT NULL、去 DEFAULT：
--      NULL = 跟随类别默认（显式 0 仍是显式 0，语义可区分）。
--      safety_stock / min_stock / max_stock 建表时即可空（deploy_01），
--      deploy_31 / deploy_99 也已 COALESCE，无需动。
--      ⚠️ deploy_114 自检断言 max_order_qty NOT NULL —— 仅影响「单独重跑 114」
--      的场景；全量从零跑库顺序为 114 → 120，自检在 114 时仍成立。
--   3. default_supplier_id 用普通 FK（erp_suppliers.id 是全局唯一 PK，与
--      erp_purchase_orders.supplier_id 同一先例）；租户正确性由写入方保证
--      （前端只列本租户供应商，ai-server 转单时显式校验本租户 + 启用）。
--   4. 纯增量 DDL：无新表、无 RLS 变更（erp_product_categories 既有表级
--      策略覆盖新列）、无菜单登记。执行后 NOTIFY pgrst 刷新 schema 缓存。
--
-- ⚠️ 执行器用 psql --single-transaction，本文件不得包含 BEGIN;/COMMIT;
-- 依赖：deploy_01（erp_products / erp_suppliers / erp_product_categories）、
--       deploy_60、deploy_114（计划参数列）。
-- ============================================================================


-- ============================================================================
-- 1. erp_products：计划参数列可空化（NULL = 跟随类别默认）
-- ============================================================================
ALTER TABLE public.erp_products_s_539dcf81_b
  ALTER COLUMN order_point         DROP NOT NULL,
  ALTER COLUMN lot_policy          DROP NOT NULL,
  ALTER COLUMN min_order_qty       DROP NOT NULL,
  ALTER COLUMN order_multiple      DROP NOT NULL,
  ALTER COLUMN max_order_qty       DROP NOT NULL,
  ALTER COLUMN lead_time_purchase  DROP NOT NULL,
  ALTER COLUMN lead_time_production DROP NOT NULL;

-- 去掉 DEFAULT：插入时省略列 = NULL = 跟随类别，而不是静默写 0（显式值）
ALTER TABLE public.erp_products_s_539dcf81_b
  ALTER COLUMN order_point         DROP DEFAULT,
  ALTER COLUMN lot_policy          DROP DEFAULT,
  ALTER COLUMN min_order_qty       DROP DEFAULT,
  ALTER COLUMN order_multiple      DROP DEFAULT,
  ALTER COLUMN max_order_qty       DROP DEFAULT,
  ALTER COLUMN lead_time_purchase  DROP DEFAULT,
  ALTER COLUMN lead_time_production DROP DEFAULT;

-- ⚠️ lot_policy CHECK 对 NULL 放行（SQL 标准），无需改动。
-- max_order_qty >= 0 / order_point >= 0 的 CHECK 同理对 NULL 放行。

COMMENT ON COLUMN public.erp_products_s_539dcf81_b.lot_policy IS
  '批量规则；NULL = 跟随类别默认（erp_product_categories.lot_policy），两端皆空时引擎回退 lot_for_lot。';
COMMENT ON COLUMN public.erp_products_s_539dcf81_b.order_point IS
  '订货点；NULL = 跟随类别默认，两端皆空按 0（不启用订货点补货）。';


-- ============================================================================
-- 2. erp_products.default_supplier_id（采购建议单的预填供应商）
-- ============================================================================
ALTER TABLE public.erp_products_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS default_supplier_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_erp_products_default_supplier'
      AND conrelid = 'public.erp_products_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_products_s_539dcf81_b
      ADD CONSTRAINT fk_erp_products_default_supplier
      FOREIGN KEY (default_supplier_id)
      REFERENCES public.erp_suppliers_s_539dcf81_b (id);
  END IF;
END $$;

COMMENT ON COLUMN public.erp_products_s_539dcf81_b.default_supplier_id IS
  '默认供应商；NULL = 跟随类别默认（erp_product_categories.default_supplier_id）。MRP 转采购建议单时回填，供应商停用/删除则留空并告警。';


-- ============================================================================
-- 3. erp_product_categories：类别默认参数列（全可空，NULL = 该层级未设置）
-- ============================================================================
ALTER TABLE public.erp_product_categories_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS safety_stock        NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS min_stock           NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS max_stock           NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS order_point         NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS min_order_qty       NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS order_multiple      NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS max_order_qty       NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS lead_time_purchase  NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS lead_time_production NUMERIC(18, 6),
  ADD COLUMN IF NOT EXISTS lot_policy          VARCHAR(20),
  ADD COLUMN IF NOT EXISTS default_supplier_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ck_erp_product_categories_lot_policy'
      AND conrelid = 'public.erp_product_categories_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_product_categories_s_539dcf81_b
      ADD CONSTRAINT ck_erp_product_categories_lot_policy
      CHECK (lot_policy IN ('lot_for_lot', 'fixed_qty', 'multiples', 'max_qty'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_erp_product_categories_default_supplier'
      AND conrelid = 'public.erp_product_categories_s_539dcf81_b'::regclass
  ) THEN
    ALTER TABLE public.erp_product_categories_s_539dcf81_b
      ADD CONSTRAINT fk_erp_product_categories_default_supplier
      FOREIGN KEY (default_supplier_id)
      REFERENCES public.erp_suppliers_s_539dcf81_b (id);
  END IF;
END $$;

COMMENT ON COLUMN public.erp_product_categories_s_539dcf81_b.lot_policy IS
  '类别默认批量规则；NULL = 未设置，由物料显式值或引擎默认（lot_for_lot）兜底。';
COMMENT ON COLUMN public.erp_product_categories_s_539dcf81_b.default_supplier_id IS
  '类别默认供应商；NULL = 未设置，由物料显式值兜底。';


-- ============================================================================
-- 4. 自检：缺任一列 / 可空化未生效直接报错，绝不静默半成品
-- ============================================================================
DO $$
DECLARE
  v_missing text;
BEGIN
  -- 4.1 列存在性
  SELECT string_agg(missing_col, ', ') INTO v_missing
  FROM (
    SELECT u.col AS missing_col
    FROM unnest(ARRAY[
      'erp_products_s_539dcf81_b.default_supplier_id',
      'erp_product_categories_s_539dcf81_b.safety_stock',
      'erp_product_categories_s_539dcf81_b.min_stock',
      'erp_product_categories_s_539dcf81_b.max_stock',
      'erp_product_categories_s_539dcf81_b.order_point',
      'erp_product_categories_s_539dcf81_b.min_order_qty',
      'erp_product_categories_s_539dcf81_b.order_multiple',
      'erp_product_categories_s_539dcf81_b.max_order_qty',
      'erp_product_categories_s_539dcf81_b.lead_time_purchase',
      'erp_product_categories_s_539dcf81_b.lead_time_production',
      'erp_product_categories_s_539dcf81_b.lot_policy',
      'erp_product_categories_s_539dcf81_b.default_supplier_id'
    ]) AS u(col)
    WHERE NOT EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name || '.' || c.column_name = u.col
    )
  ) s;

  -- 4.2 可空化生效（is_nullable = 'YES' 且 pg_get_expr(default) 为空）
  SELECT string_agg(bad_col, ', ') INTO v_missing
  FROM (
    SELECT u.col AS bad_col
    FROM unnest(ARRAY[
      'order_point', 'lot_policy', 'min_order_qty', 'order_multiple',
      'max_order_qty', 'lead_time_purchase', 'lead_time_production'
    ]) AS u(col)
    WHERE EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'erp_products_s_539dcf81_b'
        AND c.column_name = u.col
        AND (c.is_nullable <> 'YES' OR c.column_default IS NOT NULL)
    )
  ) s2;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_122 自检失败，问题列: %', v_missing;
  END IF;

  RAISE NOTICE 'deploy_122 OK：计划参数可空化 + 类别默认参数列 + default_supplier_id 已就绪';
END $$;

-- PostgREST schema 缓存刷新（新列经 REST 可见）
NOTIFY pgrst, 'reload schema';
