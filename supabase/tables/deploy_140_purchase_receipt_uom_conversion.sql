-- ============================================================================
-- deploy_140：采购入库过账按「采购单位 → 库存单位」换算数量
-- ============================================================================
-- 背景：采购订单/采购入库明细的 quantity 是「采购单位」（如吨），
--   而库存 erp_inventory.quantity 是「库存单位/基本单位」（如米）。
--   物料 316不锈钢(431)：采购单位 吨(t) 1t=100m，库存单位 米(m)。
--   旧 post_stock_document 直接把采购单位数量当库存数量累加，数量/成本都错 100 倍。
--
-- 本 deploy 用 CREATE OR REPLACE 覆盖 post_stock_document：
--   1. 采购入库明细 SELECT 增加 conversion_factor（取自 erp_product_uoms
--      usage_type='purchase'，default 优先），销售出货恒为 1。
--   2. LOOP 内把单据数量 × factor 换算成库存单位数量，再累加库存 / 写流水。
--   3. 单价口径不变：入库明细 unit_price 已是「每库存单位」价（跟随物料库存单位），
--      故成本 = 库存数量 × 单价，换算后自然正确。
--   4. 只影响「新发生的入库过账」，历史已过账数据不追溯（符合不删不改历史数据红线）。
-- ============================================================================

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
  v_qty NUMERIC; -- 换算到库存单位的数量（采购入库 = 单据数量 × factor；销售出货 = 单据数量）
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
      COALESCE(NULLIF(pu.conversion_factor, 0), 1) AS conversion_factor,
      x.unit_price AS receipt_unit_cost,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0)
        AS product_unit_cost,
      NULLIF(BTRIM(x.batch_no), '') AS batch_no, x.expiry_date
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p ON p.id = x.product_id
    LEFT JOIN LATERAL (
      SELECT pu.conversion_factor
      FROM public.erp_product_uoms_s_539dcf81_b pu
      WHERE pu.product_id = x.product_id
        AND pu.usage_type = 'purchase'
        AND pu.is_deleted = 'n'
      ORDER BY pu.is_default DESC, pu.id
      LIMIT 1
    ) pu ON TRUE
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, 1::NUMERIC,
      NULL::NUMERIC,
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

    -- 单位换算（deploy_140）：单据数量 × 换算系数 = 库存单位数量。
    --   采购入库：factor = 采购单位→库存单位的换算（1采购单位 = factor 个库存单位）；
    --   销售出货：factor 恒为 1（出货明细数量本就是库存单位）。
    v_qty := d.quantity * COALESCE(NULLIF(d.conversion_factor, 0), 1);

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
      new_qty := old_qty + v_qty;
      new_available := old_available + v_qty;
      new_cost := old_cost + v_qty * v_unit_cost;
    ELSE
      v_unit_cost := COALESCE(NULLIF(inventory_unit_cost, 0),
        NULLIF(d.product_unit_cost, 0), 0);
      new_qty := old_qty - v_qty;
      new_available := old_available - v_qty;
      new_cost := old_cost - v_qty * v_unit_cost;
    END IF;
    IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
      RAISE EXCEPTION
        'Insufficient stock for product %, warehouse %: available %, requested %',
        d.product_id, h.warehouse_id, old_available, v_qty
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
      transaction_date, product_id, warehouse_id, location_id, batch_no, quantity,
      unit_cost, total_cost, reference_type, reference_id,
      reference_detail_id, posting_idempotency_key, remark
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(
        p_document_type,
        CASE WHEN p_document_type = 'purchase_receipt' THEN 'in' ELSE 'out' END),
      h.document_date, d.product_id, h.warehouse_id, NULL, normalized_batch,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN v_qty ELSE -v_qty END,
      v_unit_cost,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN v_qty * v_unit_cost ELSE -(v_qty * v_unit_cost) END,
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
    ON CONFLICT (tenant_id, source_type, source_id)
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

-- 自检：函数定义必须包含换算逻辑标记，防止覆盖失败但被误认为成功
DO $$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
  FROM pg_proc
  WHERE proname = 'post_stock_document'
    AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL OR v_def NOT ILIKE '%conversion_factor%' THEN
    RAISE EXCEPTION 'deploy_140 失败：post_stock_document 未包含单位换算逻辑';
  END IF;

  RAISE NOTICE 'OK：post_stock_document 已加入采购入库单位换算';
END;
$$;
