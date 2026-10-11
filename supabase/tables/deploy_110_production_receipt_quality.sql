-- ============================================================================
-- deploy_110 —— P0-2：成品入库检验（FQC）接通
-- ============================================================================
--
-- 背景（差距清单 F1/I1）：`erp_quality_inspections.source_type` 的 CHECK 只有
--   ('purchase_receipt','sales_return','production_operation') —— **没有成品入库**，
--   于是完工入库的成品**无处录检验**，只能直接判 quality_status='qualified' 放行。
--
-- 好消息：入库侧早已支持「入库即待检」——
--   `post_production_document`（deploy_93 最新定义）尾部按
--   `inventory_receipt_stock_status(tenant)` 决定把成品放进 available 还是 inspection 桶，
--   与采购入库同一开关（sys_config.inventory.receiptStockStatus）。
--   所以本脚本**只需补质检单这一侧**：
--     ① 放开 source_type 的 CHECK，允许 'production_receipt'；
--     ② 给 `apply_quality_inspection_stock_move` 加一个 production_receipt 分支
--        （解析仓库/库位 → 把 inspection 桶搬进 available / hold / rejected）；
--     ③ 其余口径（判定 → 目标状态映射、幂等、空桶短路）与既有来源**完全一致**。
--
-- 仓库/库位口径：完工入库单是「主表即唯一明细行」，库位放在**表头**
--   （deploy_58：领料库位在明细行、完工入库库位在表头），因此直接读表头即可。
--
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，**不要写 BEGIN/COMMIT**。
-- ============================================================================

-- ============================================================================
-- 1. 放开 source_type 的取值约束，增加 production_receipt（成品入库检验）
--    DROP 后重建：CHECK 无法 ALTER，只能重定义。
-- ============================================================================
ALTER TABLE public.erp_quality_inspections_s_539dcf81_b
  DROP CONSTRAINT IF EXISTS erp_quality_inspections_s_539dcf81_b_source_type_check;

ALTER TABLE public.erp_quality_inspections_s_539dcf81_b
  ADD CONSTRAINT erp_quality_inspections_s_539dcf81_b_source_type_check
  CHECK (source_type IN (
    'purchase_receipt',
    'sales_return',
    'production_operation',
    'production_receipt'
  ));

-- ============================================================================
-- 2. 质检完成 → 库存状态流转（在 deploy_100 基础上增加 production_receipt 分支）
--
--    与 deploy_100 的区别**只有一处**：新增 `ELSIF source_type = 'production_receipt'`
--    分支，从完工入库表头解析 warehouse_id / location_id。
--    其余实现逐字保持，避免与既有三种来源的行为漂移。
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
  ELSIF v_ins.source_type = 'production_receipt' THEN
    -- 完工入库单是「主表即唯一明细行」，库位在表头（deploy_58）
    SELECT h.warehouse_id, h.location_id
      INTO v_wh, v_loc
      FROM public.erp_production_receipts_s_539dcf81_b h
     WHERE h.id = v_ins.source_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n';
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
-- 3. 自检（fail-loud）
-- ============================================================================
DO $$
DECLARE
  v_def       TEXT;
  v_condef    TEXT;
  v_missing   TEXT := '';
BEGIN
  -- 3.1 source_type CHECK 必须已包含 production_receipt
  SELECT pg_get_constraintdef(oid) INTO v_condef
    FROM pg_constraint
   WHERE conrelid = 'public.erp_quality_inspections_s_539dcf81_b'::regclass
     AND conname  = 'erp_quality_inspections_s_539dcf81_b_source_type_check';
  IF v_condef IS NULL THEN
    v_missing := v_missing || 'source_type CHECK 约束丢失;';
  ELSIF POSITION('production_receipt' IN v_condef) = 0 THEN
    v_missing := v_missing || 'source_type CHECK 未包含 production_receipt;';
  END IF;

  -- 3.2 流转函数必须带上 production_receipt 分支，且既有来源一个都不能丢
  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_quality_inspection_stock_move';
  IF v_def IS NULL THEN
    v_missing := v_missing || 'apply_quality_inspection_stock_move 丢失;';
  ELSE
    IF POSITION('erp_production_receipts_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '流转函数缺 production_receipt 分支（未读完工入库表头）;';
    END IF;
    -- 既有三种来源与关键口径必须仍在
    IF POSITION('purchase_receipt' IN v_def) = 0
       OR POSITION('sales_return' IN v_def) = 0
       OR POSITION('production_operation' IN v_def) = 0 THEN
      v_missing := v_missing || '流转函数丢了既有来源分支;';
    END IF;
    IF POSITION('rework' IN v_def) = 0
       OR POSITION('move_inventory_stock_status' IN v_def) = 0
       OR POSITION('no_inspection_stock' IN v_def) = 0 THEN
      v_missing := v_missing || '流转函数丢了既有口径（rework / 通用 RPC / 空桶短路）;';
    END IF;
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_110 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_110 OK：成品入库检验（FQC）已接通 —— source_type 放开 production_receipt，库存流转分支已补';
END;
$$;
