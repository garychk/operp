-- ============================================================================
-- deploy_134 —— 质检流转库存：不良品数量按「不合格数」而非「总量−合格数」
-- ============================================================================
--
-- 背景：deploy_110 起的 apply_quality_inspection_stock_move 在搬库存时用
--   v_bad := v_total - v_good  计算不良品数量。这在「整批全检」场景下成立
--   （合格 + 不合格 = 总量），但在「抽样检验」场景下会误判：
--     例：待检 4200，抽样 2000（合格 1980 / 不合格 20），
--          v_total=4200, v_good=1980 → v_bad=2220，
--          把「未抽检部分 2200」也冤枉当成不良品处置（报废/返工）。
--
-- 修复：v_bad 改为取质检单显式记录的不合格数 unqualified_quantity，
--   并以「总量−合格数」为上界（防止数据不一致时搬超）：
--     v_bad := LEAST(COALESCE(unqualified_quantity, 0), v_total - v_good)
--   未抽检部分 = v_total - v_good - v_bad，继续留在 inspection 桶不动，
--   等待后续再检（既不冤枉报废，也不擅自放行）。
--
-- 范围：只影响走「最后搬库存」分支的处置（让步接收 concession、非采购来源的
--   return）。return(采购)/scrap/rework 三个短路分支早已直接按 unqualified_quantity
--   生成草稿单，不受影响。
--
-- 依赖：deploy_133（本函数的最新定义，含 return/scrap/rework 短路分支）。
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
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
  -- 处置短路分支共用
  v_no TEXT;
  v_doc_id INTEGER;
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
  -- 公共：按来源解析仓库 / 库位（供 return / scrap / rework 短路分支 + 搬库存共用）
  -- ==========================================================================
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

  -- ==========================================================================
  -- 处置=退货：生成采购退货草稿单（deploy_132 逻辑，保持不变）
  -- ==========================================================================
  IF v_ins.disposition = 'return' AND v_ins.source_type = 'purchase_receipt' THEN
    IF EXISTS (
      SELECT 1 FROM public.erp_purchase_returns_s_539dcf81_b r
       WHERE r.tenant_id = v_tenant
         AND r.source_inspection_id = p_inspection_id
         AND r.is_deleted = 'n'
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
        'inspection_id', p_inspection_id, 'created_return', FALSE);
    END IF;

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

    SELECT d.unit_price, d.base_unit_price, d.location_id, d.quantity
      INTO v_detail
      FROM public.erp_purchase_receipt_details_s_539dcf81_b d
     WHERE d.id = v_ins.source_detail_id AND d.tenant_id = v_tenant AND d.is_deleted = 'n';
    v_unit_price := COALESCE(v_detail.unit_price, 0);
    v_base_unit_price := COALESCE(v_detail.base_unit_price, 0);
    IF v_loc IS NULL THEN
      v_loc := COALESCE(v_detail.location_id, NULL);
    END IF;

    IF COALESCE(v_ins.unqualified_quantity, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'nothing_to_move', 'inspection_id', p_inspection_id);
    END IF;

    v_no := public.generate_document_no_for_tenant(
      'purchase_return', COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE, v_tenant);

    INSERT INTO public.erp_purchase_returns_s_539dcf81_b (
      return_no, return_date, receipt_id, supplier_id, warehouse_id, location_id,
      total_amount, currency, exchange_rate, base_total_amount,
      reason, remark, status, source_inspection_id, tenant_id
    ) VALUES (
      v_no, COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      v_ins.source_id, v_sup, v_wh, v_loc,
      ROUND(v_unit_price * v_ins.unqualified_quantity, 2),
      COALESCE(v_cur, 'CNY'), COALESCE(v_rate, 1),
      ROUND(v_base_unit_price * v_ins.unqualified_quantity, 2),
      format('质检 %s 不合格退货', v_ins.inspection_no),
      format('由质检单 %s 自动生成（处置=退货）', v_ins.inspection_no),
      'draft', p_inspection_id, v_tenant
    )
    RETURNING id INTO v_doc_id;

    INSERT INTO public.erp_purchase_return_details_s_539dcf81_b (
      return_id, line_no, receipt_detail_id, product_id, quantity,
      unit_price, amount, base_unit_price, base_amount,
      batch_no, location_id, expiry_date, reason, tenant_id
    ) VALUES (
      v_doc_id, 1, v_ins.source_detail_id, v_ins.product_id,
      v_ins.unqualified_quantity,
      v_unit_price, ROUND(v_unit_price * v_ins.unqualified_quantity, 2),
      v_base_unit_price, ROUND(v_base_unit_price * v_ins.unqualified_quantity, 2),
      v_ins.batch_no, v_loc, NULL,
      format('质检 %s 不合格退货', v_ins.inspection_no), v_tenant
    );

    RETURN jsonb_build_object(
      'ok', TRUE, 'idempotent', FALSE, 'created_return', TRUE,
      'inspection_id', p_inspection_id, 'inspection_no', v_ins.inspection_no,
      'return_id', v_doc_id, 'return_no', v_no,
      'return_quantity', v_ins.unqualified_quantity);
  END IF;

  -- ==========================================================================
  -- 处置=报废：生成「其他出入库」报废出库草稿单（复用 deploy_104/105 通道）
  -- ==========================================================================
  IF v_ins.disposition = 'scrap' THEN
    IF EXISTS (
      SELECT 1 FROM public.erp_other_stock_documents_s_539dcf81_b d
       WHERE d.tenant_id = v_tenant
         AND d.source_inspection_id = p_inspection_id
         AND d.is_deleted = 'n'
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
        'inspection_id', p_inspection_id, 'created_scrap', FALSE);
    END IF;

    IF v_wh IS NULL THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'warehouse_not_resolved',
        'inspection_id', p_inspection_id, 'source_type', v_ins.source_type);
    END IF;

    IF COALESCE(v_ins.unqualified_quantity, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'nothing_to_move', 'inspection_id', p_inspection_id);
    END IF;

    v_no := public.generate_document_no_for_tenant(
      'other_stock_document', COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE, v_tenant);

    INSERT INTO public.erp_other_stock_documents_s_539dcf81_b (
      document_no, document_date, direction, business_type, warehouse_id,
      location_id, reason, remark, total_cost, status, source_inspection_id, tenant_id
    ) VALUES (
      v_no, COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      'out', 'scrap', v_wh, v_loc,
      format('质检 %s 不合格报废', v_ins.inspection_no),
      format('由质检单 %s 自动生成（处置=报废）', v_ins.inspection_no),
      0, 'draft', p_inspection_id, v_tenant
    )
    RETURNING id INTO v_doc_id;

    -- 报废出库明细：从 rejected 桶出，单价留 0（过账时按库存移动加权取值）
    INSERT INTO public.erp_other_stock_document_details_s_539dcf81_b (
      document_id, line_no, product_id, quantity, unit_cost, total_cost,
      location_id, batch_no, stock_status, remark, tenant_id
    ) VALUES (
      v_doc_id, 1, v_ins.product_id, v_ins.unqualified_quantity, 0, 0,
      v_loc, v_ins.batch_no, 'rejected',
      format('质检 %s 不合格报废', v_ins.inspection_no), v_tenant
    );

    RETURN jsonb_build_object(
      'ok', TRUE, 'idempotent', FALSE, 'created_scrap', TRUE,
      'inspection_id', p_inspection_id, 'inspection_no', v_ins.inspection_no,
      'scrap_doc_id', v_doc_id, 'scrap_doc_no', v_no,
      'scrap_quantity', v_ins.unqualified_quantity);
  END IF;

  -- ==========================================================================
  -- 处置=返工：生成返工生产订单草稿单（复用生产订单通道）
  -- ==========================================================================
  IF v_ins.disposition = 'rework' THEN
    IF EXISTS (
      SELECT 1 FROM public.erp_production_orders_s_539dcf81_b o
       WHERE o.tenant_id = v_tenant
         AND o.source_inspection_id = p_inspection_id
         AND o.is_deleted = 'n'
    ) THEN
      RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
        'inspection_id', p_inspection_id, 'created_rework', FALSE);
    END IF;

    IF COALESCE(v_ins.unqualified_quantity, 0) <= 0 THEN
      RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
        'reason', 'nothing_to_move', 'inspection_id', p_inspection_id);
    END IF;

    v_no := public.generate_document_no_for_tenant(
      'production_order', COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE, v_tenant);

    -- 返工工单：product_id = 原物料，数量 = 不合格数，仓库沿用来源仓库。
    -- BOM / 工艺路线不自动带（返工路径因物料而异，人工在生产订单页选）。
    INSERT INTO public.erp_production_orders_s_539dcf81_b (
      order_no, order_date, product_id, planned_quantity, completed_quantity,
      scrapped_quantity, planned_start_date, planned_end_date, warehouse_id,
      priority, remark, status, source_inspection_id, tenant_id
    ) VALUES (
      v_no, COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      v_ins.product_id, v_ins.unqualified_quantity, 0, 0,
      COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      COALESCE(v_ins.completed_at, CURRENT_DATE)::DATE,
      v_wh, 5,
      format('由质检单 %s 自动生成（处置=返工，数量 %s）',
             v_ins.inspection_no, v_ins.unqualified_quantity),
      'draft', p_inspection_id, v_tenant
    )
    RETURNING id INTO v_doc_id;

    RETURN jsonb_build_object(
      'ok', TRUE, 'idempotent', FALSE, 'created_rework', TRUE,
      'inspection_id', p_inspection_id, 'inspection_no', v_ins.inspection_no,
      'rework_order_id', v_doc_id, 'rework_order_no', v_no,
      'rework_quantity', v_ins.unqualified_quantity);
  END IF;

  -- ==========================================================================
  -- 以下是 deploy_110 原有逻辑：幂等检查 → 搬库存（rejected / hold）
  -- ==========================================================================

  IF v_wh IS NULL THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE,
      'reason', 'warehouse_not_resolved',
      'inspection_id', p_inspection_id, 'source_type', v_ins.source_type);
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
    -- 不良品 = 质检单显式记录的不合格数，上界为「总量−合格数」。
    -- 未抽检部分（v_total - v_good - v_bad）留在 inspection 桶，等后续再检。
    v_bad  := LEAST(COALESCE(v_ins.unqualified_quantity, 0), v_total - v_good);
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
-- 刷新 schema 缓存
-- ============================================================================
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- 自检：v_bad 必须按 unqualified_quantity 取值，且 return/scrap/rework 分支不丢
-- ============================================================================
DO $$
DECLARE
  v_def TEXT;
  v_missing TEXT := '';
BEGIN
  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_quality_inspection_stock_move';
  IF v_def IS NULL THEN
    v_missing := v_missing || 'apply_quality_inspection_stock_move 丢失;';
  ELSE
    IF POSITION('LEAST(COALESCE(v_ins.unqualified_quantity, 0), v_total - v_good)' IN v_def) = 0 THEN
      v_missing := v_missing || 'v_bad 未按 unqualified_quantity 取值;';
    END IF;
    IF POSITION('v_bad  := v_total - v_good' IN v_def) > 0 THEN
      v_missing := v_missing || '仍残留旧的 v_total - v_good 计算;';
    END IF;
    IF POSITION('erp_purchase_returns_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了 return 生成退货单分支;';
    END IF;
    IF POSITION('erp_other_stock_documents_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了 scrap 生成报废单分支;';
    END IF;
    IF POSITION('erp_production_orders_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了 rework 生成返工工单分支;';
    END IF;
    IF POSITION('move_inventory_stock_status' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了库存流转调用;';
    END IF;
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_134 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_134 OK：质检流转不良品按不合格数（unqualified_quantity）处置，未抽检部分留在待检桶';
END;
$$;
