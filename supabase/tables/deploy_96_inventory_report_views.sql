-- ============================================================================
-- deploy_96 —— P1-6：三个库存报表视图（收发存汇总 / 库存明细账 / 库龄分析）
-- ============================================================================
--
-- 目的：把前端 `Inventory.tsx` 里"拉全表到浏览器再 JS 关联"的做法改成**服务端聚合**。
--   ① vw_erp_inventory_summary  收发存汇总表（按 物料 × 仓库 × 月份）
--   ② vw_erp_inventory_ledger   库存明细账（逐笔流水 + 逐行滚动余额）
--   ③ vw_erp_inventory_aging    库龄分析（按现有库存行分桶）
--
-- 设计约束（与项目既有铁律一致）：
--   * **一律 `security_invoker = true`** —— 视图不提升权限，底层 erp_* 的 fail-closed
--     RLS 按调用者身份生效。否则视图会成为绕过租户隔离的后门。
--   * **金额口径 = 本位币**：`erp_inventory_transactions.total_cost` 在写入时已按
--     移动加权/本位币落库（见 deploy_93），视图不再做汇率折算，也不 `COALESCE(…,1)`。
--   * **只统计 `is_deleted = 'n'`** 的流水与库存行；冲销是软删，天然被排除。
--
-- 已知口径说明（务必让使用者知道，别当成 bug）：
--   * 收发存汇总只输出**有流水发生**的月份行；中间没有发生额的月份不补零行。
--     期初 = 该月之前所有流水的净额累计，因此"首行期初"就是建账前的累计。
--   * 库龄按"该库存行（物料×仓库×库位×批次×状态）最早一次入库流水的日期"计算，
--     不是严格的 FIFO 分层账（本系统当前不维护成本层）。同一批次被部分领用后，
--     剩余量的库龄仍按最早入库日算 —— 对呆滞料识别是**保守偏高**的估算。
-- ============================================================================


-- ============================================================================
-- ① 收发存汇总表
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_summary
  WITH (security_invoker = true) AS
WITH monthly AS (
  SELECT t.tenant_id,
         t.product_id,
         t.warehouse_id,
         date_trunc('month', t.transaction_date)::date AS period_start,
         SUM(CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END)  AS in_qty,
         SUM(CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END) AS out_qty,
         SUM(CASE WHEN t.quantity > 0 THEN ABS(t.total_cost) ELSE 0 END)  AS in_amount,
         SUM(CASE WHEN t.quantity < 0 THEN ABS(t.total_cost) ELSE 0 END)  AS out_amount,
         COUNT(*) AS txn_count
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n'
   GROUP BY t.tenant_id, t.product_id, t.warehouse_id,
            date_trunc('month', t.transaction_date)
)
SELECT c.tenant_id,
       c.period_start,
       EXTRACT(YEAR  FROM c.period_start)::INTEGER AS period_year,
       EXTRACT(MONTH FROM c.period_start)::INTEGER AS period_month,
       c.product_id,
       p.code AS product_code,
       p.name AS product_name,
       p.unit,
       c.warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       -- 期初 = 本行之前所有月份的净额累计
       COALESCE(SUM(c.in_qty - c.out_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_qty,
       COALESCE(SUM(c.in_amount - c.out_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS opening_amount,
       c.in_qty,
       c.in_amount,
       c.out_qty,
       c.out_amount,
       -- 期末 = 期初 + 收 - 发
       COALESCE(SUM(c.in_qty - c.out_qty) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_qty,
       COALESCE(SUM(c.in_amount - c.out_amount) OVER (
         PARTITION BY c.tenant_id, c.product_id, c.warehouse_id
         ORDER BY c.period_start
         ROWS UNBOUNDED PRECEDING), 0) AS closing_amount,
       c.txn_count
  FROM monthly c
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = c.product_id   AND p.tenant_id = c.tenant_id
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = c.warehouse_id AND w.tenant_id = c.tenant_id;


-- ============================================================================
-- ② 库存明细账（逐笔流水 + 滚动余额）
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_ledger
  WITH (security_invoker = true) AS
SELECT t.tenant_id,
       t.id AS transaction_id,
       t.transaction_no,
       t.transaction_date,
       t.product_id,
       p.code AS product_code,
       p.name AS product_name,
       p.unit,
       t.warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       t.location_id,
       b.code AS location_code,
       t.batch_no,
       COALESCE(t.stock_status, 'available') AS stock_status,
       t.transaction_type,
       it.name AS transaction_type_name,
       COALESCE(it.direction, 'neutral') AS direction,
       t.reference_type,
       t.reference_id,
       t.reference_detail_id,
       t.remark,
       CASE WHEN t.quantity > 0 THEN t.quantity ELSE 0 END  AS in_qty,
       CASE WHEN t.quantity < 0 THEN -t.quantity ELSE 0 END AS out_qty,
       t.unit_cost,
       t.total_cost AS amount,
       -- 逐行滚动余额：按"物料 × 仓库 × 库位 × 批次 × 状态"这一条库存账页累加
       SUM(t.quantity) OVER (
         PARTITION BY t.tenant_id, t.product_id, t.warehouse_id,
                      COALESCE(t.location_id, 0),
                      COALESCE(NULLIF(BTRIM(t.batch_no), ''), ''),
                      COALESCE(t.stock_status, '')
         ORDER BY t.transaction_date, t.id
         ROWS UNBOUNDED PRECEDING) AS running_qty,
       SUM(t.total_cost) OVER (
         PARTITION BY t.tenant_id, t.product_id, t.warehouse_id,
                      COALESCE(t.location_id, 0),
                      COALESCE(NULLIF(BTRIM(t.batch_no), ''), ''),
                      COALESCE(t.stock_status, '')
         ORDER BY t.transaction_date, t.id
         ROWS UNBOUNDED PRECEDING) AS running_amount
  FROM public.erp_inventory_transactions_s_539dcf81_b t
  LEFT JOIN public.erp_products_s_539dcf81_b   p  ON p.id  = t.product_id   AND p.tenant_id = t.tenant_id
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w  ON w.id  = t.warehouse_id AND w.tenant_id = t.tenant_id
  LEFT JOIN public.erp_bins_s_539dcf81_b       b  ON b.id  = t.location_id  AND b.tenant_id = t.tenant_id
  LEFT JOIN public.sys_inventory_transaction_types it ON it.code = t.transaction_type
 WHERE t.is_deleted = 'n';


-- ============================================================================
-- ③ 库龄分析
-- ============================================================================
CREATE OR REPLACE VIEW public.vw_erp_inventory_aging
  WITH (security_invoker = true) AS
WITH first_in AS (
  -- 每条库存账页（物料×仓库×库位×批次×状态）最早一次"入库"日期
  SELECT t.tenant_id, t.product_id, t.warehouse_id,
         COALESCE(t.location_id, 0) AS location_key,
         COALESCE(NULLIF(BTRIM(t.batch_no), ''), '') AS batch_key,
         COALESCE(t.stock_status, 'available') AS status_key,
         MIN(t.transaction_date) AS first_in_date
    FROM public.erp_inventory_transactions_s_539dcf81_b t
   WHERE t.is_deleted = 'n' AND t.quantity > 0
   GROUP BY t.tenant_id, t.product_id, t.warehouse_id,
            COALESCE(t.location_id, 0),
            COALESCE(NULLIF(BTRIM(t.batch_no), ''), ''),
            COALESCE(t.stock_status, 'available')
)
SELECT i.tenant_id,
       i.product_id,
       p.code AS product_code,
       p.name AS product_name,
       p.unit,
       i.warehouse_id,
       w.code AS warehouse_code,
       w.name AS warehouse_name,
       i.location_id,
       b.code AS location_code,
       i.batch_no,
       i.stock_status,
       i.quantity,
       i.available_quantity,
       i.locked_quantity,
       i.unit_cost,
       i.total_cost,
       i.expiry_date,
       f.first_in_date,
       GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) AS age_days,
       CASE
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 30  THEN '0-30'
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 60  THEN '31-60'
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 90  THEN '61-90'
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 180 THEN '91-180'
         ELSE '180+'
       END AS age_bucket,
       CASE
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 30  THEN 1
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 60  THEN 2
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 90  THEN 3
         WHEN GREATEST(CURRENT_DATE - COALESCE(f.first_in_date, i.created_at::date), 0) <= 180 THEN 4
         ELSE 5
       END AS age_bucket_order
  FROM public.erp_inventory_s_539dcf81_b i
  LEFT JOIN first_in f
         ON  f.tenant_id    = i.tenant_id
         AND f.product_id   = i.product_id
         AND f.warehouse_id = i.warehouse_id
         AND f.location_key = COALESCE(i.location_id, 0)
         AND f.batch_key    = COALESCE(NULLIF(BTRIM(i.batch_no), ''), '')
         AND f.status_key   = i.stock_status
  LEFT JOIN public.erp_products_s_539dcf81_b   p ON p.id = i.product_id   AND p.tenant_id = i.tenant_id
  LEFT JOIN public.erp_warehouses_s_539dcf81_b w ON w.id = i.warehouse_id AND w.tenant_id = i.tenant_id
  LEFT JOIN public.erp_bins_s_539dcf81_b       b ON b.id = i.location_id  AND b.tenant_id = i.tenant_id
 WHERE i.is_deleted = 'n' AND COALESCE(i.quantity, 0) <> 0;


-- ============================================================================
-- 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_name  TEXT;
  v_opts  TEXT;
  v_missing TEXT := '';
  v_expect TEXT[] := ARRAY['vw_erp_inventory_summary','vw_erp_inventory_ledger','vw_erp_inventory_aging'];
BEGIN
  FOREACH v_name IN ARRAY v_expect LOOP
    SELECT COALESCE(array_to_string(c.reloptions, ','), '') INTO v_opts
      FROM pg_class c
     WHERE c.relkind = 'v'
       AND c.relnamespace = 'public'::regnamespace
       AND c.relname = v_name;

    IF v_opts IS NULL THEN
      v_missing := v_missing || format('%s 未创建;', v_name);
      CONTINUE;
    END IF;
    -- 铁律：视图必须 security_invoker，否则会绕过租户 RLS
    IF v_opts NOT ILIKE '%security_invoker=%true%' AND v_opts NOT ILIKE '%security_invoker=true%' THEN
      v_missing := v_missing || format('%s 缺 security_invoker 选项（当前 %s）;', v_name, v_opts);
    END IF;
  END LOOP;

  -- 关键口径必须留在视图定义里，防止后人"优化"掉
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_summary'::regclass, TRUE))
     NOT ILIKE '%UNBOUNDED PRECEDING%' THEN
    v_missing := v_missing || 'vw_erp_inventory_summary 丢了期初/期末滚动累计;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_ledger'::regclass, TRUE))
     NOT ILIKE '%running_qty%' THEN
    v_missing := v_missing || 'vw_erp_inventory_ledger 丢了滚动余额;';
  END IF;
  IF (SELECT pg_get_viewdef('public.vw_erp_inventory_aging'::regclass, TRUE))
     NOT ILIKE '%age_bucket%' THEN
    v_missing := v_missing || 'vw_erp_inventory_aging 丢了库龄分桶;';
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_96 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_96 OK：收发存汇总 / 库存明细账 / 库龄分析 三个 security_invoker 视图已就绪';
END;
$$;
