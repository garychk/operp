-- Configurable business document types, modeled after ERPNext/Frappe DocType metadata.
CREATE TABLE IF NOT EXISTS public.sys_document_types (
  id SERIAL PRIMARY KEY,
  document_type VARCHAR(100) NOT NULL UNIQUE,
  document_name VARCHAR(150) NOT NULL,
  module_code VARCHAR(100),
  route_path VARCHAR(255),
  table_name VARCHAR(128),
  primary_key_field VARCHAR(128) NOT NULL DEFAULT 'id',
  workflow_process_id INTEGER REFERENCES public.wf_process_definitions(id) ON DELETE SET NULL,
  naming_rule VARCHAR(255),
  is_submittable BOOLEAN NOT NULL DEFAULT TRUE,
  is_single BOOLEAN NOT NULL DEFAULT FALSE,
  is_child BOOLEAN NOT NULL DEFAULT FALSE,
  is_tree BOOLEAN NOT NULL DEFAULT FALSE,
  quick_entry BOOLEAN NOT NULL DEFAULT FALSE,
  track_changes BOOLEAN NOT NULL DEFAULT TRUE,
  track_seen BOOLEAN NOT NULL DEFAULT FALSE,
  track_views BOOLEAN NOT NULL DEFAULT FALSE,
  is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
  is_custom BOOLEAN NOT NULL DEFAULT FALSE,
  form_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  list_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  permission_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status CHAR(1) NOT NULL DEFAULT '1',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sys_document_types_workflow_process
  ON public.sys_document_types(workflow_process_id);
CREATE INDEX IF NOT EXISTS idx_sys_document_types_form_config_gin
  ON public.sys_document_types USING gin(form_config);
CREATE INDEX IF NOT EXISTS idx_sys_document_types_list_config_gin
  ON public.sys_document_types USING gin(list_config);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_document_types TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_document_types_id_seq TO authenticated;
ALTER TABLE public.sys_document_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage document types" ON public.sys_document_types;
CREATE POLICY "Authenticated users can manage document types"
  ON public.sys_document_types FOR ALL TO authenticated USING (true) WITH CHECK (true);
SELECT public.install_role_table_rls('sys_document_types');

INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name,
   workflow_process_id, naming_rule, sort_order)
SELECT x.document_type, x.document_name, x.module_code, x.route_path,
       x.table_name, p.id, x.naming_rule, x.sort_order
FROM (VALUES
  ('purchase_order', '采购订单', 'inventory', '/inventory/purchase-orders', 'erp_purchase_orders_s_539dcf81_b', 'PO{YYYY}{####}', 10),
  ('sales_order', '销售订单', 'inventory', '/inventory/sales-orders', 'erp_sales_orders_s_539dcf81_b', 'SO{YYYY}{####}', 20),
  ('purchase_receipt', '采购入库', 'inventory', '/inventory/purchase-receipts', 'erp_purchase_receipts_s_539dcf81_b', 'PR{YYYY}{####}', 30),
  ('sales_delivery', '销售出货', 'inventory', '/inventory/sales-deliveries', 'erp_sales_deliveries_s_539dcf81_b', 'SD{YYYY}{####}', 40),
  ('voucher', '凭证', 'finance', '/finance/vouchers', 'erp_vouchers_s_539dcf81_b', 'V{YYYY}{####}', 50)
) AS x(document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order)
LEFT JOIN LATERAL (
  SELECT id
  FROM public.wf_process_definitions
  WHERE process_code = x.document_type || '_default'
    AND is_deleted = 'n'
    AND is_active = TRUE
  ORDER BY version DESC, id DESC
  LIMIT 1
) p ON TRUE
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code = EXCLUDED.module_code,
  route_path = EXCLUDED.route_path,
  table_name = EXCLUDED.table_name,
  workflow_process_id = COALESCE(EXCLUDED.workflow_process_id, sys_document_types.workflow_process_id),
  naming_rule = EXCLUDED.naming_rule,
  updated_at = NOW();

CREATE OR REPLACE FUNCTION public.workflow_get_active_process_for_document(p_document_type TEXT)
RETURNS public.wf_process_definitions
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_process public.wf_process_definitions;
BEGIN
  SELECT p.* INTO v_process
  FROM public.sys_document_types d
  JOIN public.wf_process_definitions p ON p.id = d.workflow_process_id
  WHERE d.document_type = p_document_type
    AND d.status = '1'
    AND d.is_deleted = 'n'
    AND p.is_deleted = 'n'
    AND p.is_active = TRUE
  ORDER BY p.version DESC, p.id DESC
  LIMIT 1;

  IF v_process.id IS NULL THEN
    SELECT p.* INTO v_process
    FROM public.wf_process_definitions p
    WHERE p.document_type = p_document_type
      AND p.is_deleted = 'n'
      AND p.is_active = TRUE
    ORDER BY p.version DESC, p.id DESC
    LIMIT 1;
  END IF;
  RETURN v_process;
END;
$$;

-- Keep the existing workflow RPC contract while resolving the process through
-- the document type metadata first.
CREATE OR REPLACE FUNCTION public.workflow_get_active_process(p_document_type TEXT)
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.workflow_get_active_process_for_document(p_document_type);
$$;

-- Field metadata for configurable document types, inspired by ERPNext DocType fields.
CREATE TABLE IF NOT EXISTS public.sys_document_type_fields (
  id SERIAL PRIMARY KEY,
  document_type_id INTEGER NOT NULL REFERENCES public.sys_document_types(id) ON DELETE CASCADE,
  field_name VARCHAR(100) NOT NULL,
  label VARCHAR(150) NOT NULL,
  field_type VARCHAR(40) NOT NULL DEFAULT 'Data',
  data_type VARCHAR(40),
  options TEXT,
  default_value TEXT,
  description TEXT,
  length INTEGER,
  precision INTEGER,
  scale INTEGER,
  width INTEGER,
  is_required BOOLEAN NOT NULL DEFAULT FALSE,
  is_unique BOOLEAN NOT NULL DEFAULT FALSE,
  is_read_only BOOLEAN NOT NULL DEFAULT FALSE,
  is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
  no_copy BOOLEAN NOT NULL DEFAULT FALSE,
  allow_on_submit BOOLEAN NOT NULL DEFAULT FALSE,
  in_list_view BOOLEAN NOT NULL DEFAULT FALSE,
  in_standard_filter BOOLEAN NOT NULL DEFAULT FALSE,
  in_global_search BOOLEAN NOT NULL DEFAULT FALSE,
  print_hide BOOLEAN NOT NULL DEFAULT FALSE,
  report_hide BOOLEAN NOT NULL DEFAULT FALSE,
  bold BOOLEAN NOT NULL DEFAULT FALSE,
  translatable BOOLEAN NOT NULL DEFAULT FALSE,
  is_virtual BOOLEAN NOT NULL DEFAULT FALSE,
  fetch_from VARCHAR(255),
  link_document_type_id INTEGER REFERENCES public.sys_document_types(id) ON DELETE SET NULL,
  child_document_type_id INTEGER REFERENCES public.sys_document_types(id) ON DELETE SET NULL,
  depends_on TEXT,
  mandatory_depends_on TEXT,
  read_only_depends_on TEXT,
  validation_rule TEXT,
  section_code VARCHAR(100),
  column_index INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status CHAR(1) NOT NULL DEFAULT '1',
  is_deleted CHAR(1) NOT NULL DEFAULT 'n',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_sys_document_type_fields_name UNIQUE (document_type_id, field_name),
  CONSTRAINT chk_sys_document_type_fields_type CHECK (field_type IN (
    'Data', 'Text', 'LongText', 'Int', 'Float', 'Currency', 'Date', 'DateTime',
    'Check', 'Select', 'Link', 'DynamicLink', 'Table', 'Attach', 'Image',
    'HTML', 'SectionBreak', 'ColumnBreak'
  )),
  CONSTRAINT chk_sys_document_type_fields_length CHECK (length IS NULL OR length > 0),
  CONSTRAINT chk_sys_document_type_fields_precision CHECK (precision IS NULL OR precision >= 0),
  CONSTRAINT chk_sys_document_type_fields_scale CHECK (scale IS NULL OR scale >= 0),
  CONSTRAINT chk_sys_document_type_fields_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT chk_sys_document_type_fields_column CHECK (column_index > 0)
);

CREATE INDEX IF NOT EXISTS idx_sys_document_type_fields_document_type
  ON public.sys_document_type_fields(document_type_id, sort_order, id);
CREATE INDEX IF NOT EXISTS idx_sys_document_type_fields_link_type
  ON public.sys_document_type_fields(link_document_type_id);
CREATE INDEX IF NOT EXISTS idx_sys_document_type_fields_child_type
  ON public.sys_document_type_fields(child_document_type_id);
CREATE INDEX IF NOT EXISTS idx_sys_document_type_fields_config_gin
  ON public.sys_document_type_fields USING gin(config_json);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_document_type_fields TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_document_type_fields_id_seq TO authenticated;
ALTER TABLE public.sys_document_type_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage document type fields" ON public.sys_document_type_fields;
CREATE POLICY "Authenticated users can manage document type fields"
  ON public.sys_document_type_fields FOR ALL TO authenticated USING (true) WITH CHECK (true);
SELECT public.install_role_table_rls('sys_document_type_fields');
