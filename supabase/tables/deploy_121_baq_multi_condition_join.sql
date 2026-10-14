-- BAQ 关联支持「多字段条件」。
--
-- 背景：一条 join 原来只有一个字段对（leftField = rightField），而现实业务里
-- 关联经常要多字段一起 AND，例如：
--   物料.code = 单据明细.material_code AND 物料.tenant_id = 单据明细.tenant_id
-- 也可能不用主外键、而用业务编码关联（code = code），这类关联不来自外键元数据。
--
-- definition.joins[i] 新增可选键 conditions：
--   {id,type,table,alias,leftAlias,leftField,rightField,
--    conditions:[{leftField,rightField},{leftField,rightField},...]}
-- 语义：conditions 为**完整条件列表**（含第一对），多对之间用 AND 连接；
--       leftField/rightField 保留为 conditions[0] 的镜像，兼容旧版函数与
--       AI 设计链路（旧读取方只会用到第一对条件）。
-- 未给 conditions 时按老样子只用 leftField/rightField，历史数据不受影响。

CREATE OR REPLACE FUNCTION public.execute_baq(query_code TEXT, page_number INTEGER DEFAULT 1, page_size INTEGER DEFAULT 100)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
 d JSONB; j JSONB; src JSONB; tn TEXT; ta TEXT; q TEXT; sels TEXT:=''; joins TEXT:=''; wh TEXT:=''; grp TEXT:=''; ord TEXT:='';
 col TEXT; agg TEXT; al TEXT; op TEXT; val TEXT; rows JSONB; total BIGINT;
 conds JSONB; c JSONB; on_txt TEXT;
 pg INTEGER:=GREATEST(COALESCE(page_number,1),1); sz INTEGER:=LEAST(GREATEST(COALESCE(page_size,100),1),500);
BEGIN
 SELECT definition INTO d FROM public.sys_baq_queries WHERE code=query_code AND is_deleted='n';
 IF d IS NULL THEN RAISE EXCEPTION 'BAQ % is unavailable',query_code; END IF;
 src:=d->'source'; tn:=src->>'table'; ta:=COALESCE(NULLIF(src->>'alias',''),'t0');
 IF tn!~'^[a-z][a-z0-9_]*$' OR ta!~'^[a-z][a-z0-9_]*$' OR to_regclass('public.'||tn) IS NULL OR NOT public.has_table_permission(tn,'select') THEN RAISE EXCEPTION 'Invalid or unauthorized source'; END IF;
 q:=format(' FROM public.%I %I',tn,ta);
 FOR j IN SELECT value FROM jsonb_array_elements(COALESCE(d->'joins','[]')) LOOP
  tn:=j->>'table'; ta:=j->>'alias';
  IF tn!~'^[a-z][a-z0-9_]*$' OR ta!~'^[a-z][a-z0-9_]*$' OR j->>'type' NOT IN ('inner','left') OR NOT public.has_table_permission(tn,'select')
   OR j->>'leftAlias'!~'^[a-z][a-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid or unauthorized join'; END IF;
  -- 关联条件：优先 conditions 数组（多字段 AND），否则回退到单对 leftField/rightField
  IF jsonb_typeof(j->'conditions')='array' AND jsonb_array_length(j->'conditions')>0 THEN
   conds:=j->'conditions';
  ELSE
   conds:=jsonb_build_array(jsonb_build_object('leftField',j->>'leftField','rightField',j->>'rightField'));
  END IF;
  on_txt:='';
  FOR c IN SELECT value FROM jsonb_array_elements(conds) LOOP
   IF c->>'leftField'!~'^[a-z][a-z0-9_]*$' OR c->>'rightField'!~'^[a-z][a-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid join condition'; END IF;
   on_txt:=on_txt||CASE WHEN on_txt='' THEN '' ELSE ' AND ' END||format('%I.%I=%I.%I',j->>'leftAlias',c->>'leftField',ta,c->>'rightField');
  END LOOP;
  joins:=joins||format(' %s JOIN public.%I %I ON %s',upper(j->>'type'),tn,ta,on_txt);
 END LOOP; q:=q||joins;
 FOR j IN SELECT value FROM jsonb_array_elements(COALESCE(d->'fields','[]')) LOOP
  IF j->>'tableAlias'!~'^[a-z][a-z0-9_]*$' OR j->>'field'!~'^[a-z][a-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid field'; END IF;
  col:=format('%I.%I',j->>'tableAlias',j->>'field'); agg:=COALESCE(j->>'aggregate','none');
  IF agg NOT IN ('none','sum','count','avg','min','max') THEN RAISE EXCEPTION 'Invalid aggregate'; END IF;
  IF agg<>'none' THEN col:=format('%s(%s)',upper(agg),col); END IF;
  al:=COALESCE(NULLIF(j->>'alias',''),j->>'field'); IF al!~'^[[:alpha:]_][[:alnum:]_]*$' THEN RAISE EXCEPTION 'Invalid alias'; END IF;
  sels:=sels||CASE WHEN sels='' THEN '' ELSE ',' END||format('%s AS %I',col,al);
  IF COALESCE((j->>'groupBy')::boolean,false) THEN grp:=grp||CASE WHEN grp='' THEN ' GROUP BY ' ELSE ',' END||format('%I.%I',j->>'tableAlias',j->>'field'); END IF;
 END LOOP; IF sels='' THEN RAISE EXCEPTION 'Select at least one field'; END IF;
 FOR j IN SELECT value FROM jsonb_array_elements(COALESCE(d->'filters','[]')) LOOP
  op:=j->>'operator'; IF j->>'tableAlias'!~'^[a-z][a-z0-9_]*$' OR j->>'field'!~'^[a-z][a-z0-9_]*$' OR op NOT IN ('eq','neq','gt','gte','lt','lte','like','is_null','not_null') THEN RAISE EXCEPTION 'Invalid filter'; END IF;
  col:=format('%I.%I',j->>'tableAlias',j->>'field'); val:=j->>'value'; wh:=wh||CASE WHEN wh='' THEN ' WHERE ' ELSE ' AND ' END||col||CASE op
   WHEN 'eq' THEN format('=%L',val) WHEN 'neq' THEN format('<>%L',val) WHEN 'gt' THEN format('>%L',val) WHEN 'gte' THEN format('>=%L',val)
   WHEN 'lt' THEN format('<%L',val) WHEN 'lte' THEN format('<=%L',val) WHEN 'like' THEN format(' ILIKE %L','%'||val||'%') WHEN 'is_null' THEN ' IS NULL' WHEN 'not_null' THEN ' IS NOT NULL' END;
 END LOOP;
 FOR j IN SELECT value FROM jsonb_array_elements(COALESCE(d->'sorts','[]')) LOOP
  al:=j->>'fieldAlias'; IF al!~'^[[:alpha:]_][[:alnum:]_]*$' OR lower(j->>'direction') NOT IN ('asc','desc') THEN RAISE EXCEPTION 'Invalid sort'; END IF;
  ord:=ord||CASE WHEN ord='' THEN ' ORDER BY ' ELSE ',' END||format('%I %s',al,upper(j->>'direction'));
 END LOOP;
 EXECUTE format('SELECT count(*) FROM (SELECT %s%s%s%s) z',sels,q,wh,grp) INTO total;
 EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(z)),''[]'') FROM (SELECT %s%s%s%s%s LIMIT %s OFFSET %s) z',sels,q,wh,grp,ord,sz,(pg-1)*sz) INTO rows;
 RETURN jsonb_build_object('rows',rows,'total',total,'page',pg,'pageSize',sz);
END $$;

-- 自检（fail-loud）：确认替换后的函数确实带上了多字段条件逻辑，
-- 且没有把旧版的单字段校验遗留成唯一入口
DO $$
DECLARE
  v_src TEXT;
BEGIN
  SELECT pg_get_functiondef('public.execute_baq(text,integer,integer)'::regprocedure) INTO v_src;

  IF position('conditions' IN v_src) = 0 THEN
    RAISE EXCEPTION 'deploy_121 自检失败：execute_baq 未包含 conditions 分支';
  END IF;

  IF position('Invalid join condition' IN v_src) = 0 THEN
    RAISE EXCEPTION 'deploy_121 自检失败：execute_baq 未包含多条件字段校验';
  END IF;

  IF position($needle$%s JOIN public.%I %I ON %s$needle$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'deploy_121 自检失败：JOIN 片段未改为可变条件拼接';
  END IF;

  -- 旧写法（硬编码单对字段的 JOIN 模板）不允许再出现
  IF position($needle$%s JOIN public.%I %I ON %I.%I=%I.%I$needle$ IN v_src) > 0 THEN
    RAISE EXCEPTION 'deploy_121 自检失败：execute_baq 仍是单字段关联模板';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'execute_baq' AND p.prosecdef = FALSE
  ) THEN
    RAISE EXCEPTION 'deploy_121 自检失败：execute_baq 应保持 SECURITY INVOKER';
  END IF;

  RAISE NOTICE 'deploy_121 OK：execute_baq 支持 conditions 多字段 AND 关联，单字段老数据仍兼容';
END;
$$;

NOTIFY pgrst, 'reload schema';
