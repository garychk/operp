-- ============================================================================
-- deploy_81_ai_analysis_hardening.sql — AI 分析 SQL 执行器加固
--
-- 背景：execute_ai_analysis（deploy_26）是 SECURITY DEFINER + 关键字黑名单，
-- 存在几个生产级风险：
--   1. DEFINER 绕过 RLS —— 黑名单挡不住「SELECT 合法表但调函数」的查询
--      （pg_read_file / dblink / query_to_xml / set_config 改租户上下文…）；
--   2. 没有 statement_timeout，一条笛卡尔积能拖死整库连接池；
--   3. 没有行数上限，大结果集直接打爆内存；
--   4. 未显式 REVOKE anon（容器配了 ALTER DEFAULT PRIVILEGES，REVOKE PUBLIC
--      拦不住显式 ACL）。
--
-- 本脚本（保持函数名与签名不变，调用方零改动）：
--   - 剥掉 SQL 注释后再做黑名单校验（避免注释词误杀）；
--   - 扩展黑名单：文件/大对象/外部连接/任意查询执行/上下文篡改/睡眠等；
--   - SET statement_timeout = '5s'；
--   - 强制 LIMIT 2000 封顶，超限截断并在返回值标记 truncated；
--   - REVOKE anon，重新 GRANT authenticated / service_role。
--
-- execute_ai_analysis_for_tenant（deploy_42）不需要改：它保留 INVOKER +
-- 租户文本校验，最终委托给本函数执行，自动继承以上所有加固。
-- ============================================================================

CREATE OR REPLACE FUNCTION public.execute_ai_analysis(sql_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '5s'
AS $$
DECLARE
  q TEXT := BTRIM(sql_text);
  clean TEXT;
  normalized_q TEXT;
  select_pos INT;
  with_pos INT;
  start_pos INT;
  fetched JSONB;
  row_count INT;
  truncated BOOLEAN := FALSE;
  -- 强制行数封顶：多取 1 行用于判断是否截断
  row_cap CONSTANT INT := 2000;
BEGIN
  IF q IS NULL OR q = '' THEN
    RAISE EXCEPTION 'SQL text cannot be empty';
  END IF;

  -- 先剥注释再校验：LLM 生成的 SQL 常带 -- 说明，注释里出现
  -- insert/drop 等词不该被误杀；反之注释里藏的黑名单调用也无处遁形。
  clean := regexp_replace(q, '/\*[\s\S]*?\*/', ' ', 'g');
  clean := regexp_replace(clean, '--[^\n]*', ' ', 'g');

  select_pos := position('select' in lower(clean));
  with_pos := position('with' in lower(clean));
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

  normalized_q := BTRIM(SUBSTRING(clean FROM start_pos));
  -- 允许一个行尾分号（LLM 常带），其余分号一律拒绝（防多语句）
  normalized_q := regexp_replace(normalized_q, ';\s*$', '');
  IF normalized_q = '' THEN
    RAISE EXCEPTION 'SQL text cannot be empty';
  END IF;
  IF POSITION(';' IN normalized_q) > 0 THEN
    RAISE EXCEPTION 'Semicolons are not allowed';
  END IF;

  -- 写类/DDL/事务语句
  IF normalized_q ~* '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|comment|commit|rollback|copy|call|do|vacuum|checkpoint|listen|notify|prepare|execute)\b' THEN
    RAISE EXCEPTION 'Only read-only queries are allowed';
  END IF;

  -- 危险函数：文件系统 / 大对象 / 外部连接 / 任意查询执行 / 会话上下文 / 睡眠
  IF normalized_q ~* '(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_current_logfile|pg_logdir_ls|lo_import|lo_export|lo_get|lo_put|lo_creat|lo_create|lo_unlink|dblink|pg_sleep|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_replication_origin|pg_replication_slot|pg_logical|pg_export_snapshot|pg_create_physical_replication_slot|pg_drop_replication_slot|set_config|current_setting|query_to_xml|query_to_xmlschema|query_to_xml_and_xmlschema|cursor_to_xml|table_to_xml|database_to_xml|pg_advisory|pg_try_advisory)' THEN
    RAISE EXCEPTION 'Forbidden function call detected (file/lo/dblink/config/sleep functions are not allowed)';
  END IF;

  -- 强制 LIMIT 封顶 + 计数：内层先 LIMIT row_cap+1，避免大结果集全量物化
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) FROM (SELECT * FROM (%s) _q LIMIT %s) t',
    normalized_q, row_cap + 1
  ) INTO fetched;

  row_count := jsonb_array_length(fetched);
  IF row_count > row_cap THEN
    truncated := TRUE;
    -- jsonb - integer：移除第 n 个元素（1-based），把多取的最后一行去掉
    fetched := fetched - row_count;
    row_count := row_cap;
  END IF;

  RETURN jsonb_build_object(
    'rows', COALESCE(fetched, '[]'::jsonb),
    'rowCount', COALESCE(row_count, 0),
    'truncated', truncated,
    'rowLimit', row_cap
  );
END $$;

-- ACL：显式收掉 anon（容器默认权限会给新函数白送 anon/authenticated 的 EXECUTE）
REVOKE ALL ON FUNCTION public.execute_ai_analysis(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_ai_analysis(TEXT) TO service_role;

COMMENT ON FUNCTION public.execute_ai_analysis(TEXT) IS
  'AI 分析只读执行器（deploy_81 加固版）：注释剥离 + 危险函数黑名单 + statement_timeout 5s + 强制 LIMIT 2000 + anon 无权';

-- ============================================================================
-- 自检
-- ============================================================================

DO $$
DECLARE
  v JSONB;
  blocked BOOLEAN;
  proconfig TEXT;
BEGIN
  RAISE NOTICE '--- deploy_81 自检 ---';

  -- 1. statement_timeout 已挂上
  SELECT array_to_string(p.proconfig, ',') INTO proconfig
  FROM pg_proc p WHERE p.oid = 'public.execute_ai_analysis(text)'::regprocedure;
  IF proconfig IS NULL OR position('statement_timeout' in proconfig) = 0 THEN
    RAISE EXCEPTION '自检失败：execute_ai_analysis 未设置 statement_timeout';
  END IF;
  RAISE NOTICE 'statement_timeout: %', proconfig;

  -- 2. 正常 SELECT 可用
  v := public.execute_ai_analysis('SELECT 1 AS one');
  IF (v->>'rowCount')::int <> 1 THEN
    RAISE EXCEPTION '自检失败：正常 SELECT 不可用';
  END IF;
  RAISE NOTICE '正常 SELECT: OK';

  -- 3. 危险函数被黑名单拦截
  blocked := FALSE;
  BEGIN
    PERFORM public.execute_ai_analysis('SELECT pg_sleep(1)');
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION '自检失败：pg_sleep 未被拦截';
  END IF;
  RAISE NOTICE 'pg_sleep 拦截: OK';

  -- 4. 危险调用 + 尾部注释：剥离注释后正文仍被拦截（验证注释剥离不放过正文）
  blocked := FALSE;
  BEGIN
    PERFORM public.execute_ai_analysis('SELECT pg_sleep(1) -- innocuous comment');
  EXCEPTION WHEN OTHERS THEN
    blocked := TRUE;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION '自检失败：危险调用 + 尾部注释未被拦截';
  END IF;
  RAISE NOTICE '注释剥离校验: OK';

  -- 5. 行数封顶
  v := public.execute_ai_analysis('SELECT generate_series(1, 5000) AS n');
  IF (v->>'rowCount')::int <> 2000 OR (v->>'truncated')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION '自检失败：行数封顶未生效（rowCount=%, truncated=%）', v->>'rowCount', v->>'truncated';
  END IF;
  RAISE NOTICE '行数封顶: OK (rowCount=%, truncated=%)', v->>'rowCount', v->>'truncated';

  -- 6. anon 无 EXECUTE
  IF has_function_privilege('anon', 'public.execute_ai_analysis(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '自检失败：anon 仍持有 execute_ai_analysis 的 EXECUTE';
  END IF;
  RAISE NOTICE 'anon 无权: OK';
END $$;

NOTIFY pgrst, 'reload schema';
