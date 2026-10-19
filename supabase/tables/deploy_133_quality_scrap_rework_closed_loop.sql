-- ============================================================================
-- deploy_133 —— 质检处置=报废(scrap)/返工(rework) 闭环（复用现有单据通道）
-- ============================================================================
--
-- 背景：deploy_132 只闭环了「退货(return)」——采购入库质检处置=退货时自动生成
--   采购退货草稿单。但「报废(scrap)」和「返工(rework)」仍只是把不合格品丢进
--   rejected / hold 桶，没有任何下游出口。
--
-- 方案（与 deploy_132 的退货同构，职责清晰）：
--   质检只负责「判定 + 生成草稿单」，库存与成本的变动统一交给对应单据过账完成。
--
--   · disposition='scrap' ：
--       复用「其他出入库单」通道（deploy_104/105 已支持 business_type=scrap →
--       scrap_out → 借 6711 营业外支出 / 贷 1405 库存商品）。
--       生成一张 erp_other_stock_documents（direction='out', business_type='scrap',
--       status='draft'）+ 一条明细（stock_status='rejected'，数量=不合格数）。
--       过账时从 rejected 桶扣减并记报废损失凭证。
--
--   · disposition='rework' ：
--       复用「生产订单」通道。生成一张 erp_production_orders 草稿单
--       （product_id=原物料，planned_quantity=不合格数，status='draft'，
--         source_inspection_id 标记返工来源）。人工在生产订单页确认下达 →
--       领料 → 报工 → 完工入库，走完整生产流程，把不合格品重新变成良品。
--
-- 幂等：两张目标表各加 source_inspection_id 列 + 唯一索引，
--   同一张质检单重复点「流转库存」只生成一次（返回 idempotent）。
--
-- 范围控制：
--   · scrap / rework 对所有来源类型（purchase_receipt / sales_return /
--     production_operation / production_receipt）都生效，仓库按来源解析。
--   · 其它来源的 return 仍保持 deploy_132 行为（→rejected），不漂移。
--   · 挑选(sort) / 让步(concession) 不在此次范围（sort 前端已 disable，
--     concession 仍走「合格放行 + conditional」原逻辑）。
--
-- 依赖：deploy_104/105（其他出入库单）、deploy_89（生产订单单据号）、
--       deploy_110/132（质检流转 RPC 及其 return 分支）。
-- 注：本脚本由 000_run_all 用 psql --single-transaction 执行，不要写 BEGIN/COMMIT。
-- ============================================================================

-- ============================================================================
-- 1. 两张目标表加「来源质检单」标识 + 幂等唯一索引
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_other_stock_documents_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    ALTER TABLE public.erp_other_stock_documents_s_539dcf81_b
      ADD COLUMN source_inspection_id INTEGER;
    RAISE NOTICE 'erp_other_stock_documents: 已加 source_inspection_id 列';
  END IF;
END $$;

COMMENT ON COLUMN public.erp_other_stock_documents_s_539dcf81_b.source_inspection_id IS
  '来源质检单 id。由质检处置=报废时自动生成报废出库草稿单时回填，用于幂等去重。';

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_other_stock_docs_source_inspection
  ON public.erp_other_stock_documents_s_539dcf81_b (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL AND is_deleted = 'n';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_production_orders_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    ALTER TABLE public.erp_production_orders_s_539dcf81_b
      ADD COLUMN source_inspection_id INTEGER;
    RAISE NOTICE 'erp_production_orders: 已加 source_inspection_id 列';
  END IF;
END $$;

COMMENT ON COLUMN public.erp_production_orders_s_539dcf81_b.source_inspection_id IS
  '来源质检单 id。由质检处置=返工时自动生成返工生产订单草稿时回填，用于幂等去重并标记返工来源。';

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_production_orders_source_inspection
  ON public.erp_production_orders_s_539dcf81_b (source_inspection_id)
  WHERE source_inspection_id IS NOT NULL AND is_deleted = 'n';


-- ============================================================================
-- 2. 重写 apply_quality_inspection_stock_move
--    在 deploy_132 基础上，把「按来源解析仓库」提前为公共段，
--    并新增 scrap（→其他出入库报废单）与 rework（→返工生产订单）两个短路分支。
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
  -- 返工分支「生成工单后继续搬库存」用的标志
  v_rework_no TEXT;
  v_rework_id INTEGER;
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
  -- 说明：返工与 return/scrap 不同，**生成工单后不提前 RETURN**，而是继续落回
  --   下方「搬库存」逻辑——合格品仍要 inspection→available、不合格品按
  --   rework 走 inspection→hold（hold = 待返工桶）。因为返工只是「把不合格品
  --   标记为待返工」，并不等于库存已经搬走；若在此处直接 RETURN，合格品会
  --   永远滞留在 inspection 桶无法放行（历史 bug，见 2026-10-19 修复）。
  -- ==========================================================================
  IF v_ins.disposition = 'rework' THEN
    -- 幂等：同一张质检单只生成一次返工工单；已存在则仅回填单号，不重复建单
    SELECT o.order_no, o.id
      INTO v_rework_no, v_rework_id
      FROM public.erp_production_orders_s_539dcf81_b o
     WHERE o.tenant_id = v_tenant
       AND o.source_inspection_id = p_inspection_id
       AND o.is_deleted = 'n'
     ORDER BY o.id
     LIMIT 1;

    IF v_rework_id IS NULL AND COALESCE(v_ins.unqualified_quantity, 0) > 0 THEN
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
      RETURNING order_no, id INTO v_rework_no, v_rework_id;
    END IF;
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
    'created_rework', v_rework_id IS NOT NULL,
    'rework_order_id', v_rework_id, 'rework_order_no', v_rework_no,
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
  -- 4.1 两张目标表的幂等列 + 唯一索引
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_other_stock_documents_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    v_missing := v_missing || 'erp_other_stock_documents.source_inspection_id 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='erp_production_orders_s_539dcf81_b'
      AND column_name='source_inspection_id'
  ) THEN
    v_missing := v_missing || 'erp_production_orders.source_inspection_id 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname='uq_erp_other_stock_docs_source_inspection'
  ) THEN
    v_missing := v_missing || 'uq_erp_other_stock_docs_source_inspection 缺失;';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname='uq_erp_production_orders_source_inspection'
  ) THEN
    v_missing := v_missing || 'uq_erp_production_orders_source_inspection 缺失;';
  END IF;

  -- 4.2 流转函数带 scrap / rework 生成草稿单分支，且既有逻辑不丢
  SELECT p.prosrc INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'apply_quality_inspection_stock_move';
  IF v_def IS NULL THEN
    v_missing := v_missing || 'apply_quality_inspection_stock_move 丢失;';
  ELSE
    IF POSITION('erp_other_stock_documents_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '缺 scrap 生成报废单分支;';
    END IF;
    IF POSITION('erp_production_orders_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '缺 rework 生成返工工单分支;';
    END IF;
    IF POSITION('erp_purchase_returns_s_539dcf81_b' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了 return 生成退货单分支;';
    END IF;
    IF POSITION('move_inventory_stock_status' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了库存流转调用;';
    END IF;
    IF POSITION('production_receipt' IN v_def) = 0
       OR POSITION('production_operation' IN v_def) = 0
       OR POSITION('sales_return' IN v_def) = 0 THEN
      v_missing := v_missing || '丢了既有来源分支;';
    END IF;
  END IF;

  IF v_missing <> '' THEN
    RAISE EXCEPTION 'deploy_133 自检失败：%', v_missing;
  END IF;

  RAISE NOTICE 'deploy_133 OK：质检报废→其他出入库草稿单、返工→生产订单草稿单 + 幂等列/索引就绪';
END;
$$;
