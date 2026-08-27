-- Make the BAQ catalog usable by the server-side AI service.
-- The function only exposes table metadata and column names; it does not
-- grant data access or execute arbitrary SQL.
CREATE OR REPLACE FUNCTION public.baq_catalog()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'table', x.table_name,
        'label', COALESCE(t.table_label, x.table_name),
        'module', COALESCE(t.module_name, 'erp'),
        'columns', x.columns
      )
      ORDER BY x.table_name
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT
      c.table_name,
      jsonb_agg(
        jsonb_build_object(
          'name', c.column_name,
          'type', c.data_type
        )
        ORDER BY c.ordinal_position
      ) AS columns
    FROM information_schema.columns c
    INNER JOIN public.sys_tables t
      ON t.table_name = c.table_name
     AND t.is_deleted = 'n'
     AND t.status = '1'
    WHERE c.table_schema = 'public'
      AND c.table_name LIKE 'erp\_%' ESCAPE '\'
    GROUP BY c.table_name
  ) x
  LEFT JOIN public.sys_tables t
    ON t.table_name = x.table_name
   AND t.is_deleted = 'n'
   AND t.status = '1';
$$;

REVOKE ALL ON FUNCTION public.baq_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.baq_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.baq_catalog() TO service_role;
