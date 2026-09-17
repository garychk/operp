-- Document conversion engine.
--
-- Responsibilities kept OUT of the workflow engine on purpose: the workflow answers
-- "who approves and in what order", while this engine answers "what gets generated".
--
-- Three moving parts:
--   1. doc_flow_rules       - declarative source -> target conversion rule
--   2. doc_flow_field_maps  - header/line field mapping for one rule
--   3. doc_flow_transfers   - append-only quantity ledger
--
-- Ledger design decisions:
--   * Append-only. Reversal inserts a negative row pointing at the original row via
--     reversed_transfer_id. Nothing is ever physically deleted, so a source line can
--     always be audited back to every conversion and every reversal.
--   * Transferred qty = SUM(quantity) over the ledger. Negative reversal rows cancel
--     naturally, so there is no separate "active" flag to fall out of sync.
--   * The ledger is maintained by a trigger on the target detail table, NOT by the
--     generate function. Hand-keyed documents and generated documents therefore take
--     exactly the same path and cannot disagree.

CREATE TABLE IF NOT EXISTS public.doc_flow_rules (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  rule_code VARCHAR(100) NOT NULL UNIQUE,
  rule_name VARCHAR(200) NOT NULL,
  source_document_type VARCHAR(100) NOT NULL REFERENCES public.sys_document_types(document_type) ON DELETE CASCADE,
  target_document_type VARCHAR(100) NOT NULL REFERENCES public.sys_document_types(document_type) ON DELETE CASCADE,
  source_quantity_field VARCHAR(100) NOT NULL DEFAULT 'quantity',
  target_quantity_field VARCHAR(100) NOT NULL DEFAULT 'quantity',
  source_detail_key_field VARCHAR(100) NOT NULL DEFAULT 'id',
  target_source_ref_field VARCHAR(100),
  allow_partial BOOLEAN NOT NULL DEFAULT TRUE,
  require_source_approved BOOLEAN NOT NULL DEFAULT TRUE,
  target_initial_status VARCHAR(30) NOT NULL DEFAULT 'draft',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT chk_doc_flow_rules_distinct CHECK (source_document_type <> target_document_type)
);

CREATE TABLE IF NOT EXISTS public.doc_flow_field_maps (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  rule_id INTEGER NOT NULL REFERENCES public.doc_flow_rules(id) ON DELETE CASCADE,
  map_level VARCHAR(20) NOT NULL DEFAULT 'header',
  target_field VARCHAR(100) NOT NULL,
  source_type VARCHAR(20) NOT NULL DEFAULT 'field',
  source_field VARCHAR(100),
  const_value TEXT,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  sequence_no INTEGER NOT NULL DEFAULT 0,
  remark TEXT,
  CONSTRAINT chk_doc_flow_map_level CHECK (map_level IN ('header', 'line')),
  CONSTRAINT chk_doc_flow_map_source CHECK (source_type IN ('field', 'const', 'sys')),
  CONSTRAINT uq_doc_flow_field_map UNIQUE (rule_id, map_level, target_field)
);

CREATE TABLE IF NOT EXISTS public.doc_flow_transfers (
  id SERIAL PRIMARY KEY,
  corp_id VARCHAR(128),
  emp_id VARCHAR(128),
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  rule_id INTEGER REFERENCES public.doc_flow_rules(id) ON DELETE SET NULL,
  source_document_type VARCHAR(100) NOT NULL,
  source_document_id INTEGER NOT NULL,
  source_detail_id INTEGER,
  target_document_type VARCHAR(100) NOT NULL,
  target_document_id INTEGER NOT NULL,
  target_detail_id INTEGER,
  quantity NUMERIC(18, 4) NOT NULL DEFAULT 0,
  transfer_kind VARCHAR(20) NOT NULL DEFAULT 'convert',
  reversed_transfer_id INTEGER REFERENCES public.doc_flow_transfers(id),
  reason TEXT,
  CONSTRAINT chk_doc_flow_transfer_kind CHECK (transfer_kind IN ('convert', 'reverse'))
);

CREATE INDEX IF NOT EXISTS idx_doc_flow_transfers_source_line
  ON public.doc_flow_transfers(source_document_type, source_detail_id);
CREATE INDEX IF NOT EXISTS idx_doc_flow_transfers_target_doc
  ON public.doc_flow_transfers(target_document_type, target_document_id);
CREATE INDEX IF NOT EXISTS idx_doc_flow_transfers_target_line
  ON public.doc_flow_transfers(target_detail_id);
CREATE INDEX IF NOT EXISTS idx_doc_flow_transfers_reversed
  ON public.doc_flow_transfers(reversed_transfer_id);
CREATE INDEX IF NOT EXISTS idx_doc_flow_field_maps_rule
  ON public.doc_flow_field_maps(rule_id, map_level, sequence_no);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_flow_rules TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.doc_flow_rules_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_flow_field_maps TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.doc_flow_field_maps_id_seq TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_flow_transfers TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.doc_flow_transfers_id_seq TO authenticated;

ALTER TABLE public.doc_flow_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_flow_field_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.doc_flow_transfers ENABLE ROW LEVEL SECURITY;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('doc_flow_rules');
SELECT public.install_role_table_rls('doc_flow_field_maps');
SELECT public.install_role_table_rls('doc_flow_transfers');

-- Derive the physical child (detail) table name from the parent DocType table.
-- Header tables are plural while detail tables drop that trailing "s":
--   erp_purchase_orders_s_539dcf81_b  -> erp_purchase_order_details_s_539dcf81_b
--   erp_boms_s_539dcf81_b             -> erp_bom_details_s_539dcf81_b
-- Several candidates are probed so a future naming exception does not silently
-- produce a NULL detail table (which used to leave every line-level dropdown empty).
CREATE OR REPLACE FUNCTION public.doc_flow_detail_table(p_document_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table_name TEXT;
  v_suffix TEXT := '_s_539dcf81_b';
  v_base TEXT;
  v_candidate TEXT;
  v_candidates TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT table_name INTO v_table_name
  FROM public.sys_document_types
  WHERE document_type = p_document_type
    AND is_deleted = 'n';

  IF v_table_name IS NULL OR v_table_name = '' THEN
    RAISE EXCEPTION 'Document type % is not registered', p_document_type;
  END IF;

  v_base := v_table_name;
  IF v_base LIKE '%' || v_suffix THEN
    v_base := left(v_base, length(v_base) - length(v_suffix));
  END IF;

  -- Plural forms seen in this schema: trailing "s" (orders -> order) and
  -- "ies" -> "y" (deliveries -> delivery). Probe every candidate against the catalog.
  v_candidates := ARRAY[
    CASE WHEN v_base LIKE '%ies' THEN left(v_base, length(v_base) - 3) || 'y' ELSE NULL END,
    CASE WHEN v_base LIKE '%s' THEN left(v_base, length(v_base) - 1) ELSE NULL END,
    v_base
  ];

  FOREACH v_candidate IN ARRAY v_candidates LOOP
    CONTINUE WHEN v_candidate IS NULL;
    IF to_regclass(format('public.%I', v_candidate || '_details' || v_suffix)) IS NOT NULL THEN
      RETURN v_candidate || '_details' || v_suffix;
    END IF;
    IF to_regclass(format('public.%I', v_candidate || '_details')) IS NOT NULL THEN
      RETURN v_candidate || '_details';
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_detail_table(TEXT) TO authenticated;

-- Field list for the mapping UI. Never accepts a raw table name from the caller:
-- the table is resolved from sys_document_types, then escaped with %I.
CREATE OR REPLACE FUNCTION public.doc_flow_list_fields(
  p_document_type TEXT,
  p_level TEXT DEFAULT 'header'
)
RETURNS TABLE(field_name TEXT, data_type TEXT, is_required BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table TEXT;
BEGIN
  IF p_level = 'line' THEN
    v_table := public.doc_flow_detail_table(p_document_type);
  ELSE
    SELECT table_name INTO v_table
    FROM public.sys_document_types
    WHERE document_type = p_document_type AND is_deleted = 'n';
  END IF;

  IF v_table IS NULL OR to_regclass(format('public.%I', v_table)) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY EXECUTE format(
    'SELECT c.column_name::TEXT, c.data_type::TEXT, (c.is_nullable = %L)
     FROM information_schema.columns c
     WHERE c.table_schema = %L AND c.table_name = %L
     ORDER BY c.ordinal_position',
    'NO', 'public', v_table
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_list_fields(TEXT, TEXT) TO authenticated;

-- Resolves one mapped value. Deliberately supports no free-form expressions:
-- allowing a caller-authorised expression here would turn rule editing into
-- arbitrary code execution. Extend the 'sys' whitelist instead.
CREATE OR REPLACE FUNCTION public.doc_flow_resolve_value(
  p_source_type TEXT,
  p_source_field TEXT,
  p_const_value TEXT,
  p_source_row JSONB,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  IF p_source_type = 'field' THEN
    IF p_source_field IS NULL THEN RETURN NULL; END IF;
    RETURN p_source_row ->> p_source_field;
  ELSIF p_source_type = 'const' THEN
    RETURN p_const_value;
  ELSIF p_source_type = 'sys' THEN
    RETURN CASE p_source_field
      WHEN 'today' THEN to_char(CURRENT_DATE, 'YYYY-MM-DD')
      WHEN 'now' THEN to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
      WHEN 'current_user_id' THEN public.current_sys_user_id()::TEXT
      WHEN 'source_id' THEN p_context ->> 'source_id'
      WHEN 'source_no' THEN p_context ->> 'source_no'
      ELSE NULL
    END;
  END IF;
  RETURN NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_resolve_value(TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated;

-- Resolves a single already-stored mapping by target field name. Used when one field's value
-- is needed while building another (unit price feeds the recomputed line amount).
CREATE OR REPLACE FUNCTION public.doc_flow_get_map_value(
  p_rule_id INTEGER,
  p_map_level TEXT,
  p_target_field TEXT,
  p_source_row JSONB,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_map RECORD;
BEGIN
  SELECT source_type, source_field, const_value INTO v_map
  FROM public.doc_flow_field_maps
  WHERE rule_id = p_rule_id
    AND is_deleted = 'n'
    AND map_level = p_map_level
    AND target_field = p_target_field
  LIMIT 1;

  IF NOT FOUND THEN RETURN NULL; END IF;

  RETURN public.doc_flow_resolve_value(
    v_map.source_type, v_map.source_field, v_map.const_value, p_source_row, p_context);
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_get_map_value(INTEGER, TEXT, TEXT, JSONB, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.doc_flow_quote_value(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_value IS NULL THEN 'NULL' ELSE quote_literal(p_value) END;
$$;

CREATE OR REPLACE FUNCTION public.doc_flow_transferred_qty(p_source_detail_id INTEGER)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(t.quantity), 0)
  FROM public.doc_flow_transfers t
  WHERE t.source_detail_id = p_source_detail_id
    AND t.is_deleted = 'n';
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_transferred_qty(INTEGER) TO authenticated;

-- Recomputes "already transferred" progress on a source detail line straight from
-- the ledger. Recomputing (instead of incrementing) is what makes the counter
-- immune to lost updates under concurrency.
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
  v_transferred NUMERIC;
  v_order_id INTEGER;
BEGIN
  IF p_source_detail_id IS NULL THEN RETURN; END IF;

  v_transferred := public.doc_flow_transferred_qty(p_source_detail_id);

  IF p_source_document_type = 'purchase_order' THEN
    UPDATE public.erp_purchase_order_details_s_539dcf81_b d
    SET received_quantity = v_transferred, updated_at = NOW()
    WHERE d.id = p_source_detail_id
    RETURNING d.order_id INTO v_order_id;

    IF v_order_id IS NOT NULL THEN
      PERFORM public.doc_flow_sync_order_status(v_order_id);
    END IF;

  ELSIF p_source_document_type = 'sales_order' THEN
    UPDATE public.erp_sales_order_details_s_539dcf81_b d
    SET delivered_quantity = v_transferred, updated_at = NOW()
    WHERE d.id = p_source_detail_id
    RETURNING d.order_id INTO v_order_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_sync_source_progress(TEXT, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.doc_flow_sync_order_status(p_order_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_exists BOOLEAN;
BEGIN
  SELECT
    CASE
      WHEN COUNT(*) = 0 THEN 'approved'
      WHEN BOOL_AND(COALESCE(d.received_quantity, 0) >= COALESCE(d.quantity, 0)) THEN 'received'
      WHEN BOOL_OR(COALESCE(d.received_quantity, 0) > 0) THEN 'partially_received'
      ELSE 'approved'
    END,
    COUNT(*) > 0
  INTO v_status, v_exists
  FROM public.erp_purchase_order_details_s_539dcf81_b d
  WHERE d.order_id = p_order_id AND d.is_deleted = 'n';

  IF v_exists THEN
    UPDATE public.erp_purchase_orders_s_539dcf81_b
    SET status = v_status, updated_at = NOW()
    WHERE id = p_order_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_sync_order_status(INTEGER) TO authenticated;

-- Reverses every still-open conversion row belonging to one target detail line.
CREATE OR REPLACE FUNCTION public.doc_flow_reverse_target_detail(
  p_target_detail_id INTEGER,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
BEGIN
  IF p_target_detail_id IS NULL THEN RETURN; END IF;

  FOR v_row IN
    SELECT t.id, t.quantity, t.rule_id, t.source_document_type, t.source_document_id,
           t.source_detail_id, t.target_document_type, t.target_document_id
    FROM public.doc_flow_transfers t
    WHERE t.target_detail_id = p_target_detail_id
      AND t.transfer_kind = 'convert'
      AND t.is_deleted = 'n'
      AND NOT EXISTS (
        SELECT 1 FROM public.doc_flow_transfers rv
        WHERE rv.reversed_transfer_id = t.id AND rv.is_deleted = 'n'
      )
    FOR UPDATE OF t
  LOOP
    INSERT INTO public.doc_flow_transfers (
      corp_id, emp_id, rule_id,
      source_document_type, source_document_id, source_detail_id,
      target_document_type, target_document_id, target_detail_id,
      quantity, transfer_kind, reversed_transfer_id, reason
    ) VALUES (
      NULL, NULL, v_row.rule_id,
      v_row.source_document_type, v_row.source_document_id, v_row.source_detail_id,
      v_row.target_document_type, v_row.target_document_id, p_target_detail_id,
      -v_row.quantity, 'reverse', v_row.id, COALESCE(p_reason, 'target line changed')
    );

    PERFORM public.doc_flow_sync_source_progress(v_row.source_document_type, v_row.source_detail_id);
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_reverse_target_detail(INTEGER, TEXT) TO authenticated;

-- Public entry point for voiding or deleting a whole target document.
CREATE OR REPLACE FUNCTION public.doc_flow_reverse_document(
  p_target_document_type TEXT,
  p_target_document_id INTEGER,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_detail_id INTEGER;
  v_count INTEGER := 0;
BEGIN
  FOR v_detail_id IN
    SELECT DISTINCT t.target_detail_id
    FROM public.doc_flow_transfers t
    WHERE t.target_document_type = p_target_document_type
      AND t.target_document_id = p_target_document_id
      AND t.is_deleted = 'n'
      AND t.target_detail_id IS NOT NULL
  LOOP
    PERFORM public.doc_flow_reverse_target_detail(v_detail_id, p_reason);
    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', TRUE, 'reversed_lines', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_reverse_document(TEXT, INTEGER, TEXT) TO authenticated;

ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS source_detail_parent_field VARCHAR(100) NOT NULL DEFAULT 'order_id';
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS target_no_field VARCHAR(100) NOT NULL DEFAULT 'document_no';
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS target_detail_parent_field VARCHAR(100) NOT NULL DEFAULT 'receipt_id';

-- Amount fields cannot be copied by a same-name mapping: on a partial conversion the target
-- would inherit the SOURCE total. They are recomputed from the planned quantity instead.
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS target_unit_price_field VARCHAR(100) NOT NULL DEFAULT 'unit_price';
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS target_line_amount_field VARCHAR(100) NOT NULL DEFAULT 'amount';
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS target_total_amount_field VARCHAR(100) NOT NULL DEFAULT 'total_amount';
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS recalc_line_amount BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS sync_header_total BOOLEAN NOT NULL DEFAULT TRUE;

-- A source document rarely keeps the "approved" status after the first partial conversion:
-- the progress trigger moves a purchase order to "partially_received". Requiring plain
-- "approved" therefore blocks the second and every later conversion of the same order,
-- which defeats the whole point of a partial-conversion engine.
ALTER TABLE public.doc_flow_rules ADD COLUMN IF NOT EXISTS allowed_source_statuses TEXT[] NOT NULL
  DEFAULT ARRAY['approved', 'partially_received'];

-- Records one conversion (or one quantity adjustment) against the ledger and then
-- validates the line still fits inside the source quantity. Positive quantities are
-- checked for overrun; negative ones always pass because they release room back.
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
  v_source_document_id INTEGER;
  v_allowed NUMERIC;
  v_transferred NUMERIC;
BEGIN
  IF p_source_detail_id IS NULL OR COALESCE(p_quantity, 0) = 0 THEN RETURN; END IF;

  IF p_source_document_type = 'purchase_order' THEN
    SELECT d.order_id, COALESCE(d.quantity, 0)
    INTO v_source_document_id, v_allowed
    FROM public.erp_purchase_order_details_s_539dcf81_b d
    WHERE d.id = p_source_detail_id
    FOR UPDATE;
  ELSIF p_source_document_type = 'sales_order' THEN
    SELECT d.order_id, COALESCE(d.quantity, 0)
    INTO v_source_document_id, v_allowed
    FROM public.erp_sales_order_details_s_539dcf81_b d
    WHERE d.id = p_source_detail_id
    FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'Unsupported source document type for conversion: %', p_source_document_type;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source document line %/% does not exist', p_source_document_type, p_source_detail_id;
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

GRANT EXECUTE ON FUNCTION public.doc_flow_ledger_convert(TEXT, INTEGER, TEXT, INTEGER, INTEGER, NUMERIC, TEXT) TO authenticated;

-- Keeps the ledger in sync for hand-keyed target lines as well as generated ones.
-- Installed once per target detail table; see the trigger at the bottom of this file.
CREATE OR REPLACE FUNCTION public.doc_flow_ledger_on_receipt_detail()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_delta NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.order_detail_id IS NULL OR NEW.is_deleted <> 'n' THEN
      RETURN NEW;
    END IF;
    PERFORM public.doc_flow_ledger_convert(
      'purchase_order', NEW.order_detail_id, 'purchase_receipt',
      NEW.receipt_id, NEW.id, COALESCE(NEW.quantity, 0), 'receipt line created'
    );
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.order_detail_id IS NOT NULL THEN
      PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'receipt line deleted');
    END IF;
    RETURN OLD;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.is_deleted = 'n' AND NEW.is_deleted = 'y' THEN
      PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'receipt line voided');
      RETURN NEW;
    END IF;

    IF OLD.is_deleted = 'y' AND NEW.is_deleted = 'n' THEN
      IF NEW.order_detail_id IS NOT NULL THEN
        PERFORM public.doc_flow_ledger_convert(
          'purchase_order', NEW.order_detail_id, 'purchase_receipt',
          NEW.receipt_id, NEW.id, COALESCE(NEW.quantity, 0), 'receipt line restored'
        );
      END IF;
      RETURN NEW;
    END IF;

    IF COALESCE(NEW.order_detail_id, 0) <> COALESCE(OLD.order_detail_id, 0) THEN
      PERFORM public.doc_flow_reverse_target_detail(OLD.id, 'source line reassigned');
      IF NEW.order_detail_id IS NOT NULL THEN
        PERFORM public.doc_flow_ledger_convert(
          'purchase_order', NEW.order_detail_id, 'purchase_receipt',
          NEW.receipt_id, NEW.id, COALESCE(NEW.quantity, 0), 'source line reassigned'
        );
      END IF;
      RETURN NEW;
    END IF;

    v_delta := COALESCE(NEW.quantity, 0) - COALESCE(OLD.quantity, 0);
    IF v_delta <> 0 AND NEW.order_detail_id IS NOT NULL THEN
      PERFORM public.doc_flow_ledger_convert(
        'purchase_order', NEW.order_detail_id, 'purchase_receipt',
        NEW.receipt_id, NEW.id, v_delta, 'receipt line quantity adjusted'
      );
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_doc_flow_receipt_detail_ledger ON public.erp_purchase_receipt_details_s_539dcf81_b;
CREATE TRIGGER trg_doc_flow_receipt_detail_ledger
AFTER INSERT OR UPDATE OR DELETE ON public.erp_purchase_receipt_details_s_539dcf81_b
FOR EACH ROW EXECUTE FUNCTION public.doc_flow_ledger_on_receipt_detail();

-- Generates a target document from a source document using the configured mappings.
-- Ledger rows are written by the trigger above, so generated documents and hand-keyed
-- documents share exactly one accounting path.
CREATE OR REPLACE FUNCTION public.doc_flow_generate(
  p_rule_code TEXT,
  p_source_document_id INTEGER,
  p_line_mode TEXT DEFAULT 'remaining',
  p_line_requests JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule RECORD;
  v_source_table TEXT;
  v_source_detail_table TEXT;
  v_target_table TEXT;
  v_target_detail_table TEXT;
  v_source_row JSONB;
  v_context JSONB;
  v_target_no TEXT;
  v_target_id INTEGER;
  v_has_status BOOLEAN;
  v_map RECORD;
  v_value TEXT;
  v_req RECORD;
  v_line RECORD;
  v_source_detail_id INTEGER;
  v_source_qty NUMERIC;
  v_available NUMERIC;
  v_transferred NUMERIC;
  v_planned NUMERIC;
  v_line_no INTEGER := 0;
  v_line_count INTEGER := 0;
  v_header_cols TEXT[] := ARRAY[]::TEXT[];
  v_header_vals TEXT[] := ARRAY[]::TEXT[];
  v_line_cols TEXT[] := ARRAY[]::TEXT[];
  v_line_vals TEXT[] := ARRAY[]::TEXT[];
  v_ref_mapped BOOLEAN := FALSE;
  v_status_mapped BOOLEAN := FALSE;
  v_unit_price NUMERIC;
  v_price_text TEXT;
  v_price_map RECORD;
  v_has_total BOOLEAN;
  v_sql TEXT;
BEGIN
  SELECT * INTO v_rule
  FROM public.doc_flow_rules
  WHERE rule_code = p_rule_code AND is_deleted = 'n';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversion rule % does not exist', p_rule_code;
  END IF;
  IF NOT v_rule.is_active THEN
    RAISE EXCEPTION 'Conversion rule % is inactive', p_rule_code;
  END IF;
  IF p_line_mode NOT IN ('remaining', 'all', 'explicit') THEN
    RAISE EXCEPTION 'Unsupported conversion mode %', p_line_mode;
  END IF;

  SELECT table_name INTO v_source_table
  FROM public.sys_document_types WHERE document_type = v_rule.source_document_type AND is_deleted = 'n';
  SELECT table_name INTO v_target_table
  FROM public.sys_document_types WHERE document_type = v_rule.target_document_type AND is_deleted = 'n';
  v_source_detail_table := public.doc_flow_detail_table(v_rule.source_document_type);
  v_target_detail_table := public.doc_flow_detail_table(v_rule.target_document_type);

  IF v_source_table IS NULL OR v_target_table IS NULL THEN
    RAISE EXCEPTION 'Source or target document type has no physical table';
  END IF;
  IF v_source_detail_table IS NULL OR v_target_detail_table IS NULL THEN
    RAISE EXCEPTION 'Document type %/% is missing a detail table',
      v_rule.source_document_type, v_rule.target_document_type;
  END IF;

  EXECUTE format(
    'SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1 AND t.is_deleted = %L',
    v_source_table, 'n'
  ) INTO v_source_row USING p_source_document_id;

  IF v_source_row IS NULL THEN
    RAISE EXCEPTION 'Source document %/% does not exist', v_rule.source_document_type, p_source_document_id;
  END IF;

  IF v_rule.require_source_approved
     AND NOT (COALESCE(v_source_row ->> 'status', 'draft') = ANY (v_rule.allowed_source_statuses)) THEN
    RAISE EXCEPTION 'Source document status % is not convertible; allowed: %',
      COALESCE(v_source_row ->> 'status', 'draft'),
      array_to_string(v_rule.allowed_source_statuses, ', ');
  END IF;

  v_context := jsonb_build_object(
    'source_id', p_source_document_id,
    'source_no', COALESCE(v_source_row ->> 'order_no', v_source_row ->> 'document_no', p_source_document_id::TEXT)
  );

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = v_target_table AND column_name = 'status'
  ) INTO v_has_status;

  FOR v_map IN
    SELECT * FROM public.doc_flow_field_maps
    WHERE rule_id = v_rule.id AND is_deleted = 'n' AND map_level = 'header'
    ORDER BY sequence_no, id
  LOOP
    IF v_map.target_field = 'status' THEN v_status_mapped := TRUE; END IF;
    v_value := public.doc_flow_resolve_value(v_map.source_type, v_map.source_field, v_map.const_value, v_source_row, v_context);
    IF v_value IS NULL AND v_map.is_required THEN
      RAISE EXCEPTION 'Required header field % resolved to null', v_map.target_field;
    END IF;
    IF v_value IS NOT NULL THEN
      v_header_cols := v_header_cols || v_map.target_field;
      v_header_vals := v_header_vals || v_value;
    END IF;
  END LOOP;

  v_target_no := public.generate_document_no(v_rule.target_document_type, CURRENT_DATE);
  v_header_cols := v_header_cols || ARRAY[v_rule.target_no_field, 'is_deleted'];
  v_header_vals := v_header_vals || ARRAY[v_target_no, 'n'];
  IF v_has_status AND NOT v_status_mapped THEN
    v_header_cols := v_header_cols || ARRAY['status'];
    v_header_vals := v_header_vals || ARRAY[COALESCE(NULLIF(v_rule.target_initial_status, ''), 'draft')];
  END IF;

  v_sql := format(
    'INSERT INTO public.%I (%s) VALUES (%s) RETURNING id',
    v_target_table,
    array_to_string(ARRAY(SELECT format('%I', c) FROM unnest(v_header_cols) AS c), ', '),
    array_to_string(ARRAY(SELECT public.doc_flow_quote_value(v) FROM unnest(v_header_vals) AS v), ', ')
  );
  EXECUTE v_sql INTO v_target_id;

  FOR v_line IN EXECUTE format(
    'SELECT to_jsonb(d) AS row_data, d.%I AS detail_key
     FROM public.%I d
     WHERE d.%I = $1 AND d.is_deleted = %L
     ORDER BY d.line_no, d.id',
    v_rule.source_detail_key_field, v_source_detail_table, v_rule.source_detail_parent_field, 'n'
  ) USING p_source_document_id
  LOOP
    v_source_detail_id := (v_line.detail_key)::INTEGER;
    v_source_qty := COALESCE((v_line.row_data ->> v_rule.source_quantity_field)::NUMERIC, 0);
    v_transferred := public.doc_flow_transferred_qty(v_source_detail_id);
    v_available := v_source_qty - v_transferred;

    IF p_line_mode = 'explicit' THEN
      SELECT COALESCE((req ->> 'quantity')::NUMERIC, 0) INTO v_planned
      FROM jsonb_array_elements(COALESCE(p_line_requests, '[]'::jsonb)) AS req
      WHERE (req ->> 'source_detail_id')::INTEGER = v_source_detail_id;
      IF v_planned IS NULL THEN CONTINUE; END IF;
    ELSIF p_line_mode = 'all' THEN
      v_planned := v_source_qty;
    ELSE
      v_planned := v_available;
    END IF;

    IF v_planned <= 0 THEN CONTINUE; END IF;

    IF v_planned > v_available + 0.0000001 THEN
      RAISE EXCEPTION 'Source line % exceeds remaining quantity: remaining %, requested %',
        v_source_detail_id, v_available, v_planned
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_rule.allow_partial AND p_line_mode <> 'explicit' AND ABS(v_planned - v_source_qty) > 0.0000001 THEN
      RAISE EXCEPTION 'Rule % does not allow partial conversion on line %',
        p_rule_code, v_source_detail_id;
    END IF;

    v_line_no := v_line_no + 1;
    v_line_cols := ARRAY[v_rule.target_detail_parent_field, 'line_no', 'is_deleted'];
    v_line_vals := ARRAY[v_target_id::TEXT, v_line_no::TEXT, 'n'];
    v_ref_mapped := FALSE;

    v_unit_price := NULL;
    v_price_text := public.doc_flow_get_map_value(
      v_rule.id, 'line', v_rule.target_unit_price_field, v_line.row_data, v_context);
    IF COALESCE(v_price_text, '') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN
      v_unit_price := v_price_text::NUMERIC;
    END IF;

    FOR v_map IN
      SELECT * FROM public.doc_flow_field_maps
      WHERE rule_id = v_rule.id AND is_deleted = 'n' AND map_level = 'line'
      ORDER BY sequence_no, id
    LOOP
      IF v_rule.target_source_ref_field IS NOT NULL
         AND v_map.target_field = v_rule.target_source_ref_field THEN
        v_ref_mapped := TRUE;
      END IF;

      IF v_map.target_field = v_rule.target_quantity_field THEN
        v_value := trim(to_char(v_planned, 'FM9999999999990.9999'));
      ELSIF v_rule.recalc_line_amount
            AND v_map.target_field = v_rule.target_line_amount_field
            AND v_unit_price IS NOT NULL THEN
        v_value := trim(to_char(v_planned * v_unit_price, 'FM9999999999990.9999'));
      ELSE
        v_value := public.doc_flow_resolve_value(v_map.source_type, v_map.source_field, v_map.const_value, v_line.row_data, v_context);
      END IF;

      IF v_value IS NULL AND v_map.is_required THEN
        RAISE EXCEPTION 'Required line field % resolved to null', v_map.target_field;
      END IF;
      IF v_value IS NOT NULL THEN
        v_line_cols := v_line_cols || v_map.target_field;
        v_line_vals := v_line_vals || v_value;
      END IF;
    END LOOP;

    IF v_rule.target_source_ref_field IS NOT NULL AND NOT v_ref_mapped THEN
      v_line_cols := v_line_cols || v_rule.target_source_ref_field;
      v_line_vals := v_line_vals || v_source_detail_id::TEXT;
    END IF;

    v_sql := format(
      'INSERT INTO public.%I (%s) VALUES (%s)',
      v_target_detail_table,
      array_to_string(ARRAY(SELECT format('%I', c) FROM unnest(v_line_cols) AS c), ', '),
      array_to_string(ARRAY(SELECT public.doc_flow_quote_value(v) FROM unnest(v_line_vals) AS v), ', ')
    );
    EXECUTE v_sql;
    v_line_count := v_line_count + 1;
  END LOOP;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'Nothing left to convert for %/%: every source line is already fully converted',
      v_rule.source_document_type, p_source_document_id;
  END IF;

  IF v_rule.sync_header_total THEN
    SELECT
      EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = v_target_table
          AND column_name = v_rule.target_total_amount_field
      )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = v_target_detail_table
          AND column_name = v_rule.target_line_amount_field
      )
    INTO v_has_total;

    IF v_has_total THEN
      EXECUTE format(
        'UPDATE public.%I h SET %I = COALESCE((
           SELECT SUM(d.%I) FROM public.%I d
           WHERE d.%I = $1 AND d.is_deleted = %L
         ), 0) WHERE h.id = $1',
        v_target_table,
        v_rule.target_total_amount_field,
        v_rule.target_line_amount_field,
        v_target_detail_table,
        v_rule.target_detail_parent_field,
        'n'
      ) USING v_target_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'target_document_type', v_rule.target_document_type,
    'target_document_id', v_target_id,
    'target_document_no', v_target_no,
    'lines', v_line_count
  );
END;
$$;

-- One-off backfill for documents that existed before this engine was deployed.
-- Without this step historic receipt lines would be missing from the ledger, so their
-- source lines would look unconverted and could be converted a second time, which is
-- exactly the overrun this ledger exists to prevent.
-- Safe to re-run: lines that already have a ledger row are skipped.
CREATE OR REPLACE FUNCTION public.doc_flow_backfill_receipts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row RECORD;
  v_line RECORD;
  v_source_document_id INTEGER;
  v_count INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT d.id AS detail_id, d.receipt_id, d.order_detail_id, COALESCE(d.quantity, 0) AS qty
    FROM public.erp_purchase_receipt_details_s_539dcf81_b d
    JOIN public.erp_purchase_receipts_s_539dcf81_b h ON h.id = d.receipt_id
    WHERE d.is_deleted = 'n'
      AND h.is_deleted = 'n'
      AND d.order_detail_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.doc_flow_transfers t
        WHERE t.target_detail_id = d.id AND t.is_deleted = 'n'
      )
    ORDER BY d.id
  LOOP
    SELECT od.order_id INTO v_source_document_id
    FROM public.erp_purchase_order_details_s_539dcf81_b od
    WHERE od.id = v_row.order_detail_id;
    IF v_source_document_id IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.doc_flow_transfers (
      source_document_type, source_document_id, source_detail_id,
      target_document_type, target_document_id, target_detail_id,
      quantity, transfer_kind, reason
    ) VALUES (
      'purchase_order', v_source_document_id, v_row.order_detail_id,
      'purchase_receipt', v_row.receipt_id, v_row.detail_id,
      v_row.qty, 'convert', 'backfill: pre-existing receipt line'
    );
    v_count := v_count + 1;
  END LOOP;

  FOR v_line IN
    SELECT DISTINCT source_detail_id
    FROM public.doc_flow_transfers
    WHERE is_deleted = 'n' AND source_detail_id IS NOT NULL
  LOOP
    PERFORM public.doc_flow_sync_source_progress('purchase_order', v_line.source_detail_id);
  END LOOP;

  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_backfill_receipts() TO authenticated;

GRANT EXECUTE ON FUNCTION public.doc_flow_generate(TEXT, INTEGER, TEXT, JSONB) TO authenticated;

INSERT INTO public.doc_flow_rules (
  rule_code, rule_name, source_document_type, target_document_type,
  source_quantity_field, target_quantity_field, source_detail_key_field, target_source_ref_field,
  source_detail_parent_field, target_no_field, target_detail_parent_field,
  target_initial_status, allow_partial, require_source_approved, description
)
VALUES (
  'purchase_order_to_receipt', '采购订单生成采购入库', 'purchase_order', 'purchase_receipt',
  'quantity', 'quantity', 'id', 'order_detail_id',
  'order_id', 'receipt_no', 'receipt_id',
  'draft', TRUE, TRUE, '按采购订单未入库数量生成采购入库单，支持分批收货'
)
ON CONFLICT (rule_code) DO NOTHING;

INSERT INTO public.doc_flow_field_maps (
  rule_id, map_level, target_field, source_type, source_field, const_value, sequence_no
)
SELECT r.id, x.map_level, x.target_field, x.source_type, x.source_field, x.const_value, x.sequence_no
FROM public.doc_flow_rules r
CROSS JOIN (VALUES
  ('header', 'receipt_date', 'sys',    'today',        NULL,    10),
  ('header', 'supplier_id',  'field',  'supplier_id',  NULL,    20),
  ('header', 'order_id',     'sys',    'source_id',    NULL,    30),
  ('header', 'remark',       'field',  'remark',       NULL,    40),
  ('line',   'order_detail_id', 'field', 'id',         NULL,    10),
  ('line',   'product_id',   'field',  'product_id',   NULL,    20),
  ('line',   'quantity',     'field',  'quantity',     NULL,    30),
  ('line',   'unit_price',   'field',  'unit_price',   NULL,    40),
  ('line',   'amount',       'field',  'amount',       NULL,    50),
  ('line',   'remark',       'field',  'remark',       NULL,    60)
) AS x(map_level, target_field, source_type, source_field, const_value, sequence_no)
WHERE r.rule_code = 'purchase_order_to_receipt'
  AND r.source_document_type = 'purchase_order'
  AND r.target_document_type = 'purchase_receipt'
ON CONFLICT (rule_id, map_level, target_field) DO NOTHING;
