CREATE OR REPLACE FUNCTION public.execute_ai_analysis(sql_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q TEXT := BTRIM(sql_text);
  rows JSONB;
BEGIN
  IF q IS NULL OR q = '' THEN
    RAISE EXCEPTION 'SQL text cannot be empty';
  END IF;
  IF q !~* '^\s*(select|with)\b' THEN
    RAISE EXCEPTION 'Only SELECT/WITH statements are allowed';
  END IF;
  IF POSITION(';' IN q) > 0 THEN
    RAISE EXCEPTION 'Semicolons are not allowed';
  END IF;
  IF q ~* '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|commit|rollback)\b' THEN
    RAISE EXCEPTION 'Only read-only queries are allowed';
  END IF;

  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) FROM (%s) t', q) INTO rows;

  RETURN jsonb_build_object(
    'rows', COALESCE(rows, '[]'::jsonb),
    'rowCount', COALESCE(jsonb_array_length(rows), 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.execute_ai_analysis(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO service_role;
