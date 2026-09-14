-- ============================================================================
-- deploy_34: 出库/入库单据（销售出货、采购入库）支持库位（bin/location）
-- ----------------------------------------------------------------------------
-- 背景：
--   * erp_bins（库位）由 deploy_25 引入，库存表 erp_inventory 与流水
--     erp_inventory_transactions 已带 location_id。
--   * 但销售出库单（erp_sales_deliveries / erp_sales_delivery_details）与
--     采购入库单（erp_purchase_receipts / erp_purchase_receipt_details）无论
--     主表还是明细表都没有 location_id；post_stock_document / reverse_stock_document
--     在过账/冲销时也把流水 location_id 写死为 NULL，且库存查找不带库位。
--   * 因此出入库流程无法落到具体库位。
--
-- 本次改造目标：
--   1) 主表与明细表都增加 location_id（明细为空时回退到主表默认库位）。
--   2) 过账/冲销按 (product, warehouse, location, batch) 维度处理库存与流水。
--   3) 修正 deploy_13 遗留的非库位唯一索引与 deploy_25 的库位唯一索引并存导致
--      的“库位维度无法区分”问题（drop 旧索引、保留/重建库位维度唯一索引）。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) 新增 location_id 列（幂等）
-- ----------------------------------------------------------------------------
ALTER TABLE public.erp_purchase_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);
ALTER TABLE public.erp_purchase_receipt_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);
ALTER TABLE public.erp_sales_deliveries_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);
ALTER TABLE public.erp_sales_delivery_details_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS location_id INTEGER
    REFERENCES public.erp_bins_s_539dcf81_b(id);

-- FK 索引（幂等）
CREATE INDEX IF NOT EXISTS idx_erp_purchase_receipts_location_id
  ON public.erp_purchase_receipts_s_539dcf81_b(location_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_receipt_details_location_id
  ON public.erp_purchase_receipt_details_s_539dcf81_b(location_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_deliveries_location_id
  ON public.erp_sales_deliveries_s_539dcf81_b(location_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_delivery_details_location_id
  ON public.erp_sales_delivery_details_s_539dcf81_b(location_id);

-- ----------------------------------------------------------------------------
-- 2) 修正库存唯一索引：保留库位维度的唯一索引，移除非库位维度旧索引
--    deploy_13 的 uq_erp_inventory_active_stock_key 不含 location，会阻止同一
--    product/warehouse/batch 落到不同库位；drop 之，统一用库位维度索引。
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_active_stock_key_v2
  ON public.erp_inventory_s_539dcf81_b (
    product_id, warehouse_id, COALESCE(location_id, 0),
    (COALESCE(NULLIF(BTRIM(batch_no), ''), ''))
  ) WHERE is_deleted = 'n';

DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uq_erp_inventory_active_stock_key_v2'
      )
     AND EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uq_erp_inventory_active_stock_key'
      ) THEN
    DROP INDEX IF EXISTS public.uq_erp_inventory_active_stock_key;
  END IF;
END
$$;

-- 数据健康校验：新键 (product, warehouse, location, batch) 下不应存在重复活动行
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_s_539dcf81_b
    WHERE is_deleted = 'n'
    GROUP BY product_id, warehouse_id, COALESCE(location_id, 0),
             COALESCE(NULLIF(BTRIM(batch_no), ''), '')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot apply location migration: duplicate active inventory rows exist under (product, warehouse, location, batch)';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- 3) 重写 post_stock_document：按库位维度过账
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_stock_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC; v_location_id INTEGER;
  allow_negative BOOLEAN; normalized_batch TEXT; v_transaction_no TEXT;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no,
      x.receipt_date AS document_date, x.supplier_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no,
      x.delivery_date AS document_date, NULL::INTEGER AS supplier_id,
      x.warehouse_id, x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;
  IF h.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Stock document has no warehouse' USING ERRCODE = '23502';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    PERFORM x.id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    WHERE x.receipt_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  ELSE
    PERFORM x.id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    WHERE x.delivery_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Warehouse does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;

  FOR d IN
    SELECT x.id AS detail_id, x.product_id, x.quantity,
      x.unit_price AS receipt_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no, x.expiry_date,
      x.location_id AS detail_location_id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE,
      x.location_id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'sales_delivery'
      AND x.delivery_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY product_id, batch_no NULLS FIRST, detail_id
  LOOP
    line_count := line_count + 1;
    IF d.product_id IS NULL OR d.quantity IS NULL OR d.quantity <= 0 THEN
      RAISE EXCEPTION 'Detail % has no product or non-positive quantity',
        d.detail_id USING ERRCODE = '23514';
    END IF;
    normalized_batch := NULLIF(BTRIM(d.batch_no), '');
    -- 明细库位优先，回退到主表默认库位
    v_location_id := COALESCE(d.detail_location_id, h.header_location_id);

    -- 库位必须属于本单仓库（若指定了库位）
    IF v_location_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_bins_s_539dcf81_b b
      WHERE b.id = v_location_id AND b.warehouse_id = h.warehouse_id
        AND b.is_deleted = 'n';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Location % is not valid for warehouse %',
          v_location_id, h.warehouse_id USING ERRCODE = '23503';
      END IF;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', d.product_id, h.warehouse_id,
        COALESCE(v_location_id, 0), COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(v_location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF FOUND THEN
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      inventory_unit_cost := COALESCE(i.unit_cost, 0);
    ELSE
      old_qty := 0; old_available := 0; old_cost := 0;
      inventory_unit_cost := 0;
    END IF;

    IF p_document_type = 'purchase_receipt' THEN
      v_unit_cost := COALESCE(NULLIF(d.receipt_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), NULLIF(inventory_unit_cost, 0), 0);
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
    ELSE
      v_unit_cost := COALESCE(NULLIF(inventory_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
    END IF;
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Insufficient stock for product %, warehouse %, location %: available %, requested %',
        d.product_id, h.warehouse_id, COALESCE(v_location_id, 0),
        old_available, d.quantity
        USING ERRCODE = '23514';
    END IF;

    IF i.id IS NULL THEN
      INSERT INTO public.erp_inventory_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id,
        quantity, available_quantity, locked_quantity, unit_cost,
        total_cost, batch_no, expiry_date
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
        v_location_id,
        new_qty, new_available, 0,
        CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
        new_cost, normalized_batch, d.expiry_date
      ) RETURNING * INTO i;
    ELSE
      UPDATE public.erp_inventory_s_539dcf81_b
      SET quantity = new_qty, available_quantity = new_available,
          unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost
                           ELSE ABS(new_cost / new_qty) END,
          total_cost = new_cost,
          expiry_date = COALESCE(d.expiry_date, expiry_date),
          updated_at = NOW()
      WHERE id = i.id;
    END IF;

    v_transaction_no := 'IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS')
      || LPAD(d.detail_id::TEXT, 6, '0');
    INSERT INTO public.erp_inventory_transactions_s_539dcf81_b (
      corp_id, emp_id, is_deleted, transaction_no, transaction_type,
      transaction_date, product_id, warehouse_id, location_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN 'purchase_receipt_in' ELSE 'sales_delivery_out' END,
      h.document_date, d.product_id, h.warehouse_id, v_location_id, normalized_batch,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity ELSE -d.quantity END,
      v_unit_cost,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity * v_unit_cost ELSE -(d.quantity * v_unit_cost) END,
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN format('采购入库单 %s 过账', h.document_no)
           ELSE format('销售出货单 %s 过账', h.document_no) END
    );
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'Stock document has no active details'
      USING ERRCODE = '23514';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    IF h.supplier_id IS NULL OR COALESCE(h.total_amount, 0) <= 0 THEN
      RAISE EXCEPTION 'Purchase receipt requires supplier and positive amount'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.erp_payables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, supplier_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date, amount,
      paid_amount, balance, currency, exchange_rate, status, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.supplier_id, 'purchase_receipt',
      h.document_no, 'purchase_receipt', p_document_id, h.document_no,
      h.document_date, h.document_date, h.total_amount, 0, h.total_amount,
      'CNY', 1, 'open',
      format('采购入库单 %s 过账自动生成', h.document_no)
    )
    ON CONFLICT (source_type, source_id)
      WHERE is_deleted = 'n' AND source_type = 'purchase_receipt'
        AND source_id IS NOT NULL
    DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Purchase receipt already has an active payable'
        USING ERRCODE = '23505';
    END IF;
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'idempotency_key', p_idempotency_key);
END;
$$;

-- ----------------------------------------------------------------------------
-- 4) 重写 reverse_stock_document：按库位维度冲销
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_stock_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; t RECORD; i RECORD; payable RECORD;
  allow_negative BOOLEAN; normalized_batch TEXT;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  restored_unit_cost NUMERIC; line_count INTEGER := 0;
BEGIN
  IF p_document_type NOT IN ('purchase_receipt', 'sales_delivery') THEN
    RAISE EXCEPTION 'Unsupported stock document type: %', p_document_type
      USING ERRCODE = '22023';
  END IF;
  IF p_document_id IS NULL OR p_document_id <= 0
     OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.id, x.receipt_no AS document_no, x.total_amount,
      x.status, x.reversal_idempotency_key
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no, x.total_amount,
      x.status, x.reversal_idempotency_key
    INTO h FROM public.erp_sales_deliveries_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stock document does not exist or is deleted'
      USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'approved' AND h.reversal_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE,
      'document_type', p_document_type, 'document_id', p_document_id,
      'status', 'approved');
  END IF;
  IF h.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted documents can be reversed; current status: %',
      COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.* INTO payable FROM public.erp_payables_s_539dcf81_b x
    WHERE x.source_type = 'purchase_receipt'
      AND x.source_id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated payable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(payable.paid_amount, 0) > 0
       OR ABS(COALESCE(payable.balance, 0) -
              COALESCE(h.total_amount, 0)) >= 0.005 THEN
      RAISE EXCEPTION 'Payable was paid or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id,
             COALESCE(x.location_id, 0), x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(t.location_id, 0), COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id AND x.warehouse_id = t.warehouse_id
      AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory missing for transaction %, product %, warehouse %, location %',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0)
        USING ERRCODE = 'P0002';
    END IF;

    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_available := COALESCE(i.available_quantity, 0) -
      COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
      INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
      WHERE w.id = t.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Warehouse does not exist or is deleted'
        USING ERRCODE = 'P0002';
    END IF;
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION 'Cannot reverse: stock was consumed for product %, warehouse %, location %',
        t.product_id, t.warehouse_id, COALESCE(t.location_id, 0) USING ERRCODE = '23514';
    END IF;

    restored_unit_cost := CASE
      WHEN new_qty = 0 THEN COALESCE(t.unit_cost, i.unit_cost, 0)
      ELSE ABS(new_cost / new_qty)
    END;
    UPDATE public.erp_inventory_s_539dcf81_b
    SET quantity = new_qty, available_quantity = new_available,
        unit_cost = restored_unit_cost, total_cost = new_cost,
        updated_at = NOW()
    WHERE id = i.id;
  END LOOP;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'No active inventory transactions found'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.erp_inventory_transactions_s_539dcf81_b
  SET is_deleted = 'y', reversal_idempotency_key = p_idempotency_key,
      reversed_at = NOW(), updated_at = NOW()
  WHERE reference_type = p_document_type
    AND reference_id = p_document_id AND is_deleted = 'n';

  IF p_document_type = 'purchase_receipt' THEN
    UPDATE public.erp_payables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = payable.id;
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'approved', 'line_count', line_count,
    'idempotency_key', p_idempotency_key);
END;
$$;

REVOKE ALL ON FUNCTION public.post_stock_document(TEXT, INTEGER, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reverse_stock_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_stock_document(TEXT, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_stock_document(TEXT, INTEGER, UUID) TO authenticated;
