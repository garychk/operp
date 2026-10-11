-- ============================================================================
-- deploy_100 —— P1-4 / P1-5 收尾：把「业务动作」接到通用库存 RPC 上
--
-- 为什么还要单独一个脚本：
--   deploy_88 已经把地基铺完 —— stock_status 维度、inventory_apply_move 唯一入口、
--   erp_inventory_reservations 表、reserve_inventory_stock / move_inventory_stock_status
--   两个通用 RPC，以及 sys_config.inventory 的 receiptStockStatus / reserveOnOrderRelease
--   两个开关。但这两个通用 RPC **至今没有任何调用方**（全库 grep 只有定义处），
--   也就是「地基建好了，楼上没人住」：locked_quantity 永远是 0，待检库存永远出不去。
--   本脚本把业务动作翻译成这两个通用 RPC 的调用，前端只负责点按钮。
--
-- 提供 3 个业务级 RPC（均 SECURITY INVOKER，租户隔离继续由 RLS 把关）：
--   1. apply_quality_inspection_stock_move   质检完成 → 待检库存搬到 available / rejected / hold
--   2. reserve_sales_order_stock             销售订单审核通过 → 按明细预占库存
--   3. reserve_production_order_stock        生产订单下达 → 按用料明细预占库存
-- 外加 2 个配置读取助手 + 1 处加列（erp_sales_orders.warehouse_id）。
--
-- 三者的共同约定：
--   · **不吞错**：真正的数据问题（单据不存在 / 状态不对）一律 RAISE EXCEPTION；
--     只有「业务上本来就不需要做」的（开关关闭、没配仓库、没有未结明细）才返回
--     skipped=true + reason，前端据此提示而不是弹错误。
--   · **幂等**：靠 erp_inventory_transactions（reference_type/reference_id）与
--     erp_inventory_reservations（source_type/source_id + status='open'）里已有的
--     来源记录短路，重复点击不会重复扣减 / 重复预占。
--   · 返回值恒为 jsonb，键名固定：ok / skipped / reason / ...，前端不需要解析异常文本。
-- ============================================================================

-- ============================================================================
-- 1. erp_sales_orders 补 warehouse_id
--    预占必须知道「从哪个仓发货」，而销售订单表原本没有仓库字段。
--    刻意**不猜默认仓回填存量**：猜错仓 = 预占到错误的仓，比不预占更危险；
--    存量单保持 NULL，由 reserve_sales_order_stock 返回 skipped('warehouse_not_set')，
--    前端提示用户补选。新单在页面上选择。
-- ============================================================================
ALTER TABLE public.erp_sales_orders_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS warehouse_id INTEGER;

COMMENT ON COLUMN public.erp_sales_orders_s_539dcf81_b.warehouse_id IS
  '发货仓库。订单审核通过时按该仓预占库存（P1-5）；为空则不下预占（skipped=warehouse_not_set）。';

-- ============================================================================
-- 2. 配置读取助手：单据下发票时是否自动预占库存
--    过账 / 预占 RPC 是 SECURITY INVOKER，直接读 sys_config 会撞 RLS；
--    与 deploy_88 的 inventory_receipt_stock_status 同一思路（SECURITY DEFINER + STABLE）。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.inventory_reserve_on_release(p_tenant_id BIGINT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_raw TEXT;
BEGIN
  SELECT c.config_json ->> 'reserveOnOrderRelease'
    INTO v_raw
    FROM public.sys_config c
   WHERE c.is_deleted = 'n'
     AND c.category_code = 'inventory'
     AND (c.tenant_id = p_tenant_id OR c.tenant_id IS NULL)
   ORDER BY CASE WHEN c.tenant_id = p_tenant_id THEN 0 ELSE 1 END, c.id DESC
   LIMIT 1;

  -- 配置缺失 / 取值非法都不让业务失败，退回种子默认值 true
  IF v_raw IS NULL OR BTRIM(v_raw) = '' THEN
    RETURN TRUE;
  END IF;
  IF LOWER(BTRIM(v_raw)) IN ('true', 't', '1', 'yes', 'on') THEN
    RETURN TRUE;
  END IF;
  IF LOWER(BTRIM(v_raw)) IN ('false', 'f', '0', 'no', 'off') THEN
    RETURN FALSE;
  END IF;

  RAISE WARNING 'inventory.reserveOnOrderRelease 取值非法（%），按 true 处理', v_raw;
  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.inventory_reserve_on_release(BIGINT) TO authenticated;

-- ============================================================================
-- 3. 质检完成 → 库存状态流转（P1-4 收尾）
--
--    结果 → 目标状态 的映射（只这 4 条，**写在代码里而不是配置里**，
--    避免「配置写错把不良品放行」这种事故）：
--      result='qualified'    → 整批 inspection → available
--      result='conditional'  → 整批 inspection → available（让步接收 / 挑选后放行）
--      result='unqualified'  → 抽检合格数 → available；其余按 disposition：
--                                disposition='rework' → hold（待返工，先冻结）
--                                其他（scrap/return/accept/sort/空） → rejected
--
--    为什么 qualified 搬的是「整批 inspection_quantity」而不是「抽样合格数」：
--    入库时把整批放进了 inspection 桶（见 inventory_receipt_stock_status），
--    抽检只是判断依据；只放行抽样数会让绝大多数库存永久卡在「待检」。
--    不良品的差异化处置只针对 unqualified 结果。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.apply_quality_inspection_stock_move(
  p_inspection_id   INTEGER,
  p_idempotency_key UUID DEFAULT NULL,
  p_tenant_id       BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  v_ins RECORD;
  v_wh  INTEGER;
  v_loc INTEGER;
  v_on_hand NUMERIC;
  v_total NUMERIC;
  v_good  NUMERIC := 0;
  v_bad   NUMERIC := 0;
  v_bad_status TEXT;
  v_moves JSONB := '[]'::JSONB;
  v_out JSONB;
BEGIN
  IF p_inspection_id IS NULL THEN
    RAISE EXCEPTION '需要 inspection_id' USING ERRCODE = '23502';
  END IF;

  SELECT q.* INTO v_ins
    FROM public.erp_quality_inspections_s_539dcf81_b q
   WHERE q.id = p_inspection_id AND q.tenant_id = v_tenant AND q.is_deleted = 'n'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION '质检单不存在或已删除：%', p_inspection_id USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_ins.status, '') <> 'completed' THEN
    RAISE EXCEPTION '质检单 % 当前状态为 %，只有已完成（completed）才能流转库存',
      v_ins.inspection_no, v_ins.status USING ERRCODE = '23514';
  END IF;

  -- 幂等：同一张质检单只搬一次
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
     WHERE t.tenant_id = v_tenant
       AND t.reference_type = 'quality_inspection'
       AND t.reference_id = p_inspection_id
       AND t.is_deleted = 'n'
  ) THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'inspection_id', p_inspection_id);
  END IF;

  -- 解析来源单据的仓库 / 库位
  IF v_ins.source_type = 'purchase_receipt' THEN
    SELECT h.warehouse_id, COALESCE(d.location_id, h.location_id)
      INTO v_wh, v_loc
      FROM public.erp_purchase_receipts_s_539dcf81_b h
      LEFT JOIN public.erp_purchase_receipt_details_s_539dcf81_b d
             ON d.id = v_ins.source_detail_id
            AND d.tenant_id = v_tenant AND d.is_deleted = 'n'
     WHERE h.id = v_ins.source_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n';
  ELSIF v_ins.source_type = 'sales_return' THEN
    SELECT h.warehouse_id, h.location_id
      INTO v_wh, v_loc
      FROM public.erp_sales_returns_s_539dcf81_b h
     WHERE h.id = v_ins.source_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n';
  ELSIF v_ins.source_type = 'production_operation' THEN
    SELECT o.warehouse_id, NULL::INTEGER
      INTO v_wh, v_loc
      FROM public.erp_production_reports_s_539dcf81_b r
      JOIN public.erp_production_orders_s_539dcf81_b o
        ON o.id = r.production_order_id
       AND o.tenant_id = v_tenant AND o.is_deleted = 'n'
     WHERE r.id = v_ins.source_id AND r.tenant_id = v_tenant AND r.is_deleted = 'n';
  END IF;

  IF v_wh IS NULL THEN
    -- 工序质检本来就不一定对应某个库存桶，解析不到仓库属于正常分支，不算错误
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'warehouse_not_resolved',
      'inspection_id', p_inspection_id, 'source_type', v_ins.source_type);
  END IF;

  -- 待检桶里到底有多少：配置默认是 receiptStockStatus='available'，
  -- 此时整批压根没进 inspection 桶，本次流转就是空操作（跳过而不是报错）。
  SELECT COALESCE(i.quantity, 0) INTO v_on_hand
    FROM public.erp_inventory_s_539dcf81_b i
   WHERE i.tenant_id = v_tenant
     AND i.product_id = v_ins.product_id
     AND i.warehouse_id = v_wh
     AND COALESCE(i.location_id, 0) = COALESCE(v_loc, 0)
     AND COALESCE(NULLIF(BTRIM(i.batch_no), ''), '')
         = COALESCE(NULLIF(BTRIM(v_ins.batch_no), ''), '')
     AND i.stock_status = 'inspection'
     AND i.is_deleted = 'n';
  v_on_hand := COALESCE(v_on_hand, 0);

  IF v_on_hand <= 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'no_inspection_stock', 'inspection_id', p_inspection_id,
      'warehouse_id', v_wh, 'location_id', v_loc);
  END IF;

  -- 质检数量可能大于待检桶余额（分次入库 / 已流转过一部分），以桶内余额为上界
  v_total := LEAST(COALESCE(v_ins.inspection_quantity, 0), v_on_hand);

  IF COALESCE(v_ins.result, '') IN ('qualified', 'conditional') THEN
    v_good := v_total;
  ELSE
    v_good := LEAST(GREATEST(COALESCE(v_ins.qualified_quantity, 0), 0), v_total);
    v_bad  := v_total - v_good;
  END IF;

  v_bad_status := CASE WHEN v_ins.disposition = 'rework' THEN 'hold' ELSE 'rejected' END;

  IF v_good > 0 THEN
    v_out := public.move_inventory_stock_status(
      p_product_id      => v_ins.product_id,
      p_warehouse_id    => v_wh,
      p_from_status     => 'inspection',
      p_to_status       => 'available',
      p_quantity        => v_good,
      p_location_id     => v_loc,
      p_batch_no        => v_ins.batch_no,
      p_reference_type  => 'quality_inspection',
      p_reference_id    => p_inspection_id,
      p_idempotency_key => NULL,
      p_remark          => format('质检 %s 合格放行', v_ins.inspection_no),
      p_tenant_id       => v_tenant);
    v_moves := v_moves || jsonb_build_object(
      'to_status', 'available', 'quantity', v_good,
      'unit_cost', v_out ->> 'unit_cost');
  END IF;

  IF v_bad > 0 THEN
    v_out := public.move_inventory_stock_status(
      p_product_id      => v_ins.product_id,
      p_warehouse_id    => v_wh,
      p_from_status     => 'inspection',
      p_to_status       => v_bad_status,
      p_quantity        => v_bad,
      p_location_id     => v_loc,
      p_batch_no        => v_ins.batch_no,
      p_reference_type  => 'quality_inspection',
      p_reference_id    => p_inspection_id,
      p_idempotency_key => NULL,
      p_remark          => format('质检 %s 不良品处置（%s）',
                                  v_ins.inspection_no, COALESCE(v_ins.disposition, 'none')),
      p_tenant_id       => v_tenant);
    v_moves := v_moves || jsonb_build_object(
      'to_status', v_bad_status, 'quantity', v_bad,
      'unit_cost', v_out ->> 'unit_cost');
  END IF;

  IF v_good = 0 AND v_bad = 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'nothing_to_move', 'inspection_id', p_inspection_id);
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE, 'idempotent', FALSE,
    'inspection_id', p_inspection_id, 'inspection_no', v_ins.inspection_no,
    'product_id', v_ins.product_id, 'warehouse_id', v_wh, 'location_id', v_loc,
    'batch_no', v_ins.batch_no, 'inspection_on_hand', v_on_hand,
    'available_quantity', v_good, 'bad_quantity', v_bad, 'bad_status', v_bad_status,
    'moves', v_moves);
END;
$$;

GRANT EXECUTE ON FUNCTION public.apply_quality_inspection_stock_move(INTEGER, UUID, BIGINT)
  TO authenticated;

-- ============================================================================
-- 4. 销售订单审核通过 → 预占库存（P1-5）
--    开关：sys_config.inventory.reserveOnOrderRelease（默认 true）
--    仓库：erp_sales_orders.warehouse_id
--    明细：erp_sales_order_details 的未发量 = quantity - COALESCE(delivered_quantity, 0)
--
--    p_allow_shortage => TRUE 是刻意的：**下达阶段不允许因为库存不足就把审核卡死**，
--    缺口由 deploy_88 的「库存行不存在也登记预占」承接，等入库后 available 自然补齐。
--    ATP 视图（vw_erp_inventory_atp）会把「已占 > 现存」的缺口显示成负数，看得见。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reserve_sales_order_stock(
  p_order_id        INTEGER,
  p_idempotency_key UUID DEFAULT NULL,
  p_tenant_id       BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  v_order RECORD;
  v_lines JSONB;
  v_count INTEGER := 0;
  v_out JSONB;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION '需要 order_id' USING ERRCODE = '23502';
  END IF;

  SELECT o.* INTO v_order
    FROM public.erp_sales_orders_s_539dcf81_b o
   WHERE o.id = p_order_id AND o.tenant_id = v_tenant AND o.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION '销售订单不存在或已删除：%', p_order_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.inventory_reserve_on_release(v_tenant) THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'config_disabled', 'order_id', p_order_id);
  END IF;

  IF v_order.warehouse_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'warehouse_not_set', 'order_id', p_order_id);
  END IF;

  SELECT COALESCE(jsonb_agg(e), '[]'::JSONB) INTO v_lines
    FROM (
      SELECT jsonb_build_object(
               'product_id',       d.product_id,
               'quantity',         d.quantity - COALESCE(d.delivered_quantity, 0),
               'source_detail_id', d.id,
               'stock_status',     'available') AS e
        FROM public.erp_sales_order_details_s_539dcf81_b d
       WHERE d.order_id = p_order_id
         AND d.tenant_id = v_tenant
         AND d.is_deleted = 'n'
         AND d.product_id IS NOT NULL
         AND d.quantity - COALESCE(d.delivered_quantity, 0) > 0
    ) s;

  v_count := jsonb_array_length(v_lines);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'no_open_lines', 'order_id', p_order_id);
  END IF;

  v_out := public.reserve_inventory_stock(
    p_source_type     => 'sales_order',
    p_source_id       => p_order_id,
    p_source_no       => v_order.order_no,
    p_warehouse_id    => v_order.warehouse_id,
    p_lines           => v_lines,
    p_idempotency_key => COALESCE(p_idempotency_key, gen_random_uuid()),
    p_tenant_id       => v_tenant,
    p_allow_shortage  => TRUE);

  RETURN jsonb_build_object(
    'ok', TRUE, 'skipped', FALSE,
    'order_id', p_order_id, 'order_no', v_order.order_no,
    'warehouse_id', v_order.warehouse_id, 'line_count', v_count,
    'reservation', v_out);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_sales_order_stock(INTEGER, UUID, BIGINT)
  TO authenticated;

-- ============================================================================
-- 5. 生产订单下达 → 按用料明细预占库存（P1-5）
--    仓库口径：**用订单头的 erp_production_orders.warehouse_id（领料仓）**。
--    说明：用料明细 erp_production_order_details 自带 warehouse_id（行级覆盖），
--    但 reserve_inventory_stock 的幂等短路是按 (source_type, source_id) 判的，
--    一张订单拆成多个仓调用会被第二次调用当成「已预占」直接短路，因此这里统一走
--    订单头仓库。行级覆盖暂不参与预占，属已知限制，写在这里避免下次误判成 bug。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reserve_production_order_stock(
  p_order_id        INTEGER,
  p_idempotency_key UUID DEFAULT NULL,
  p_tenant_id       BIGINT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant BIGINT := COALESCE(p_tenant_id, public.current_tenant_id());
  v_order RECORD;
  v_lines JSONB;
  v_count INTEGER := 0;
  v_out JSONB;
BEGIN
  IF p_order_id IS NULL THEN
    RAISE EXCEPTION '需要 order_id' USING ERRCODE = '23502';
  END IF;

  SELECT o.* INTO v_order
    FROM public.erp_production_orders_s_539dcf81_b o
   WHERE o.id = p_order_id AND o.tenant_id = v_tenant AND o.is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION '生产订单不存在或已删除：%', p_order_id USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.inventory_reserve_on_release(v_tenant) THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'config_disabled', 'order_id', p_order_id);
  END IF;

  IF v_order.warehouse_id IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'warehouse_not_set', 'order_id', p_order_id);
  END IF;

  SELECT COALESCE(jsonb_agg(e), '[]'::JSONB) INTO v_lines
    FROM (
      SELECT jsonb_build_object(
               'product_id',       d.material_id,
               'quantity',         d.planned_quantity - COALESCE(d.issued_quantity, 0),
               'source_detail_id', d.id,
               'stock_status',     'available') AS e
        FROM public.erp_production_order_details_s_539dcf81_b d
       WHERE d.order_id = p_order_id
         AND d.tenant_id = v_tenant
         AND d.is_deleted = 'n'
         AND d.material_id IS NOT NULL
         AND d.planned_quantity - COALESCE(d.issued_quantity, 0) > 0
    ) s;

  v_count := jsonb_array_length(v_lines);
  IF v_count = 0 THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'no_open_lines', 'order_id', p_order_id);
  END IF;

  v_out := public.reserve_inventory_stock(
    p_source_type     => 'production_order',
    p_source_id       => p_order_id,
    p_source_no       => v_order.order_no,
    p_warehouse_id    => v_order.warehouse_id,
    p_lines           => v_lines,
    p_idempotency_key => COALESCE(p_idempotency_key, gen_random_uuid()),
    p_tenant_id       => v_tenant,
    p_allow_shortage  => TRUE);

  RETURN jsonb_build_object(
    'ok', TRUE, 'skipped', FALSE,
    'order_id', p_order_id, 'order_no', v_order.order_no,
    'warehouse_id', v_order.warehouse_id, 'line_count', v_count,
    'reservation', v_out);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_production_order_stock(INTEGER, UUID, BIGINT)
  TO authenticated;

-- ============================================================================
-- 6. 自检：确认上面每一件东西真的落库了
--    只打印 NOTICE 的清单式自检不算数（deploy_41 教训），这里是硬失败。
-- ============================================================================
DO $selfcheck$
DECLARE
  v_def TEXT;
  missing TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'erp_sales_orders_s_539dcf81_b'
       AND column_name = 'warehouse_id'
  ) THEN
    missing := missing || 'erp_sales_orders.warehouse_id 列';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'inventory_reserve_on_release'
       AND p.pronargs = 1
  ) THEN
    missing := missing || 'inventory_reserve_on_release(BIGINT)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'apply_quality_inspection_stock_move'
       AND p.pronargs = 3
  ) THEN
    missing := missing || 'apply_quality_inspection_stock_move(INTEGER, UUID, BIGINT)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'reserve_sales_order_stock'
       AND p.pronargs = 3
  ) THEN
    missing := missing || 'reserve_sales_order_stock(INTEGER, UUID, BIGINT)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'reserve_production_order_stock'
       AND p.pronargs = 3
  ) THEN
    missing := missing || 'reserve_production_order_stock(INTEGER, UUID, BIGINT)';
  END IF;

  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'deploy_100 自检失败，缺失：%', array_to_string(missing, ' / ');
  END IF;

  -- 断言实现细节（而不只是「函数存在」）——防止有人把函数体改成空壳后照样过检
  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_quality_inspection_stock_move';
  IF POSITION('quality_inspection' IN v_def) = 0
     OR POSITION('rework' IN v_def) = 0
     OR POSITION('move_inventory_stock_status' IN v_def) = 0
     OR POSITION('no_inspection_stock' IN v_def) = 0 THEN
    RAISE EXCEPTION 'apply_quality_inspection_stock_move 实现不完整（缺少来源标记 / rework 规则 / 通用 RPC 调用 / 空桶短路）';
  END IF;

  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reserve_sales_order_stock';
  IF POSITION('reserve_inventory_stock' IN v_def) = 0
     OR POSITION('sales_order' IN v_def) = 0
     OR POSITION('erp_sales_order_details_s_539dcf81_b' IN v_def) = 0
     OR POSITION('warehouse_not_set' IN v_def) = 0 THEN
    RAISE EXCEPTION 'reserve_sales_order_stock 实现不完整（缺少通用 RPC 调用 / 来源类型 / 明细表 / 缺仓短路）';
  END IF;

  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reserve_production_order_stock';
  IF POSITION('reserve_inventory_stock' IN v_def) = 0
     OR POSITION('production_order' IN v_def) = 0
     OR POSITION('erp_production_order_details_s_539dcf81_b' IN v_def) = 0 THEN
    RAISE EXCEPTION 'reserve_production_order_stock 实现不完整（缺少通用 RPC 调用 / 来源类型 / 用料明细表）';
  END IF;

  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'inventory_reserve_on_release';
  IF POSITION('reserveOnOrderRelease' IN v_def) = 0 THEN
    RAISE EXCEPTION 'inventory_reserve_on_release 未读取 inventory.reserveOnOrderRelease 配置';
  END IF;

  RAISE NOTICE 'deploy_100 OK：质检库存流转 / 订单下达预占 业务级 RPC 已就位，配置助手与 warehouse_id 列已校验';
END;
$selfcheck$;
