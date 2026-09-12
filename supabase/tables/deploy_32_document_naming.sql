-- Unified document numbering driven by sys_document_types.naming_rule.
-- Provides an atomic RPC (generate_document_no) so every business document
-- (purchase orders, sales orders, receipts, deliveries, transfers, counts,
-- adjustments, vouchers, production orders, material issues, MRP plans, ...)
-- draws its document number from the DocType metadata instead of hardcoded
-- client-side timestamps.
--
-- Naming rule tokens:
--   {YYYY} 4-digit year       {YY} 2-digit year
--   {MM}   2-digit month      {DD} 2-digit day
--   {####} zero-padded sequence, one '#' per digit (e.g. {###} -> 001..999)
-- Anything else in the rule is kept as a literal prefix/suffix.
-- The counter resets automatically whenever the finest date token rolls over
-- (day -> {DD} present, month -> {MM} present, otherwise year).

CREATE TABLE IF NOT EXISTS public.sys_document_naming_counters (
  document_type VARCHAR(100) NOT NULL,
  period_key VARCHAR(20) NOT NULL,
  last_no INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (document_type, period_key)
);

-- The counter table is only mutated through the SECURITY DEFINER RPC below.
ALTER TABLE public.sys_document_naming_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sys_document_naming_counters FROM authenticated;

CREATE OR REPLACE FUNCTION public.generate_document_no(
  p_document_type TEXT,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rule TEXT;
  v_period TEXT;
  v_next INTEGER;
  v_result TEXT := '';
  v_rest TEXT;
  v_match TEXT[];
BEGIN
  IF p_document_type IS NULL OR BTRIM(p_document_type) = '' THEN
    RAISE EXCEPTION 'Document type is required' USING ERRCODE = '22023';
  END IF;
  IF p_date IS NULL THEN
    p_date := CURRENT_DATE;
  END IF;

  SELECT NULLIF(BTRIM(naming_rule), '') INTO v_rule
  FROM public.sys_document_types
  WHERE document_type = BTRIM(p_document_type)
    AND status = '1'
    AND is_deleted = 'n';

  IF v_rule IS NULL THEN
    RAISE EXCEPTION 'No naming rule configured for document type: %', p_document_type USING ERRCODE = 'P0002';
  END IF;

  -- Counter period follows the finest date token present in the rule.
  IF v_rule LIKE '%{DD}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMMDD');
  ELSIF v_rule LIKE '%{MM}%' THEN
    v_period := TO_CHAR(p_date, 'YYYYMM');
  ELSE
    v_period := TO_CHAR(p_date, 'YYYY');
  END IF;

  -- Atomic increment: concurrent callers serialize on the row lock.
  INSERT INTO public.sys_document_naming_counters AS c (document_type, period_key, last_no)
  VALUES (BTRIM(p_document_type), v_period, 1)
  ON CONFLICT (document_type, period_key)
  DO UPDATE SET last_no = c.last_no + 1, updated_at = NOW()
  RETURNING c.last_no INTO v_next;

  -- Render the rule token by token.
  v_rest := v_rule;
  LOOP
    v_match := regexp_match(v_rest, '^(.*?)\{([^{}]+)\}(.*)$');
    EXIT WHEN v_match IS NULL;
    v_result := v_result || v_match[1] || CASE v_match[2]
      WHEN 'YYYY' THEN TO_CHAR(p_date, 'YYYY')
      WHEN 'YY' THEN TO_CHAR(p_date, 'YY')
      WHEN 'MM' THEN TO_CHAR(p_date, 'MM')
      WHEN 'DD' THEN TO_CHAR(p_date, 'DD')
      ELSE CASE
        WHEN v_match[2] ~ '^#+$' THEN LPAD(v_next::TEXT, LENGTH(v_match[2]), '0')
        ELSE '{' || v_match[2] || '}'
      END
    END;
    v_rest := v_match[3];
  END LOOP;
  v_result := v_result || v_rest;

  RETURN LEFT(v_result, 50);
END;
$$;

REVOKE ALL ON FUNCTION public.generate_document_no(TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_document_no(TEXT, DATE) TO authenticated;

-- Register the remaining business documents that generate numbers today.
INSERT INTO public.sys_document_types
  (document_type, document_name, module_code, route_path, table_name, naming_rule, sort_order)
VALUES
  ('production_order', '生产订单', 'mrp', '/mrp/production', 'erp_production_orders_s_539dcf81_b', 'MO{YYYY}{####}', 60),
  ('material_issue', '领料单', 'mrp', '/mrp/material-issues', 'erp_material_issues_s_539dcf81_b', 'MI{YYYY}{####}', 61),
  ('mrp_plan', 'MRP计划', 'mrp', '/mrp/plans', 'erp_mrp_plans_s_539dcf81_b', 'MRP{YYYY}{####}', 62),
  ('bom', 'BOM', 'mrp', '/mrp/boms', 'erp_boms_s_539dcf81_b', 'BOM{YYYY}{####}', 63),
  ('routing', '工艺路线', 'mrp', '/mrp/routings', 'erp_routing_operations_s_539dcf81_b', 'RT{YYYY}{####}', 64)
ON CONFLICT (document_type) DO UPDATE SET
  document_name = EXCLUDED.document_name,
  module_code = EXCLUDED.module_code,
  route_path = EXCLUDED.route_path,
  table_name = EXCLUDED.table_name,
  naming_rule = EXCLUDED.naming_rule,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

-- Compatibility helper: reset a counter (e.g. after data refresh in test envs).
CREATE OR REPLACE FUNCTION public.reset_document_no_counter(
  p_document_type TEXT,
  p_period_key TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  IF p_period_key IS NULL THEN
    DELETE FROM public.sys_document_naming_counters WHERE document_type = p_document_type;
  ELSE
    DELETE FROM public.sys_document_naming_counters
    WHERE document_type = p_document_type AND period_key = p_period_key;
  END IF;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.reset_document_no_counter(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reset_document_no_counter(TEXT, TEXT) TO authenticated;
