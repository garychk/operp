CREATE OR REPLACE FUNCTION public.execute_ai_analysis(sql_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  q TEXT := BTRIM(sql_text);
  normalized_q TEXT;
  select_pos INT;
  with_pos INT;
  start_pos INT;
  rows JSONB;
BEGIN
  IF q IS NULL OR q = '' THEN
    RAISE EXCEPTION 'SQL text cannot be empty';
  END IF;
  select_pos := position('select' in lower(q));
  with_pos := position('with' in lower(q));
  start_pos := CASE
    WHEN select_pos = 0 AND with_pos = 0 THEN 0
    WHEN select_pos = 0 THEN with_pos
    WHEN with_pos = 0 THEN select_pos
    WHEN select_pos < with_pos THEN select_pos
    ELSE with_pos
  END;
  IF start_pos = 0 THEN
    RAISE EXCEPTION 'Only SELECT/WITH statements are allowed';
  END IF;
  normalized_q := BTRIM(SUBSTRING(q FROM start_pos));
  IF POSITION(';' IN normalized_q) > 0 THEN
    RAISE EXCEPTION 'Semicolons are not allowed';
  END IF;
  IF normalized_q ~* '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|commit|rollback)\b' THEN
    RAISE EXCEPTION 'Only read-only queries are allowed';
  END IF;

  EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) FROM (%s) t', normalized_q) INTO rows;

  RETURN jsonb_build_object(
    'rows', COALESCE(rows, '[]'::jsonb),
    'rowCount', COALESCE(jsonb_array_length(rows), 0)
  );
END $$;

REVOKE ALL ON FUNCTION public.execute_ai_analysis(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO service_role;
