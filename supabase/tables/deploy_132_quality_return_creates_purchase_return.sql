-- ============================================================================
-- deploy_132 —— 质检处置=退货（return）自动生成采购退货草稿单（方案 B）
-- ============================================================================
--
-- 背景：质检单 IQC 不合格处置选了「退货（return）」，但
--   apply_quality_inspection_stock_move 只区分 rework（→hold）与其它（→rejected），
--   把 return 也丢进了 rejected 桶，没有真正「退货给供应商」。
--
-- 方案 B（最小改动、职责清晰）：
--   质检只负责「判定 + 生成采购退货草稿单」，库存与应付的变动统一交给
--   退货单过账（post_stock_document 的 purchase_return 分支）完成。
--   · disposition='return' 且 source_type='purchase_receipt' 时：
--       生成一张 erp_purchase_returns（draft）+ 一条 erp_purchase_return_details，
--       字段从原采购入库单/明细带出，数量=不合格数；
--       本次质检**不搬 rejected 库存**（退货单过账时才会扣 available + 冲应付）。
--   · 其它来源（sales_return / production_*）的 return 保持原行为（→rejected），
--     避免行为漂移——只有采购入库检验有「退供应商」的语义。
--
-- 幂等：erp_purchase_returns 新增 source_inspection_id 列 + 唯一索引，
--   同一张质检单重复点「流转库存」只生成一次退货单（返回 idempotent）。
--
-- 依赖：deploy_89（采购退货表/单据号/过账）、deploy_110（质检流转 RPC）。
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

-- ============================================================================
-- 1. 退货单加来源质检单标识 + 幂等唯一索引
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_purchase_returns_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    ALTER TABLE public.erp_purchase_returns_s_539dcf81_b
      ADD COLUMN source_inspection_id INTEGER;
    RAISE NOTICE 'erp_purchase_returns: 已加 source_inspection_id 列';
  ELSE
    RAISE NOTICE 'erp_purchase_returns: source_inspection_id 已存在，跳过';
  END IF;
END $$;

COMMENT ON COLUMN public.erp_purchase_returns_s_539dcf81_b.source_inspection_id IS
  '来源质检单 id。由质检处置=退货时自动生成退货草稿单时回填，用于幂等去重（同一质检单只生成一张退货单）。';

-- 幂等：同一张质检单最多生成一张未删除的退货单
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_purchase_returns_source_inspection
  ON public.erp_purchase_returns_s_539dcf81_b (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL AND is_deleted = 'n';

-- ============================================================================
-- 2. 重写 apply_quality_inspection_stock_move：disposition='return' 分支
--    在 deploy_110 基础上，仅在「解析到仓库之后、查待检桶之前」插入 return 短路。
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
  -- return 分支：生成退货草稿单
  v_ret_no TEXT;
  v_ret_id INTEGER;
  v_sup INTEGER;
  v_cur VARCHAR(10);
  v_rate NUMERIC;
  v_unit_price NUMERIC;
  v_base_unit_price NUMERIC;
  v_detail RECORD;
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

  -- ==========================================================================
  -- 处置=退货：短路，生成采购退货草稿单，不搬库存（方案 B）
  -- ==========================================================================
  IF v_ins.disposition = 'return' AND v_ins.source_type = 'purchase_receipt' THEN
    -- 幂等：同一质检单只生成一张退货单
    IF EXISTS (
      SELECT 1 FROM public.erp_purchase_returns_s_539dcf81_b r
       WHERE r.tenant_id = v_tenant
         AND r.source_inspection_id = p_inspection_id
         AND r.is_deleted = 'n'
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
        'inspection_id', p_inspection_id, 'created_return', FALSE);
    END IF;

    -- 原采购入库单头：供应商 / 仓库 / 币别 / 汇率
    SELECT h.supplier_id, h.warehouse_id, h.location_id,
           h.currency, h.exchange_rate
      INTO v_sup, v_wh, v_loc, v_cur, v_rate
      FROM public.erp_purchase_receipts_s_539dcf81_b h
     WHERE h.id = v_ins.source_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n';
    IF v_wh IS NULL THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'warehouse_not_resolved',
        'inspection_id', p_inspection_id, 'source_type', v_ins.source_type);
    END IF;

    -- 原采购入库明细行：单价 / 库位（退货明细要沿用原成本价）
    SELECT d.unit_price, d.base_unit_price, d.location_id, d.quantity
      INTO v_detail
      FROM public.erp_purchase_receipt_details_s_539dcf81_b d
     WHERE d.id = v_ins.source_detail_id AND d.tenant_id = v_tenant AND d.is_deleted = 'n';
    v_unit_price := COALESCE(v_detail.unit_price, 0);
    v_base_unit_price := COALESCE(v_detail.base_unit_price, 0);
    IF v_loc IS NULL THEN
      v_loc := COALESCE(v_detail.location_id, NULL);
    END IF;

    -- 退货数量 = 不合格数（>0 时才建单；否则空操作）
    IF COALESCE(v_ins.unqualified_quantity, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'nothing_to_move', 'inspection_id', p_inspection_id);
    END IF;

    -- 退货单号：走统一命名规则 PRN{YYYY}{####}，显式传租户避免依赖 GUC
    v_ret_no := public.generate_document_no_for_tenant(
      'purchase_return', COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE, v_tenant);

    INSERT INTO public.erp_purchase_returns_s_539dcf81_b (
      return_no, return_date, receipt_id, supplier_id, warehouse_id, location_id,
      total_amount, currency, exchange_rate, base_total_amount,
      reason, remark, status, source_inspection_id, tenant_id
    ) VALUES (
      v_ret_no, COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      v_ins.source_id, v_sup, v_wh, v_loc,
      ROUND(v_unit_price * v_ins.unqualified_quantity, 2),
      COALESCE(v_cur, 'CNY'), COALESCE(v_rate, 1),
      ROUND(v_base_unit_price * v_ins.unqualified_quantity, 2),
      format('质检 %s 不合格退货', v_ins.inspection_no),
      format('由质检单 %s 自动生成（处置=退货）', v_ins.inspection_no),
      'draft', p_inspection_id, v_tenant
    )
    RETURNING id INTO v_ret_id;

    INSERT INTO public.erp_purchase_return_details_s_539dcf81_b (
      return_id, line_no, receipt_detail_id, product_id, quantity,
      unit_price, amount, base_unit_price, base_amount,
      batch_no, location_id, expiry_date, reason, tenant_id
    ) VALUES (
      v_ret_id, 1, v_ins.source_detail_id, v_ins.product_id,
      v_ins.unqualified_quantity,
      v_unit_price, ROUND(v_unit_price * v_ins.unqualified_quantity, 2),
      v_base_unit_price, ROUND(v_base_unit_price * v_ins.unqualified_quantity, 2),
      v_ins.batch_no, v_loc, NULL,
      format('质检 %s 不合格退货', v_ins.inspection_no), v_tenant
    );

    RETURN jsonb_build_object(
      'ok', TRUE, 'idempotent', FALSE, 'created_return', TRUE,
      'inspection_id', p_inspection_id, 'inspection_no', v_ins.inspection_no,
      'return_id', v_ret_id, 'return_no', v_ret_no,
      'return_quantity', v_ins.unqualified_quantity);
  END IF;

  -- ==========================================================================
  -- 以下是 deploy_110 原有逻辑：幂等检查 → 解析仓库 → 搬库存
  -- ==========================================================================

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
    SELECT h.warehouse_id, h.location_id
      INTO v_wh, v_loc
      FROM public.erp_production_receipts_s_539dcf81_b h
     WHERE h.id = v_ins.source_id AND h.tenant_id = v_tenant AND h.is_deleted = 'n';
  END IF;

  IF v_wh IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'warehouse_not_resolved',
      'inspection_id', p_inspection_id, 'source_type', v_ins.source_type);
  END IF;

  -- 待检桶余额
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
-- 3. 刷新 schema 缓存
-- ============================================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 4. 自检
-- ============================================================================
DO $$
DECLARE
  v_def TEXT;
  v_missing TEXT := '';
BEGIN
  -- 4.1 source_inspection_id 列与幂等索引
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_purchase_returns_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    v_missing := v_missing || 'erp_purchase_returns.source_inspection_id 缺失;';
  END IF;

  -- 4.2 流转函数带 return 生成退货单分支，且既有来源/口径不丢
  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_quality_inspection_stock_move';
  IF v_def IS NULL THEN
    v_missing := v_missing || 'apply_quality_inspection_stock_move 丢失;';
  ELSE
    IF POSITION('erp_purchase_returns_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '缺 return 生成退货单分支;';
    END IF;
    IF POSITION('source_inspection_id' IN v_def) = 0 THEN
      v_missing := v_missing || '缺 source_inspection_id 幂等回填;';
    END IF;
    IF POSITION('erp_production_receipts_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了 production_receipt 分支;';
    END IF;
    IF POSITION('purchase_receipt' IN v_def) = 0
       OR POSITION('sales_return' IN v_def) = 0
       OR POSITION('production_operation' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了既有来源分支;';
    END IF;
    IF POSITION('move_inventory_stock_status' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了库存流转调用;';
    END IF;
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_132 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_132 OK：质检退货自动生成采购退货草稿单 + 幂等列/索引就绪';
END;
$$;
