-- Generalises the conversion engine so it is driven by metadata instead of
-- hard-coded document types.
--
-- Before this file the ledger knew exactly two things: a purchase order and a
-- purchase receipt. Every new link would have meant copying
-- doc_flow_ledger_convert, doc_flow_sync_source_progress and the receipt trigger
-- once more, and any target line typed by hand would silently skip the ledger
-- (i.e. the overrun this ledger exists to prevent).
--
-- What changes:
--   1. doc_flow_source_meta  - per source document type: parent field, quantity
--      field, progress field and the status vocabulary to write back.
--   2. doc_flow_ledger_convert / doc_flow_sync_source_progress now read that
--      metadata instead of branching on a document type literal.
--   3. doc_flow_ledger_on_target_detail - one generic ledger trigger, installed
--      on every target detail table. It resolves the rule from the firing table
--      and validates the referenced source line really exists, so hand-keyed
--      lines and generated lines keep taking the identical path.

CREATE TABLE IF NOT EXISTS public.doc_flow_source_meta (
  source_document_type VARCHAR(100) PRIMARY KEY
    REFERENCES public.sys_document_types(document_type) ON DELETE CASCADE,
  parent_field VARCHAR(100) NOT NULL DEFAULT 'order_id',
  quantity_field VARCHAR(100) NOT NULL DEFAULT 'quantity',
  progress_field VARCHAR(100) NOT NULL DEFAULT 'received_quantity',
  sync_status BOOLEAN NOT NULL DEFAULT TRUE,
  none_status VARCHAR(30) NOT NULL DEFAULT 'approved',
  partial_status VARCHAR(30) NOT NULL DEFAULT 'partially_received',
  full_status VARCHAR(30) NOT NULL DEFAULT 'received',
  remark TEXT
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_flow_source_meta TO authenticated;
ALTER TABLE public.doc_flow_source_meta ENABLE ROW LEVEL SECURITY;
SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('doc_flow_source_meta');

INSERT INTO public.doc_flow_source_meta (
  source_document_type, parent_field, quantity_field, progress_field,
  sync_status, none_status, partial_status, full_status, remark
) VALUES
  ('purchase_order', 'order_id', 'quantity', 'received_quantity', TRUE,
   'approved', 'partially_received', 'received', '采购订单：按已收数量回写'),
  ('sales_order', 'order_id', 'quantity', 'delivered_quantity', TRUE,
   'approved', 'partially_delivered', 'delivered', '销售订单：按已出数量回写'),
  ('production_order', 'order_id', 'planned_quantity', 'issued_quantity', FALSE,
   'released', 'in_progress', 'completed', '生产订单：状态语义由车间流程控制，暂不自动同步')
ON CONFLICT (source_document_type) DO NOTHING;

-- Resolves a conversion rule from the detail table that fired the trigger.
-- Several rules may share one target table (receipt -> quality inspection,
-- receipt -> payable), so the deciding test is whether the referenced line
-- actually exists in that rule's source detail table.
CREATE OR REPLACE FUNCTION public.doc_flow_rule_for_detail(
  p_table_name TEXT,
  p_row JSONB,
  OUT rule_row public.doc_flow_rules,
  OUT source_detail_id INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate public.doc_flow_rules;
  v_ref INTEGER;
  v_exists BOOLEAN;
  v_source_detail_table TEXT;
BEGIN
  FOR v_candidate IN
    SELECT r.* FROM public.doc_flow_rules r
    WHERE r.is_deleted = 'n'
      AND r.target_source_ref_field IS NOT NULL
      AND public.doc_flow_detail_table(r.target_document_type) = p_table_name
    ORDER BY r.id
  LOOP
    v_ref := NULLIF(p_row ->> v_candidate.target_source_ref_field, '')::INTEGER;
    CONTINUE WHEN v_ref IS NULL;

    v_source_detail_table := public.doc_flow_detail_table(v_candidate.source_document_type);
    CONTINUE WHEN v_source_detail_table IS NULL;

    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I d WHERE d.id = $1)',
      v_source_detail_table
    ) INTO v_exists USING v_ref;

    IF v_exists THEN
      rule_row := v_candidate;
      source_detail_id := v_ref;
      RETURN;
    END IF;
  END LOOP;

  rule_row := NULL;
  source_detail_id := NULL;
  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_rule_for_detail(TEXT, JSONB) TO authenticated;

-- Ledger writer. Now metadata driven: the source detail table is derived from
-- the document type and the three field names come from doc_flow_source_meta.
CREATE OR REPLACE FUNCTION public.doc_flow_ledger_convert(
  p_source_document_type TEXT,
  p_source_detail_id INTEGER,
  p_target_document_type TEXT,
  p_target_document_id INTEGER,
  p_target_detail_id INTEGER,
  p_quantity NUMERIC,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta public.doc_flow_source_meta;
  v_detail_table TEXT;
  v_source_document_id INTEGER;
  v_allowed NUMERIC;
  v_transferred NUMERIC;
BEGIN
  IF p_source_detail_id IS NULL OR COALESCE(p_quantity, 0) = 0 THEN RETURN; END IF;

  SELECT * INTO v_meta
  FROM public.doc_flow_source_meta
  WHERE source_document_type = p_source_document_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No source metadata registered for %: add a row to doc_flow_source_meta',
      p_source_document_type;
  END IF;

  v_detail_table := public.doc_flow_detail_table(p_source_document_type);
  IF v_detail_table IS NULL THEN
    RAISE EXCEPTION 'Document type % is missing a detail table', p_source_document_type;
  END IF;

  EXECUTE format(
    'SELECT d.%I, COALESCE(d.%I, 0)
     FROM public.%I d WHERE d.id = $1 FOR UPDATE',
    v_meta.parent_field, v_meta.quantity_field, v_detail_table
  ) INTO v_source_document_id, v_allowed USING p_source_detail_id;

  IF v_source_document_id IS NULL THEN
    RAISE EXCEPTION 'Source document line %/% does not exist',
      p_source_document_type, p_source_detail_id;
  END IF;

  IF p_quantity > 0 THEN
    v_transferred := public.doc_flow_transferred_qty(p_source_detail_id);
    IF v_transferred + p_quantity > v_allowed + 0.0000001 THEN
      RAISE EXCEPTION 'Exceeds remaining quantity on source line %: remaining %, requested %',
        p_source_detail_id, (v_allowed - v_transferred), p_quantity
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO public.doc_flow_transfers (
    source_document_type, source_document_id, source_detail_id,
    target_document_type, target_document_id, target_detail_id,
    quantity, transfer_kind, reason
  ) VALUES (
    p_source_document_type, v_source_document_id, p_source_detail_id,
    p_target_document_type, p_target_document_id, p_target_detail_id,
    p_quantity, 'convert', p_reason
  );

  PERFORM public.doc_flow_sync_source_progress(p_source_document_type, p_source_detail_id);
END;
$$;

-- Status vocabulary comes from the metadata too, so a production order can keep
-- its own statuses instead of being forced into the purchase ones.
CREATE OR REPLACE FUNCTION public.doc_flow_sync_order_status(
  p_source_document_type TEXT,
  p_source_document_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta public.doc_flow_source_meta;
  v_header_table TEXT;
  v_detail_table TEXT;
  v_status TEXT;
  v_exists BOOLEAN;
BEGIN
  SELECT * INTO v_meta
  FROM public.doc_flow_source_meta
  WHERE source_document_type = p_source_document_type;
  IF NOT FOUND OR NOT v_meta.sync_status THEN RETURN; END IF;

  SELECT table_name INTO v_header_table
  FROM public.sys_document_types
  WHERE document_type = p_source_document_type AND is_deleted = 'n';
  v_detail_table := public.doc_flow_detail_table(p_source_document_type);
  IF v_header_table IS NULL OR v_detail_table IS NULL THEN RETURN; END IF;

  EXECUTE format(
    'SELECT CASE
       WHEN COUNT(*) = 0 THEN %L
       WHEN BOOL_AND(COALESCE(d.%I, 0) >= COALESCE(d.%I, 0)) THEN %L
       WHEN BOOL_OR(COALESCE(d.%I, 0) > 0) THEN %L
       ELSE %L
     END, COUNT(*) > 0
     FROM public.%I d
     WHERE d.%I = $1 AND d.is_deleted = %L',
    v_meta.none_status,
    v_meta.progress_field, v_meta.quantity_field, v_meta.full_status,
    v_meta.progress_field, v_meta.partial_status, v_meta.none_status,
    v_detail_table, v_meta.parent_field, 'n'
  ) INTO v_status, v_exists USING p_source_document_id;

  IF v_exists THEN
    EXECUTE format(
      'UPDATE public.%I SET status = $1, updated_at = NOW() WHERE id = $2',
      v_header_table
    ) USING v_status, p_source_document_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_sync_order_status(TEXT, INTEGER) TO authenticated;

-- Kept for backwards compatibility with the purchase-order call sites.
CREATE OR REPLACE FUNCTION public.doc_flow_sync_order_status(p_order_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.doc_flow_sync_order_status('purchase_order', p_order_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.doc_flow_sync_source_progress(
  p_source_document_type TEXT,
  p_source_detail_id INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_meta public.doc_flow_source_meta;
  v_detail_table TEXT;
  v_transferred NUMERIC;
  v_source_document_id INTEGER;
BEGIN
  IF p_source_detail_id IS NULL THEN RETURN; END IF;

  SELECT * INTO v_meta
  FROM public.doc_flow_source_meta
  WHERE source_document_type = p_source_document_type;
  IF NOT FOUND THEN RETURN; END IF;

  v_detail_table := public.doc_flow_detail_table(p_source_document_type);
  IF v_detail_table IS NULL THEN RETURN; END IF;

  v_transferred := public.doc_flow_transferred_qty(p_source_detail_id);

  EXECUTE format(
    'UPDATE public.%I d SET %I = $1, updated_at = NOW()
     WHERE d.id = $2 RETURNING d.%I',
    v_detail_table, v_meta.progress_field, v_meta.parent_field
  ) INTO v_source_document_id USING v_transferred, p_source_detail_id;

  IF v_meta.sync_status AND v_source_document_id IS NOT NULL THEN
    PERFORM public.doc_flow_sync_order_status(p_source_document_type, v_source_document_id);
  END IF;
END;
$$;

-- One trigger for every target detail table. Hand-keyed lines and generated
-- lines now share exactly one accounting path and cannot disagree.
CREATE OR REPLACE FUNCTION public.doc_flow_ledger_on_target_detail()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result RECORD;
  v_rule public.doc_flow_rules;
  v_ref INTEGER;
  v_old_ref INTEGER;
  v_parent INTEGER;
  v_qty NUMERIC;
  v_old_qty NUMERIC;
  v_delta NUMERIC;
  v_row JSONB;
BEGIN
  SELECT * INTO v_result
  FROM public.doc_flow_rule_for_detail(TG_TABLE_NAME, to_jsonb(COALESCE(NEW, OLD)));

  v_rule := v_result.rule_row;
  v_ref := v_result.source_detail_id;
  IF v_rule.id IS NULL OR v_ref IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.is_deleted <> 'n' THEN RETURN NEW; END IF;
    v_row := to_jsonb(NEW);
    v_parent := NULLIF(v_row ->> v_rule.target_detail_parent_field, '')::INTEGER;
    v_qty := COALESCE(NULLIF(v_row ->> v_rule.target_quantity_field, '')::NUMERIC, 0);
    PERFORM public.doc_flow_ledger_convert(
      v_rule.source_document_type, v_ref, v_rule.target_document_type,
      v_parent, NEW.id, v_qty, 'target line created');
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'target line deleted');
    RETURN OLD;
  END IF;

  v_old_ref := NULLIF(to_jsonb(OLD) ->> v_rule.target_source_ref_field, '')::INTEGER;

  IF OLD.is_deleted = 'n' AND NEW.is_deleted = 'y' THEN
    PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'target line voided');
    RETURN NEW;
  END IF;

  IF OLD.is_deleted = 'y' AND NEW.is_deleted = 'n' THEN
    v_row := to_jsonb(NEW);
    v_parent := NULLIF(v_row ->> v_rule.target_detail_parent_field, '')::INTEGER;
    v_qty := COALESCE(NULLIF(v_row ->> v_rule.target_quantity_field, '')::NUMERIC, 0);
    PERFORM public.doc_flow_ledger_convert(
      v_rule.source_document_type, v_ref, v_rule.target_document_type,
      v_parent, NEW.id, v_qty, 'target line restored');
    RETURN NEW;
  END IF;

  IF COALESCE(v_ref, 0) <> COALESCE(v_old_ref, 0) THEN
    PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'source line reassigned');
    v_row := to_jsonb(NEW);
    v_parent := NULLIF(v_row ->> v_rule.target_detail_parent_field, '')::INTEGER;
    v_qty := COALESCE(NULLIF(v_row ->> v_rule.target_quantity_field, '')::NUMERIC, 0);
    IF v_ref IS NOT NULL THEN
      PERFORM public.doc_flow_ledger_convert(
        v_rule.source_document_type, v_ref, v_rule.target_document_type,
        v_parent, NEW.id, v_qty, 'source line reassigned');
    END IF;
    RETURN NEW;
  END IF;

  v_qty := COALESCE(NULLIF(to_jsonb(NEW) ->> v_rule.target_quantity_field, '')::NUMERIC, 0);
  v_old_qty := COALESCE(NULLIF(to_jsonb(OLD) ->> v_rule.target_quantity_field, '')::NUMERIC, 0);
  v_delta := v_qty - v_old_qty;
  IF v_delta <> 0 THEN
    v_row := to_jsonb(NEW);
    v_parent := NULLIF(v_row ->> v_rule.target_detail_parent_field, '')::INTEGER;
    PERFORM public.doc_flow_ledger_convert(
      v_rule.source_document_type, v_ref, v_rule.target_document_type,
      v_parent, NEW.id, v_delta, 'target line quantity adjusted');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_doc_flow_receipt_detail_ledger ON public.erp_purchase_receipt_details_s_539dcf81_b;
CREATE TRIGGER trg_doc_flow_receipt_detail_ledger
AFTER INSERT OR UPDATE OR DELETE ON public.erp_purchase_receipt_details_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.doc_flow_ledger_on_target_detail();

DROP TRIGGER IF EXISTS trg_doc_flow_delivery_detail_ledger ON public.erp_sales_delivery_details_s_539dcf81_b;
CREATE TRIGGER trg_doc_flow_delivery_detail_ledger
AFTER INSERT OR UPDATE OR DELETE ON public.erp_sales_delivery_details_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.doc_flow_ledger_on_target_detail();

DROP FUNCTION IF EXISTS public.doc_flow_ledger_on_receipt_detail();

-- Generic backfill: any target document type, not just receipts.
CREATE OR REPLACE FUNCTION public.doc_flow_backfill_targets(p_target_document_type TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule RECORD;
  v_detail_table TEXT;
  v_row RECORD;
  v_line RECORD;
  v_src_detail_table TEXT;
  v_src_document_id INTEGER;
  v_meta RECORD;
  v_count INTEGER := 0;
BEGIN
  SELECT r.* INTO v_rule
  FROM public.doc_flow_rules r
  WHERE r.target_document_type = p_target_document_type
    AND r.is_deleted = 'n'
    AND r.target_source_ref_field IS NOT NULL
  ORDER BY r.id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No conversion rule for target %', p_target_document_type;
  END IF;

  SELECT * INTO v_meta FROM public.doc_flow_source_meta
  WHERE source_document_type = v_rule.source_document_type;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No source metadata for %', v_rule.source_document_type;
  END IF;

  v_detail_table := public.doc_flow_detail_table(p_target_document_type);
  v_src_detail_table := public.doc_flow_detail_table(v_rule.source_document_type);

  FOR v_row IN EXECUTE format(
    'SELECT to_jsonb(d) AS j FROM public.%I d
     WHERE d.is_deleted = %L AND d.%I IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.doc_flow_transfers t
         WHERE t.target_detail_id = d.id AND t.is_deleted = %L)
     ORDER BY d.id',
    v_detail_table, 'n', v_rule.target_source_ref_field, 'n'
  )
  LOOP
    v_src_document_id := NULL;
    CONTINUE WHEN NULLIF(v_row.j ->> v_rule.target_detail_parent_field, '') IS NULL;

    EXECUTE format('SELECT d.%I FROM public.%I d WHERE d.id = $1',
      v_meta.parent_field, v_src_detail_table)
      INTO v_src_document_id
      USING (v_row.j ->> v_rule.target_source_ref_field)::INTEGER;

    IF v_src_document_id IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.doc_flow_transfers (
      source_document_type, source_document_id, source_detail_id,
      target_document_type, target_document_id, target_detail_id,
      quantity, transfer_kind, reason
    ) VALUES (
      v_rule.source_document_type, v_src_document_id,
      (v_row.j ->> v_rule.target_source_ref_field)::INTEGER,
      p_target_document_type,
      NULLIF(v_row.j ->> v_rule.target_detail_parent_field, '')::INTEGER,
      (v_row.j ->> 'id')::INTEGER,
      COALESCE(NULLIF(v_row.j ->> v_rule.target_quantity_field, '')::NUMERIC, 0),
      'convert', 'backfill: pre-existing target line'
    );
    v_count := v_count + 1;
  END LOOP;

  FOR v_line IN
    SELECT DISTINCT source_detail_id FROM public.doc_flow_transfers
    WHERE is_deleted = 'n' AND source_detail_id IS NOT NULL
  LOOP
    PERFORM public.doc_flow_sync_source_progress(v_rule.source_document_type, v_line.source_detail_id);
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_backfill_targets(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.doc_flow_backfill_receipts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN public.doc_flow_backfill_targets('purchase_receipt');
END;
$$;

-- sales_order -> sales_delivery
INSERT INTO public.doc_flow_rules (
  rule_code, rule_name, source_document_type, target_document_type,
  source_quantity_field, target_quantity_field, source_detail_key_field, target_source_ref_field,
  source_detail_parent_field, target_no_field, target_detail_parent_field,
  target_initial_status, allow_partial, require_source_approved, description
)
VALUES (
  'sales_order_to_delivery', '销售订单生成销售出货', 'sales_order', 'sales_delivery',
  'quantity', 'quantity', 'id', 'order_detail_id',
  'order_id', 'delivery_no', 'delivery_id',
  'draft', TRUE, TRUE, '按销售订单未出货数量生成销售出货单，支持分批发货'
)
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO public.doc_flow_field_maps (
  rule_id, map_level, target_field, source_type, source_field, const_value, sequence_no
)
SELECT r.id, x.map_level, x.target_field, x.source_type, x.source_field, x.const_value, x.sequence_no
FROM public.doc_flow_rules r
CROSS JOIN (VALUES
  ('header', 'delivery_date', 'sys',   'today',        NULL,    10),
  ('header', 'customer_id',   'field', 'customer_id',  NULL,    20),
  ('header', 'order_id',      'sys',   'source_id',    NULL,    30),
  ('header', 'remark',        'field', 'remark',       NULL,    40),
  ('line',   'order_detail_id', 'field', 'id',         NULL,    10),
  ('line',   'product_id',    'field', 'product_id',   NULL,    20),
  ('line',   'quantity',      'field', 'quantity',     NULL,    30),
  ('line',   'unit_price',    'field', 'unit_price',   NULL,    40),
  ('line',   'amount',        'field', 'amount',       NULL,    50),
  ('line',   'remark',        'field', 'remark',       NULL,    60)
) AS x(map_level, target_field, source_type, source_field, const_value, sequence_no)
WHERE r.rule_code = 'sales_order_to_delivery'
  AND r.source_document_type = 'sales_order'
  AND r.target_document_type = 'sales_delivery'
ON CONFLICT (rule_id, map_level, target_field) DO NOTHING;
