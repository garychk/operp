-- ============================================================================
-- deploy_69_post_stock_base_currency.sql
-- 多币别改造 · 第 2 期（单据 + 成本）· 步骤 2/2：过账折本位币 + AR/AP 继承币种
--
-- 依赖 deploy_68 建立的列（currency / exchange_rate / base_total_amount /
--   base_amount / source_type / source_id / source_no）。
--
-- 本脚本做四件事：
--   A. 修正 erp_payables 的来源幂等唯一索引：补 tenant_id
--      （原索引只按 (source_type, source_id)，而 source_id 是各租户自己的
--       id 序列，两个租户的入库单 id 都从 1 开始 → 会互撞索引）
--   B. 重写 post_stock_document：
--        · 采购入库：明细单价是**原币**，必须先折本位币再进库存成本
--          （决策：库存成本一律本位币；汇率方向 1 外币 = rate 本位币）
--        · 生成应付：继承来源单据的 currency / exchange_rate，并写 base_amount
--        · 销售出货：**新增自动生成应收**（此前完全缺失，导致应收只能财务页
--          手工录，币种也就没有来源可继承）
--   C. 重写 reverse_stock_document：销售出货反过账时一并作废生成的应收
--   D. 补流转字段映射：PO→入库 / SO→出货 增加 currency / exchange_rate /
--      base_total_amount 三个表头字段
--
-- 加固（顺带修，与币种无关但同一函数）：
--   两个函数内所有查询显式带 tenant_id。原因是 RLS 的 super_admin 分支
--   是「跨租户可见」的（`current_user_is_super_admin() OR tenant_id = ...`），
--   超管过账时按 reference_id / source_id 反查会命中别的租户同 id 的行，
--   表现为「取错行」或 JOIN 笛卡尔积。函数是 SECURITY INVOKER，没有绕过
--   RLS 的豁免，必须自己收敛租户。
--
-- 反过账为何不需要额外折汇：reverse 是「按流水行自身的 unit_cost/total_cost
--   反向加减库存」，而流水里存的已经是本位币成本 → 天然按原汇率回冲。
--
-- 运行环境：由 000_run_all.local.sh 以 psql --single-transaction 执行，
--           脚本内**不要**写 BEGIN / COMMIT。
-- ============================================================================

\echo '[deploy_69] 过账折本位币 + AR/AP 继承来源币种...'

-- ---------------------------------------------------------------------------
-- A. 修正 erp_payables 的幂等唯一索引（补 tenant_id）
--    DROP + CREATE 而非 IF NOT EXISTS：索引名不变但定义要变，
--    IF NOT EXISTS 会因同名而跳过，导致修正静默失效。
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uq_erp_payables_active_purchase_receipt;
CREATE UNIQUE INDEX uq_erp_payables_active_purchase_receipt
  ON public.erp_payables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n'
    AND source_type = 'purchase_receipt'
    AND source_id IS NOT NULL;

DROP INDEX IF EXISTS public.idx_erp_payables_source;
CREATE INDEX idx_erp_payables_source
  ON public.erp_payables_s_539dcf81_b (tenant_id, source_type, source_id)
  WHERE is_deleted = 'n';

-- ---------------------------------------------------------------------------
-- B. 重写 post_stock_document
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_stock_document(
  p_document_type TEXT,
  p_document_id INTEGER,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; inventory_unit_cost NUMERIC; v_location_id INTEGER;
  allow_negative BOOLEAN; normalized_batch TEXT; v_transaction_no TEXT;
  v_exchange_rate NUMERIC; v_base_total NUMERIC;
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
      x.receipt_date AS document_date, x.supplier_id,
      NULL::INTEGER AS customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no,
      x.delivery_date AS document_date, NULL::INTEGER AS supplier_id,
      x.customer_id, x.warehouse_id,
      x.location_id AS header_location_id,
      x.total_amount, x.status, x.corp_id, x.posting_idempotency_key,
      x.currency, x.exchange_rate, x.tenant_id
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

  -- 冻结汇率。NULL 或 0 一律按 1 处理 —— 否则折本位币会把金额乘成 0 而静默清零。
  v_exchange_rate := COALESCE(NULLIF(h.exchange_rate, 0), 1);
  v_base_total := ROUND(COALESCE(h.total_amount, 0) * v_exchange_rate, 2);

  IF EXISTS (
    SELECT 1 FROM public.erp_inventory_transactions_s_539dcf81_b t
    WHERE t.reference_type = p_document_type
      AND t.reference_id = p_document_id
      AND t.tenant_id = h.tenant_id
      AND t.is_deleted = 'n'
  ) THEN
    RAISE EXCEPTION 'Document already has active inventory transactions'
      USING ERRCODE = '23505';
  END IF;

  IF p_document_type = 'purchase_receipt' THEN
    PERFORM x.id
    FROM public.erp_purchase_receipt_details_s_539dcf81_b x
    WHERE x.receipt_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  ELSE
    PERFORM x.id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    WHERE x.delivery_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.id
    FOR UPDATE;
  END IF;

  SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
  INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
  WHERE w.id = h.warehouse_id
    AND w.tenant_id = h.tenant_id
    AND w.is_deleted = 'n' FOR SHARE;
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
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'purchase_receipt'
      AND x.receipt_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    UNION ALL
    SELECT x.id, x.product_id, x.quantity, NULL::NUMERIC,
      COALESCE(NULLIF(p.cost_price, 0), NULLIF(p.purchase_price, 0), 0),
      NULLIF(BTRIM(x.batch_no), ''), NULL::DATE,
      x.location_id
    FROM public.erp_sales_delivery_details_s_539dcf81_b x
    LEFT JOIN public.erp_products_s_539dcf81_b p
      ON p.id = x.product_id AND p.tenant_id = x.tenant_id
    WHERE p_document_type = 'sales_delivery'
      AND x.delivery_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
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
      WHERE b.id = v_location_id
        AND b.warehouse_id = h.warehouse_id
        AND b.tenant_id = h.tenant_id
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
    WHERE x.product_id = d.product_id
      AND x.warehouse_id = h.warehouse_id
      AND x.tenant_id = h.tenant_id
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
      -- 入库成本：单据单价是原币 → **先折本位币**再进库存。
      -- 后两个兜底（物料价、既有库存单价）本来就是本位币口径，不再折汇。
      v_unit_cost := COALESCE(
        NULLIF(d.receipt_unit_cost, 0) * v_exchange_rate,
        NULLIF(d.product_unit_cost, 0),
        NULLIF(inventory_unit_cost, 0), 0);
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
    ELSE
      -- 出库成本：取移动加权（已是本位币），与单据币种无关
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
        total_cost, batch_no, expiry_date, tenant_id
      ) VALUES (
        h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id,
        v_location_id,
        new_qty, new_available, 0,
        CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END,
        new_cost, normalized_batch, d.expiry_date, h.tenant_id
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
      reference_detail_id, posting_idempotency_key, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', LEFT(v_transaction_no, 50),
      public.resolve_inventory_transaction_type(
        p_document_type,
        CASE WHEN p_document_type = 'purchase_receipt' THEN 'in' ELSE 'out' END),
      h.document_date, d.product_id, h.warehouse_id, v_location_id, normalized_batch,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity ELSE -d.quantity END,
      v_unit_cost,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN d.quantity * v_unit_cost ELSE -(d.quantity * v_unit_cost) END,
      p_document_type, p_document_id, d.detail_id, p_idempotency_key,
      CASE WHEN p_document_type = 'purchase_receipt'
           THEN format('采购入库单 %s 过账', h.document_no)
           ELSE format('销售出货单 %s 过账', h.document_no) END,
      h.tenant_id
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
    -- 应付：原币金额进 amount/balance，币种与汇率从入库单继承（此前硬编码 'CNY', 1）
    INSERT INTO public.erp_payables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, supplier_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date, amount,
      paid_amount, balance, currency, exchange_rate, base_amount,
      status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.supplier_id, 'purchase_receipt',
      h.document_no, 'purchase_receipt', p_document_id, h.document_no,
      h.document_date, h.document_date, h.total_amount, 0, h.total_amount,
      h.currency, v_exchange_rate, v_base_total,
      'open',
      format('采购入库单 %s 过账自动生成', h.document_no), h.tenant_id
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
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    -- 应收：**本期新增**。此前销售出货只改状态、不生成应收，导致应收只能
    -- 财务页手工录入，币种没有来源可继承。这里与采购入库生成应付完全对称。
    IF h.customer_id IS NULL OR COALESCE(h.total_amount, 0) <= 0 THEN
      RAISE EXCEPTION 'Sales delivery requires customer and positive amount'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.erp_receivables_s_539dcf81_b (
      corp_id, emp_id, is_deleted, customer_id, doc_type, doc_no,
      source_type, source_id, source_no, doc_date, due_date,
      amount, paid_amount, balance, currency, exchange_rate, base_amount,
      status, remark, tenant_id
    ) VALUES (
      h.corp_id, actor_id::TEXT, 'n', h.customer_id, 'sales_delivery',
      h.document_no, 'sales_delivery', p_document_id, h.document_no,
      h.document_date, h.document_date,
      h.total_amount, 0, h.total_amount,
      h.currency, v_exchange_rate, v_base_total,
      'open',
      format('销售出货单 %s 过账自动生成', h.document_no), h.tenant_id
    )
    ON CONFLICT (tenant_id, source_type, source_id)
      WHERE is_deleted = 'n' AND source_type = 'sales_delivery'
        AND source_id IS NOT NULL
    DO NOTHING;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sales delivery already has an active receivable'
        USING ERRCODE = '23505';
    END IF;
    UPDATE public.erp_sales_deliveries_s_539dcf81_b
    SET status = 'posted', posting_idempotency_key = p_idempotency_key,
        reversal_idempotency_key = NULL, posted_at = NOW(),
        reversed_at = NULL, base_total_amount = v_base_total, updated_at = NOW()
    WHERE id = p_document_id;
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'idempotent', FALSE,
    'document_type', p_document_type, 'document_id', p_document_id,
    'status', 'posted', 'line_count', line_count,
    'currency', h.currency, 'exchange_rate', v_exchange_rate,
    'base_total_amount', v_base_total,
    'idempotency_key', p_idempotency_key);
END;
$function$;

-- ---------------------------------------------------------------------------
-- C. 重写 reverse_stock_document（销售出货一并作废生成的应收）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_stock_document(
  p_document_type TEXT,
  p_document_id INTEGER,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  h RECORD; t RECORD; i RECORD; ar_ap RECORD;
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
      x.status, x.reversal_idempotency_key, x.tenant_id
    INTO h FROM public.erp_purchase_receipts_s_539dcf81_b x
    WHERE x.id = p_document_id AND x.is_deleted = 'n' FOR UPDATE;
  ELSE
    SELECT x.id, x.delivery_no AS document_no, x.total_amount,
      x.status, x.reversal_idempotency_key, x.tenant_id
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

  -- 已核销/已收付的往来单据不允许反过账（采购→应付，销售→应收）
  IF p_document_type = 'purchase_receipt' THEN
    SELECT x.* INTO ar_ap FROM public.erp_payables_s_539dcf81_b x
    WHERE x.source_type = 'purchase_receipt'
      AND x.source_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated payable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) > 0
       OR ABS(COALESCE(ar_ap.balance, 0) -
              COALESCE(h.total_amount, 0)) >= 0.005 THEN
      RAISE EXCEPTION 'Payable was paid or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    SELECT x.* INTO ar_ap FROM public.erp_receivables_s_539dcf81_b x
    WHERE x.source_type = 'sales_delivery'
      AND x.source_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Generated receivable was not found' USING ERRCODE = 'P0002';
    END IF;
    IF COALESCE(ar_ap.paid_amount, 0) > 0
       OR ABS(COALESCE(ar_ap.balance, 0) -
              COALESCE(h.total_amount, 0)) >= 0.005 THEN
      RAISE EXCEPTION 'Receivable was collected or settled and cannot be reversed'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  FOR t IN
    SELECT x.* FROM public.erp_inventory_transactions_s_539dcf81_b x
    WHERE x.reference_type = p_document_type
      AND x.reference_id = p_document_id
      AND x.tenant_id = h.tenant_id
      AND x.is_deleted = 'n'
    ORDER BY x.product_id, x.warehouse_id,
             COALESCE(x.location_id, 0), x.batch_no NULLS FIRST, x.id FOR UPDATE
  LOOP
    line_count := line_count + 1;
    normalized_batch := NULLIF(BTRIM(t.batch_no), '');
    PERFORM pg_advisory_xact_lock(hashtextextended(
      format('erp_inventory:%s:%s:%s:%s', t.product_id, t.warehouse_id,
        COALESCE(t.location_id, 0), COALESCE(normalized_batch, '')), 0));
    SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
    WHERE x.product_id = t.product_id
      AND x.warehouse_id = t.warehouse_id
      AND x.tenant_id = t.tenant_id
      AND COALESCE(x.location_id, 0) = COALESCE(t.location_id, 0)
      AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') =
          COALESCE(normalized_batch, '')
      AND x.is_deleted = 'n' FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Inventory missing for transaction %, product %, warehouse %, location %',
        t.id, t.product_id, t.warehouse_id, COALESCE(t.location_id, 0)
        USING ERRCODE = 'P0002';
    END IF;

    -- 按流水行自身的成本反向加减 → 天然按原始汇率回冲，无需再折汇
    new_qty := COALESCE(i.quantity, 0) - COALESCE(t.quantity, 0);
    new_available := COALESCE(i.available_quantity, 0) -
      COALESCE(t.quantity, 0);
    new_cost := COALESCE(i.total_cost, 0) - COALESCE(t.total_cost, 0);

    SELECT COALESCE(w.is_negative_stock_allowed, FALSE)
      INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w
      WHERE w.id = t.warehouse_id
        AND w.tenant_id = t.tenant_id
        AND w.is_deleted = 'n' FOR SHARE;
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
    AND reference_id = p_document_id
    AND tenant_id = h.tenant_id
    AND is_deleted = 'n';

  IF p_document_type = 'purchase_receipt' THEN
    UPDATE public.erp_payables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
    UPDATE public.erp_purchase_receipts_s_539dcf81_b
    SET status = 'approved', reversal_idempotency_key = p_idempotency_key,
        reversed_at = NOW(), updated_at = NOW()
    WHERE id = p_document_id;
  ELSE
    UPDATE public.erp_receivables_s_539dcf81_b
    SET is_deleted = 'y', status = 'cancelled', updated_at = NOW()
    WHERE id = ar_ap.id;
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
$function$;

-- ---------------------------------------------------------------------------
-- D. 流转字段映射补币种
--    PO → 采购入库 / SO → 销售出货 三个表头字段随单流转。
--    生产订单 → 生产领料**不加**：领料成本取库存移动加权（本位币），无原币维度。
--    用 ON CONFLICT 兜住 uq_doc_flow_field_map(rule_id, map_level, target_field)。
-- ---------------------------------------------------------------------------
INSERT INTO public.doc_flow_field_maps (
  rule_id, map_level, target_field, source_type, source_field,
  is_required, sequence_no, is_deleted, tenant_id
)
SELECT r.id, 'header', v.target_field, 'field', v.source_field,
       FALSE, v.seq, 'n', NULL
FROM public.doc_flow_rules r
CROSS JOIN (
  VALUES ('currency', 'currency', 100),
         ('exchange_rate', 'exchange_rate', 101),
         ('base_total_amount', 'base_total_amount', 102)
) AS v(target_field, source_field, seq)
WHERE r.rule_code IN ('purchase_order_to_receipt', 'sales_order_to_delivery')
ON CONFLICT (rule_id, map_level, target_field) DO UPDATE
SET source_type  = 'field',
    source_field = EXCLUDED.source_field,
    is_deleted   = 'n',
    updated_at   = NOW();

-- ---------------------------------------------------------------------------
-- E. fail-loud 自检
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_map_count INTEGER;
  v_pr_body TEXT;
  v_rs_body TEXT;
  v_payable_idx TEXT;
BEGIN
  -- E1. 流转映射：2 条规则 x 3 个字段 = 6 条
  SELECT count(*) INTO v_map_count
  FROM public.doc_flow_field_maps m
    JOIN public.doc_flow_rules r ON r.id = m.rule_id
  WHERE m.is_deleted = 'n'
    AND m.map_level = 'header'
    AND m.target_field IN ('currency', 'exchange_rate', 'base_total_amount')
    AND r.rule_code IN ('purchase_order_to_receipt', 'sales_order_to_delivery');
  IF v_map_count <> 6 THEN
    RAISE EXCEPTION
      '[deploy_69] 自检失败：流转字段映射应有 6 条，实际 % 条', v_map_count;
  END IF;

  -- E2. 新版函数体确实生效（用 tenant_id 收敛作为指纹）
  SELECT prosrc INTO v_pr_body FROM pg_proc WHERE proname = 'post_stock_document';
  IF v_pr_body IS NULL OR v_pr_body NOT LIKE '%h.tenant_id%'
     OR v_pr_body NOT LIKE '%v_exchange_rate%' THEN
    RAISE EXCEPTION '[deploy_69] 自检失败：post_stock_document 未更新为折汇版本';
  END IF;
  IF v_pr_body NOT LIKE '%erp_receivables_s_539dcf81_b%' THEN
    RAISE EXCEPTION '[deploy_69] 自检失败：post_stock_document 未包含应收自动生成';
  END IF;

  SELECT prosrc INTO v_rs_body FROM pg_proc WHERE proname = 'reverse_stock_document';
  IF v_rs_body IS NULL OR v_rs_body NOT LIKE '%erp_receivables_s_539dcf81_b%' THEN
    RAISE EXCEPTION '[deploy_69] 自检失败：reverse_stock_document 未包含应收作废';
  END IF;

  -- E3. 应付/应收的幂等索引必须含 tenant_id
  SELECT indexdef INTO v_payable_idx FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'uq_erp_payables_active_purchase_receipt';
  IF v_payable_idx IS NULL OR v_payable_idx NOT LIKE '%tenant_id%' THEN
    RAISE EXCEPTION
      '[deploy_69] 自检失败：应付幂等唯一索引未带 tenant_id（多租户会互撞）';
  END IF;

  RAISE NOTICE
    '[deploy_69] 自检通过：过账折本位币、AR/AP 继承币种、SO→应收已就位（映射 % 条）',
    v_map_count;
END $$;

\echo '[deploy_69] 完成。'
