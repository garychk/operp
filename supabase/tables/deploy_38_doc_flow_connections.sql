-- Connections view: everything a document is linked to, both upstream and
-- downstream, resolved straight from the conversion ledger.
--
-- Two small pieces:
--   1. doc_flow_doc_meta - which column holds the human readable document number
--      for each type. sys_document_types has the table name and the Chinese
--      document_name but no number field, so it is registered here.
--   2. doc_flow_connections - one call returning the current document plus its
--      upstream and downstream neighbours with converted quantities, ready for
--      the ER graph to render.

CREATE TABLE IF NOT EXISTS public.doc_flow_doc_meta (
  document_type VARCHAR(100) PRIMARY KEY
    REFERENCES public.sys_document_types(document_type) ON DELETE CASCADE,
  no_field VARCHAR(100) NOT NULL,
  remark TEXT
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.doc_flow_doc_meta TO authenticated;
ALTER TABLE public.doc_flow_doc_meta ENABLE ROW LEVEL SECURITY;
SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('doc_flow_doc_meta');

INSERT INTO public.doc_flow_doc_meta (document_type, no_field, remark) VALUES
  ('purchase_order', 'order_no', '采购订单'),
  ('purchase_receipt', 'receipt_no', '采购入库单'),
  ('sales_order', 'order_no', '销售订单'),
  ('sales_delivery', 'delivery_no', '销售出货单'),
  ('production_order', 'order_no', '生产订单'),
  ('material_issue', 'issue_no', '生产领料单')
ON CONFLICT (document_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.doc_flow_document_no(
  p_document_type TEXT,
  p_document_id INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table TEXT;
  v_no_field TEXT;
  v_no TEXT;
BEGIN
  IF p_document_id IS NULL THEN RETURN NULL; END IF;

  SELECT m.no_field INTO v_no_field
  FROM public.doc_flow_doc_meta m
  WHERE m.document_type = p_document_type;
  IF v_no_field IS NULL THEN RETURN p_document_id::TEXT; END IF;

  SELECT table_name INTO v_table
  FROM public.sys_document_types
  WHERE document_type = p_document_type AND is_deleted = 'n';
  IF v_table IS NULL THEN RETURN p_document_id::TEXT; END IF;

  EXECUTE format('SELECT d.%I FROM public.%I d WHERE d.id = $1', v_no_field, v_table)
    INTO v_no USING p_document_id;

  RETURN COALESCE(v_no, p_document_id::TEXT);
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_document_no(TEXT, INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.doc_flow_document_name(p_document_type TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT document_name FROM public.sys_document_types
     WHERE document_type = p_document_type AND is_deleted = 'n'),
    p_document_type
  );
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_document_name(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.doc_flow_connections(
  p_document_type TEXT,
  p_document_id INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_upstream JSONB;
  v_downstream JSONB;
BEGIN
  IF p_document_type IS NULL OR p_document_id IS NULL THEN
    RETURN jsonb_build_object('current', NULL, 'upstream', '[]'::jsonb, 'downstream', '[]'::jsonb);
  END IF;

  SELECT COALESCE(jsonb_agg(x.item), '[]'::jsonb) INTO v_upstream
  FROM (
    SELECT jsonb_build_object(
      'document_type', t.source_document_type,
      'document_id', t.source_document_id,
      'document_no', public.doc_flow_document_no(t.source_document_type, t.source_document_id),
      'document_name', public.doc_flow_document_name(t.source_document_type),
      'quantity', SUM(t.quantity),
      'lines', COUNT(DISTINCT t.source_detail_id)
    ) AS item
    FROM public.doc_flow_transfers t
    WHERE t.is_deleted = 'n'
      AND t.target_document_type = p_document_type
      AND t.target_document_id = p_document_id
    GROUP BY t.source_document_type, t.source_document_id
    ORDER BY 1
  ) x;

  SELECT COALESCE(jsonb_agg(x.item), '[]'::jsonb) INTO v_downstream
  FROM (
    SELECT jsonb_build_object(
      'document_type', t.target_document_type,
      'document_id', t.target_document_id,
      'document_no', public.doc_flow_document_no(t.target_document_type, t.target_document_id),
      'document_name', public.doc_flow_document_name(t.target_document_type),
      'quantity', SUM(t.quantity),
      'lines', COUNT(DISTINCT t.target_detail_id)
    ) AS item
    FROM public.doc_flow_transfers t
    WHERE t.is_deleted = 'n'
      AND t.source_document_type = p_document_type
      AND t.source_document_id = p_document_id
    GROUP BY t.target_document_type, t.target_document_id
    ORDER BY 1
  ) x;

  RETURN jsonb_build_object(
    'current', jsonb_build_object(
      'document_type', p_document_type,
      'document_id', p_document_id,
      'document_no', public.doc_flow_document_no(p_document_type, p_document_id),
      'document_name', public.doc_flow_document_name(p_document_type)
    ),
    'upstream', v_upstream,
    'downstream', v_downstream
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.doc_flow_connections(TEXT, INTEGER) TO authenticated;
