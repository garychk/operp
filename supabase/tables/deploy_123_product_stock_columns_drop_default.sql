-- ============================================================================
-- deploy_123：库存水位三列的 DEFAULT 0 去掉（与 deploy_122 的「跟随」语义对齐）
-- ============================================================================
--
-- 背景：deploy_122 把 7 个计划参数列去掉了 NOT NULL + DEFAULT，让「省略该列 =
-- NULL = 跟随类别默认」成立。但 safety_stock / min_stock / max_stock 这三列是
-- deploy_01 建表时就带 `DEFAULT 0` 的，**省略插入会写成显式 0**，把类别默认值
-- 顶掉（探针实测：类别默认 safety_stock=7，物料留空插入后引擎取到 0）。
--
-- 影响面（已核对）：
--   · 物料编辑弹窗（Products.tsx）总是显式提交值/NULL，不受影响；
--   · deploy_31 通知 / deploy_99 库存查询视图均用 `IS NOT NULL AND ...`
--     或 COALESCE 判定，NULL 与 0 的差异仅体现在「on_hand <= 0 时是否告警」，
--     该边界（库存为负/零）本就由 min_stock>0 的物料覆盖；
--   · 其余插入物料的地方（AI 建档等）省略这三列时将得到 NULL = 跟随类别，
--     这正是本次要的语义。
--
-- ⚠️ 执行器用 psql --single-transaction，本文件不得包含 BEGIN;/COMMIT;
-- ============================================================================

ALTER TABLE public.erp_products_s_539dcf81_b
  ALTER COLUMN safety_stock DROP DEFAULT,
  ALTER COLUMN min_stock    DROP DEFAULT,
  ALTER COLUMN max_stock    DROP DEFAULT;

COMMENT ON COLUMN public.erp_products_s_539dcf81_b.safety_stock IS
  '安全库存；NULL = 跟随类别默认（erp_product_categories.safety_stock），两端皆空按 0。';
COMMENT ON COLUMN public.erp_products_s_539dcf81_b.min_stock IS
  '最低库存；NULL = 跟随类别默认，两端皆空按 0。';
COMMENT ON COLUMN public.erp_products_s_539dcf81_b.max_stock IS
  '最高库存；NULL = 跟随类别默认，两端皆空按 0。';

DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO v_bad
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'erp_products_s_539dcf81_b'
    AND column_name IN ('safety_stock', 'min_stock', 'max_stock')
    AND (is_nullable <> 'YES' OR column_default IS NOT NULL);

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'deploy_123 自检失败：% 仍带默认值或 NOT NULL', v_bad;
  END IF;

  RAISE NOTICE 'deploy_123 OK：库存水位三列已去掉 DEFAULT，省略插入 = NULL = 跟随类别默认';
END $$;

NOTIFY pgrst, 'reload schema';
