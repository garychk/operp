-- The ledger tab in DocFlowConfig filters on doc_flow_transfers.rule_id, but
-- nothing ever wrote that column: doc_flow_ledger_convert inserted without it and
-- the backfill skipped it too. Every ledger row therefore had rule_id = NULL and
-- the tab was permanently empty.
--
-- Two fixes:
--   1. Start recording rule_id (optional 8th argument, so existing call sites keep
--      working) and pass it from the generic trigger and the backfill.
--   2. Backfill rule_id on the rows that already exist, matching on the source and
--      target document type pair.
--
-- The config page was also changed to fall back to that same (source, target) pair
-- so a ledger written before this file is still visible.

DROP FUNCTION IF EXISTS public.doc_flow_ledger_convert(TEXT, INTEGER, TEXT, INTEGER, INTEGER, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.doc_flow_ledger_convert(
  p_source_document_type TEXT,
  p_source_detail_id INTEGER,
  p_target_document_type TEXT,
  p_target_document_id INTEGER,
  p_target_detail_id INTEGER,
  p_quantity NUMERIC,
  p_reason TEXT DEFAULT NULL,
  p_rule_id INTEGER DEFAULT NULL
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
    rule_id,
    source_document_type, source_document_id, source_detail_id,
    target_document_type, target_document_id, target_detail_id,
    quantity, transfer_kind, reason
  ) VALUES (
    p_rule_id,
    p_source_document_type, v_source_document_id, p_source_detail_id,
    p_target_document_type, p_target_document_id, p_target_detail_id,
    p_quantity, 'convert', p_reason
  );

  PERFORM public.doc_flow_sync_source_progress(p_source_document_type, p_source_detail_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_ledger_convert(TEXT, INTEGER, TEXT, INTEGER, INTEGER, NUMERIC, TEXT, INTEGER) TO authenticated;

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
      v_parent, NEW.id, v_qty, 'target line created', v_rule.id);
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
      v_parent, NEW.id, v_qty, 'target line restored', v_rule.id);
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
        v_parent, NEW.id, v_qty, 'source line reassigned', v_rule.id);
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
      v_parent, NEW.id, v_delta, 'target line quantity adjusted', v_rule.id);
  END IF;

  RETURN NEW;
END;
$$;

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
      rule_id,
      source_document_type, source_document_id, source_detail_id,
      target_document_type, target_document_id, target_detail_id,
      quantity, transfer_kind, reason
    ) VALUES (
      v_rule.id,
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

-- Repair the rows written before this fix. Covers conversions and their
-- reversals, since both carry the same source/target pair.
UPDATE public.doc_flow_transfers t
SET rule_id = r.id
FROM public.doc_flow_rules r
WHERE t.rule_id IS NULL
  AND t.is_deleted = 'n'
  AND r.is_deleted = 'n'
  AND r.source_document_type = t.source_document_type
  AND r.target_document_type = t.target_document_type;
