-- Atomic stock posting for purchase receipts and sales deliveries.
-- One RPC invocation equals one PostgreSQL transaction.

ALTER TABLE public.erp_purchase_receipts_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE public.erp_sales_deliveries_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE public.erp_inventory_transactions_s_539dcf81_b
  ADD COLUMN IF NOT EXISTS reference_detail_id INTEGER,
  ADD COLUMN IF NOT EXISTS posting_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversal_idempotency_key UUID,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_s_539dcf81_b
    WHERE is_deleted = 'n'
    GROUP BY product_id, warehouse_id,
      COALESCE(NULLIF(BTRIM(batch_no), ''), '')
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot install stock RPC: duplicate active inventory rows exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.erp_payables_s_539dcf81_b
    WHERE is_deleted = 'n' AND source_type = 'purchase_receipt'
      AND source_id IS NOT NULL
    GROUP BY source_type, source_id HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot install stock RPC: duplicate active receipt payables exist';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_active_stock_key
  ON public.erp_inventory_s_539dcf81_b (
    product_id, warehouse_id,
    (COALESCE(NULLIF(BTRIM(batch_no), ''), ''))
  ) WHERE is_deleted = 'n';
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_inventory_transactions_active_detail
  ON public.erp_inventory_transactions_s_539dcf81_b (
    reference_type, reference_id, reference_detail_id
  ) WHERE is_deleted = 'n' AND reference_detail_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_payables_active_purchase_receipt
  ON public.erp_payables_s_539dcf81_b (source_type, source_id)
  WHERE is_deleted = 'n' AND source_type = 'purchase_receipt'
    AND source_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_receipt_posting_key
  ON public.erp_purchase_receipts_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_receipt_reversal_key
  ON public.erp_purchase_receipts_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_delivery_posting_key
  ON public.erp_sales_deliveries_s_539dcf81_b (posting_idempotency_key)
  WHERE posting_idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_delivery_reversal_key
  ON public.erp_sales_deliveries_s_539dcf81_b (reversal_idempotency_key)
  WHERE reversal_idempotency_key IS NOT NULL;

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
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC;
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
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no,
      x.delivery_date AS document_date, NULL::INTEGER AS supplier_id,
      x.warehouse_id, x.total_amount, x.status, x.corp_id,
      x.posting_idempotency_key
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
      NULLIF(BTRIM(x.batch_no), '') AS batch_no, x.expiry_date
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE
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
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s', d.product_id, h.warehouse_id,
        COALESCE(normalized_batch, '')), 0));

    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
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
        'Insufficient stock for product %, warehouse %: available %, requested %',
        d.product_id, h.warehouse_id, old_available, d.quantity
        USING ERRCODE = '23514';
    END IF;

    IF i.id IS NULL THEN
      INSERT INTO public.erp_inventory_s_539dcf81_b (
        corp_id, emp_id, is_deleted, product_id, warehouse_id,
        quantity, available_quantity, locked_quantity, unit_cost,
        total_cost, batch_no, expiry_date
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
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
      transaction_date, product_id, warehouse_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN 'purchase_receipt_in' ELSE 'sales_delivery_out' END,
      h.document_date, d.product_id, h.warehouse_id, normalized_batch,
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
    ORDER BY x.product_id, x.warehouse_id, x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id AND x.warehouse_id = t.warehouse_id
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory missing for transaction %, product %, warehouse %',
        t.id, t.product_id, t.warehouse_id USING ERRCODE = 'P0002';
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
      RAISE EXCEPTION 'Cannot reverse: stock was consumed for product %, warehouse %',
        t.product_id, t.warehouse_id USING ERRCODE = '23514';
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
