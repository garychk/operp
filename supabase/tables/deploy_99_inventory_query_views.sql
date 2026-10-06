-- ============================================================================
-- deploy_99 —— P1-6 收尾：库存查询页的服务端视图（替代前端全表 JS 关联）
-- ============================================================================
--
-- 背景：`Inventory.tsx` 原来把 `erp_inventory` / `erp_products` / `erp_warehouses` /
--   `erp_bins` **四张表全量**拉到浏览器再做 JS 关联与求和。行数一多（几万行库存行
--   + 全量物料）首屏就会卡，而且"合计金额"是拿**当前页过滤结果**算的，与分页无关
--   却又是前端算的 —— 口径与性能都不可控。
--
-- 本迁移提供两个视图，把关联与聚合下沉到数据库：
--   ① vw_erp_inventory_stock_list    库存行 + 物料/仓库/库位名称 + 安全库存判定（逐行）
--   ② vw_erp_inventory_stock_totals  按仓库聚合的合计（行数/品种/数量/金额/呆滞数）
--
-- 设计约束（与 deploy_96 一致，务必保持）：
--   * **一律 `security_invoker = true`** —— 视图不提升权限，底层 erp_* 的 fail-closed
--     RLS 按调用者身份生效。忘了这一条，视图就是绕过租户隔离的后门。
--   * 只统计 `is_deleted = 'n'` 的库存行；被软删的物料/仓库/库位名称允许为 NULL，
--     前端按 "-" 展示即可（**不要 INNER JOIN**，否则历史行会整行消失）。
--   * 金额口径 = 本位币（`erp_inventory.total_cost` 在过账时已按移动加权落定）。
--
-- 口径说明：
--   * `is_low_stock` 只在 `stock_status = 'available'` 的行上判定 —— 待检/冻结/不合格
--     的货本来就不能发，报"低于安全库存"是噪音。判断依据 `available_quantity`
--     （available 行 = quantity - locked，非 available 行恒 0，见 deploy_93）。
--   * `vw_erp_inventory_stock_totals` 按 (租户, 仓库) 聚合，前端把这几行相加即为全局
--     合计。仓库行数量级是个位数到几十，跨网络求和无压力。
-- ============================================================================


-- ============================================================================
-- ① 库存行视图（库存查询主表）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_stock_list
  WITH (security_invoker = true) AS
SELECT i.tenant_id,
       i.id,
       i.product_id,
       p.code           AS product_code,
       p.name           AS product_name,
       p.specification,
       p.unit,
       p.safety_stock,
       p.max_stock,
       p.min_stock,
       i.warehouse_id,
       w.code           AS warehouse_code,
       w.name           AS warehouse_name,
       i.location_id,
       b.code           AS bin_code,
       b.name           AS bin_name,
       i.batch_no,
       i.expiry_date,
       i.stock_status,
       i.quantity,
       i.available_quantity,
       i.locked_quantity,
       i.unit_cost,
       i.total_cost,
       -- 呆滞/低库存标记：只有可发的 available 行才参与判定
       CASE
         WHEN p.safety_stock IS NOT NULL
          AND i.stock_status = 'available'
          AND COALESCE(i.available_quantity, 0) <= p.safety_stock
         THEN TRUE
         ELSE FALSE
       END              AS is_low_stock,
       i.created_at,
       i.updated_at
  FROM public.erp_inventory_s_539dcf81_b i
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = i.product_id  AND p.is_deleted = 'n'
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = i.warehouse_id AND w.is_deleted = 'n'
  LEFT JOIN public.erp_bins_s_539dcf81_b       b ON b.id = i.location_id  AND b.is_deleted = 'n'
 WHERE i.is_deleted = 'n';


-- ============================================================================
-- ② 按仓库聚合的合计视图（统计卡片）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_stock_totals
  WITH (security_invoker = true) AS
SELECT i.tenant_id,
       i.warehouse_id,
       w.name AS warehouse_name,
       COUNT(*)                                       AS row_count,
       COUNT(DISTINCT i.product_id)                   AS product_count,
       SUM(i.quantity)                                AS on_hand_quantity,
       SUM(COALESCE(i.available_quantity, 0))         AS available_quantity,
       SUM(COALESCE(i.locked_quantity, 0))            AS locked_quantity,
       SUM(CASE WHEN i.stock_status = 'inspection' THEN i.quantity ELSE 0 END) AS inspection_quantity,
       SUM(CASE WHEN i.stock_status = 'hold'       THEN i.quantity ELSE 0 END) AS hold_quantity,
       SUM(CASE WHEN i.stock_status = 'rejected'   THEN i.quantity ELSE 0 END) AS rejected_quantity,
       SUM(i.total_cost)                              AS total_cost,
       COUNT(*) FILTER (
         WHERE p.safety_stock IS NOT NULL
           AND i.stock_status = 'available'
           AND COALESCE(i.available_quantity, 0) <= p.safety_stock
       )                                              AS low_stock_count
  FROM public.erp_inventory_s_539dcf81_b i
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = i.warehouse_id AND w.is_deleted = 'n'
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = i.product_id   AND p.is_deleted = 'n'
 WHERE i.is_deleted = 'n'
 GROUP BY i.tenant_id, i.warehouse_id, w.name;


-- ============================================================================
-- 自检（fail-loud）：缺任何一条都直接抛异常，绝不"跑过了就说完成"
-- ============================================================================
DO $$
DECLARE
  v_missing TEXT := '';
  v_n       INTEGER;
  v_opt     TEXT;
  v_def     TEXT;
BEGIN
  -- 1) 两个视图必须存在且是 security_invoker
  FOREACH v_def IN ARRAY ARRAY['vw_erp_inventory_stock_list', 'vw_erp_inventory_stock_totals']
  LOOP
    SELECT string_agg(c.reloptions::text, ',') INTO v_opt
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relname = v_def
       AND c.relkind = 'v';

    IF v_opt IS NULL THEN
      v_missing := v_missing || format('视图 %s 不存在;', v_def);
      CONTINUE;
    END IF;

    IF position('security_invoker=true' IN replace(v_opt, ' ', '')) = 0 THEN
      v_missing := v_missing || format('视图 %s 不是 security_invoker（会绕过租户 RLS）;', v_def);
    END IF;
  END LOOP;

  -- 2) 逐行视图必须真的把名称关联进来（防止有人后续改成只查库存表）
  SELECT pg_get_viewdef('public.vw_erp_inventory_stock_list'::regclass, true) INTO v_def;
  IF position('erp_products_s_539dcf81_b' IN v_def) = 0 THEN
    v_missing := v_missing || 'vw_erp_inventory_stock_list 未关联物料表;';
  END IF;
  IF position('is_low_stock' IN v_def) = 0 THEN
    v_missing := v_missing || 'vw_erp_inventory_stock_list 缺少 is_low_stock 判定;';
  END IF;
  IF position('LEFT JOIN' IN upper(v_def)) = 0 THEN
    v_missing := v_missing || 'vw_erp_inventory_stock_list 必须用 LEFT JOIN（否则被软删的名称会让整行消失）;';
  END IF;

  -- 3) 合计视图必须按仓库分组且带 fixed 聚合
  SELECT pg_get_viewdef('public.vw_erp_inventory_stock_totals'::regclass, true) INTO v_def;
  IF position('low_stock_count' IN v_def) = 0 THEN
    v_missing := v_missing || 'vw_erp_inventory_stock_totals 缺少 low_stock_count;';
  END IF;
  IF position('GROUP BY' IN upper(v_def)) = 0 THEN
    v_missing := v_missing || 'vw_erp_inventory_stock_totals 未做分组聚合;';
  END IF;

  -- 4) 列清单校验：前端按列名取数，列名变了必须立刻炸
  SELECT count(*) INTO v_n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'vw_erp_inventory_stock_list'
     AND column_name IN ('product_code','product_name','specification','unit','safety_stock',
                         'warehouse_code','warehouse_name','bin_code','bin_name','batch_no',
                         'expiry_date','stock_status','quantity','available_quantity',
                         'locked_quantity','unit_cost','total_cost','is_low_stock');
  IF v_n <> 18 THEN
    v_missing := v_missing || format('vw_erp_inventory_stock_list 关键列缺失（期望 18，实际 %s）;', v_n);
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_99 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_99 OK：库存查询服务端视图（逐行 % + 按仓库合计）已就绪',
    'vw_erp_inventory_stock_list';
END $$;
