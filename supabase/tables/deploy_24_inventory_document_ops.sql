-- Inventory transfer, stock count, and stock adjustment documents.
-- This script adds the document tables and transactional posting RPCs.

CREATE TABLE IF NOT EXISTS public.erp_inventory_transfers_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transfer_no VARCHAR(50) NOT NULL UNIQUE,
  transfer_date DATE NOT NULL,
  from_warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
  to_warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
  from_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  to_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  remark TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_inventory_transfers_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_inventory_transfers_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_inventory_transfers_s_539dcf81_b');

CREATE TABLE IF NOT EXISTS public.erp_inventory_transfer_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  transfer_id INTEGER NOT NULL REFERENCES public.erp_inventory_transfers_s_539dcf81_b(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
  from_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  to_location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  batch_no VARCHAR(50),
  remark TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_inventory_transfer_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_inventory_transfer_details_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_inventory_transfer_details_s_539dcf81_b');

CREATE TABLE IF NOT EXISTS public.erp_stock_counts_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count_no VARCHAR(50) NOT NULL UNIQUE,
  count_date DATE NOT NULL,
  warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
  location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  remark TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_stock_counts_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_stock_counts_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_stock_counts_s_539dcf81_b');

CREATE TABLE IF NOT EXISTS public.erp_stock_count_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count_id INTEGER NOT NULL REFERENCES public.erp_stock_counts_s_539dcf81_b(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
  location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  batch_no VARCHAR(50),
  system_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  counted_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  difference_quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  remark TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_stock_count_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_stock_count_details_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_stock_count_details_s_539dcf81_b');

CREATE TABLE IF NOT EXISTS public.erp_stock_adjustments_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adjust_no VARCHAR(50) NOT NULL UNIQUE,
  adjust_date DATE NOT NULL,
  warehouse_id INTEGER REFERENCES public.erp_warehouses_s_539dcf81_b(id),
  location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  reason TEXT,
  remark TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  approved_at TIMESTAMP,
  approved_by INTEGER,
  posting_idempotency_key UUID,
  reversal_idempotency_key UUID,
  posted_at TIMESTAMPTZ,
  reversed_at TIMESTAMPTZ
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_stock_adjustments_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_stock_adjustments_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_stock_adjustments_s_539dcf81_b');

CREATE TABLE IF NOT EXISTS public.erp_stock_adjustment_details_s_539dcf81_b (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  adjust_id INTEGER NOT NULL REFERENCES public.erp_stock_adjustments_s_539dcf81_b(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  product_id INTEGER REFERENCES public.erp_products_s_539dcf81_b(id),
  location_id INTEGER REFERENCES public.erp_bins_s_539dcf81_b(id),
  batch_no VARCHAR(50),
  direction VARCHAR(10) NOT NULL DEFAULT 'in',
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit_cost DECIMAL(18,4) NOT NULL DEFAULT 0,
  remark TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_stock_adjustment_details_s_539dcf81_b TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.erp_stock_adjustment_details_s_539dcf81_b_id_seq TO authenticated;
SELECT public.install_role_table_rls('erp_stock_adjustment_details_s_539dcf81_b');

CREATE INDEX IF NOT EXISTS idx_inventory_transfer_details_transfer_id
  ON public.erp_inventory_transfer_details_s_539dcf81_b(transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_count_details_count_id
  ON public.erp_stock_count_details_s_539dcf81_b(count_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustment_details_adjust_id
  ON public.erp_stock_adjustment_details_s_539dcf81_b(adjust_id);

CREATE OR REPLACE FUNCTION public.post_inventory_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  h RECORD; d RECORD; i RECORD;
  actor_id INTEGER; line_count INTEGER := 0;
  old_qty NUMERIC; old_available NUMERIC; old_cost NUMERIC;
  new_qty NUMERIC; new_available NUMERIC; new_cost NUMERIC;
  v_unit_cost NUMERIC; normalized_batch TEXT; allow_negative BOOLEAN;
BEGIN
  IF p_document_id IS NULL OR p_document_id <= 0 OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'A positive document ID and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  actor_id := public.current_sys_user_id();

  IF p_document_type = 'inventory_transfer' THEN
    SELECT * INTO h FROM public.erp_inventory_transfers_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT * INTO h FROM public.erp_stock_counts_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSIF p_document_type = 'stock_adjustment' THEN
    SELECT * INTO h FROM public.erp_stock_adjustments_s_539dcf81_b WHERE id = p_document_id AND is_deleted = 'n' FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unsupported inventory document type: %', p_document_type USING ERRCODE = '22023';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory document does not exist or is deleted' USING ERRCODE = 'P0002';
  END IF;
  IF h.status = 'posted' AND h.posting_idempotency_key = p_idempotency_key THEN
    RETURN jsonb_build_object('ok', TRUE, 'idempotent', TRUE, 'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted');
  END IF;
  IF h.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved documents can be posted; current status: %', COALESCE(h.status, '<null>') USING ERRCODE = '55000';
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    IF h.from_warehouse_id IS NULL OR h.to_warehouse_id IS NULL THEN
      RAISE EXCEPTION 'Transfer requires both warehouses' USING ERRCODE = '23502';
    END IF;
    IF h.from_warehouse_id = h.to_warehouse_id THEN
      RAISE EXCEPTION 'Transfer warehouses must be different' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_document_type = 'inventory_transfer' THEN
    FOR d IN SELECT * FROM public.erp_inventory_transfer_details_s_539dcf81_b WHERE transfer_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
      WHERE x.product_id = d.product_id AND x.warehouse_id = h.from_warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.from_location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      IF NOT FOUND OR COALESCE(i.available_quantity, 0) < d.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for transfer line %, product %', d.line_no, d.product_id USING ERRCODE = '23514';
      END IF;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      new_qty := old_qty - d.quantity;
      new_available := old_available - d.quantity;
      new_cost := old_cost - d.quantity * v_unit_cost;
      UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), 'transfer_out', h.transfer_date, d.product_id, h.from_warehouse_id, COALESCE(d.from_location_id, h.from_location_id), normalized_batch, -d.quantity, v_unit_cost, -(d.quantity * v_unit_cost), 'inventory_transfer_out', p_document_id, d.id, p_idempotency_key, '库存调拨出库');

      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.to_warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.to_location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      IF FOUND THEN
        old_qty := COALESCE(i.quantity, 0);
        old_available := COALESCE(i.available_quantity, 0);
        old_cost := COALESCE(i.total_cost, 0);
      ELSE
        old_qty := 0; old_available := 0; old_cost := 0;
      END IF;
      new_qty := old_qty + d.quantity;
      new_available := old_available + d.quantity;
      new_cost := old_cost + d.quantity * v_unit_cost;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.to_warehouse_id, COALESCE(d.to_location_id, h.to_location_id), new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0') || 'T', 50), 'transfer_in', h.transfer_date, d.product_id, h.to_warehouse_id, COALESCE(d.to_location_id, h.to_location_id), normalized_batch, d.quantity, v_unit_cost, d.quantity * v_unit_cost, 'inventory_transfer_in', p_document_id, d.id, p_idempotency_key, '库存调拨入库');
    END LOOP;
    UPDATE public.erp_inventory_transfers_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  ELSIF p_document_type = 'stock_count' THEN
    SELECT COALESCE(w.is_negative_stock_allowed, FALSE) INTO allow_negative FROM public.erp_warehouses_s_539dcf81_b w WHERE w.id = h.warehouse_id AND w.is_deleted = 'n' FOR SHARE;
    FOR d IN SELECT * FROM public.erp_stock_count_details_s_539dcf81_b WHERE count_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      new_qty := COALESCE(d.counted_quantity, 0);
      new_available := new_qty;
      new_cost := new_qty * v_unit_cost;
      IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
        RAISE EXCEPTION 'Count result cannot be negative' USING ERRCODE = '23514';
      END IF;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / NULLIF(new_qty, 0)) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id, h.location_id, new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), CASE WHEN new_qty >= old_qty THEN 'stock_count_increase' ELSE 'stock_count_decrease' END, h.count_date, d.product_id, h.warehouse_id, COALESCE(d.location_id, h.location_id), normalized_batch, new_qty - old_qty, v_unit_cost, (new_qty - old_qty) * v_unit_cost, p_document_type, p_document_id, d.id, p_idempotency_key, '库存盘点差异');
    END LOOP;
    UPDATE public.erp_stock_counts_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  ELSE
    FOR d IN SELECT * FROM public.erp_stock_adjustment_details_s_539dcf81_b WHERE adjust_id = p_document_id AND is_deleted = 'n' ORDER BY line_no LOOP
      line_count := line_count + 1;
      normalized_batch := NULLIF(BTRIM(d.batch_no), '');
      SELECT x.* INTO i FROM public.erp_inventory_s_539dcf81_b x
        WHERE x.product_id = d.product_id AND x.warehouse_id = h.warehouse_id
          AND COALESCE(x.location_id, 0) = COALESCE(h.location_id, 0)
          AND COALESCE(NULLIF(BTRIM(x.batch_no), ''), '') = COALESCE(normalized_batch, '')
          AND x.is_deleted = 'n' FOR UPDATE;
      old_qty := COALESCE(i.quantity, 0);
      old_available := COALESCE(i.available_quantity, 0);
      old_cost := COALESCE(i.total_cost, 0);
      v_unit_cost := COALESCE(NULLIF(i.unit_cost, 0), NULLIF(d.unit_cost, 0), 0);
      IF d.direction = 'out' THEN
        new_qty := old_qty - d.quantity;
        new_available := old_available - d.quantity;
        new_cost := old_cost - d.quantity * v_unit_cost;
        IF NOT allow_negative AND (new_qty < 0 OR new_available < 0) THEN
          RAISE EXCEPTION 'Insufficient stock for adjustment line %', d.line_no USING ERRCODE = '23514';
        END IF;
      ELSE
        new_qty := old_qty + d.quantity;
        new_available := old_available + d.quantity;
        new_cost := old_cost + d.quantity * v_unit_cost;
      END IF;
      IF FOUND THEN
        UPDATE public.erp_inventory_s_539dcf81_b SET quantity = new_qty, available_quantity = new_available, unit_cost = CASE WHEN new_qty = 0 THEN v_unit_cost ELSE ABS(new_cost / new_qty) END, total_cost = new_cost, updated_at = NOW() WHERE id = i.id;
      ELSE
        INSERT INTO public.erp_inventory_s_539dcf81_b(corp_id, emp_id, is_deleted, product_id, warehouse_id, location_id, quantity, available_quantity, locked_quantity, unit_cost, total_cost, batch_no)
        VALUES (h.corp_id, actor_id::TEXT, 'n', d.product_id, h.warehouse_id, h.location_id, new_qty, new_available, 0, v_unit_cost, new_cost, normalized_batch);
      END IF;
      INSERT INTO public.erp_inventory_transactions_s_539dcf81_b(corp_id, emp_id, is_deleted, transaction_no, transaction_type, transaction_date, product_id, warehouse_id, location_id, batch_no, quantity, unit_cost, total_cost, reference_type, reference_id, reference_detail_id, posting_idempotency_key, remark)
      VALUES (h.corp_id, actor_id::TEXT, 'n', LEFT('IT' || TO_CHAR(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || LPAD(d.id::TEXT, 6, '0'), 50), CASE WHEN d.direction = 'out' THEN 'stock_adjust_out' ELSE 'stock_adjust_in' END, h.adjust_date, d.product_id, h.warehouse_id, COALESCE(d.location_id, h.location_id), normalized_batch, CASE WHEN d.direction = 'out' THEN -d.quantity ELSE d.quantity END, v_unit_cost, CASE WHEN d.direction = 'out' THEN -(d.quantity * v_unit_cost) ELSE d.quantity * v_unit_cost END, p_document_type, p_document_id, d.id, p_idempotency_key, '库存调整');
    END LOOP;
    UPDATE public.erp_stock_adjustments_s_539dcf81_b SET status = 'posted', posted_at = NOW(), posting_idempotency_key = p_idempotency_key, updated_at = NOW() WHERE id = p_document_id;
  END IF;

  IF line_count = 0 THEN
    RAISE EXCEPTION 'No detail rows found for document' USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('ok', TRUE, 'document_type', p_document_type, 'document_id', p_document_id, 'status', 'posted', 'line_count', line_count);
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_inventory_document(
  p_document_type TEXT, p_document_id INTEGER, p_idempotency_key UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Reverse inventory document is not implemented yet';
END;
$$;

INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order)
VALUES
  ('inventory_transfer', '库存调拨', 'inventory', '/inventory/transfers', 'erp_inventory_transfers_s_539dcf81_b', 'TR{YYYY}{####}', 35),
  ('stock_count', '库存盘点', 'inventory', '/inventory/stock-counts', 'erp_stock_counts_s_539dcf81_b', 'SC{YYYY}{####}', 36),
  ('stock_adjustment', '库存调整', 'inventory', '/inventory/stock-adjustments', 'erp_stock_adjustments_s_539dcf81_b', 'SA{YYYY}{####}', 37)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code = EXCLUDED.module_code,
  route_path = EXCLUDED.route_path,
  table_name = EXCLUDED.table_name,
  naming_rule = EXCLUDED.naming_rule,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

REVOKE ALL ON FUNCTION public.post_inventory_document(TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_inventory_document(TEXT, INTEGER, UUID) TO authenticated;
