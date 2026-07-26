-- BAQ metadata, catalog and guarded query execution.
CREATE TABLE IF NOT EXISTS public.sys_baq_queries (
  id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128),
  code VARCHAR(100) NOT NULL UNIQUE, name VARCHAR(150) NOT NULL, description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  definition JSONB NOT NULL DEFAULT '{"source":{"table":"","alias":"t0"},"joins":[],"fields":[],"filters":[],"sorts":[]}'::jsonb,
  is_deleted CHAR(1) NOT NULL DEFAULT 'n', created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_baq_queries TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_baq_queries_id_seq TO authenticated;
ALTER TABLE public.sys_baq_queries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BAQ select" ON public.sys_baq_queries;
CREATE POLICY "BAQ select" ON public.sys_baq_queries FOR SELECT TO authenticated USING (is_deleted='n' AND public.has_table_permission('sys_baq_queries','select'));
DROP POLICY IF EXISTS "BAQ insert" ON public.sys_baq_queries;
CREATE POLICY "BAQ insert" ON public.sys_baq_queries FOR INSERT TO authenticated WITH CHECK (public.has_table_permission('sys_baq_queries','insert'));
DROP POLICY IF EXISTS "BAQ update" ON public.sys_baq_queries;
CREATE POLICY "BAQ update" ON public.sys_baq_queries FOR UPDATE TO authenticated USING (public.has_table_permission('sys_baq_queries','update')) WITH CHECK (public.has_table_permission('sys_baq_queries','update'));
DROP POLICY IF EXISTS "BAQ delete" ON public.sys_baq_queries;
CREATE POLICY "BAQ delete" ON public.sys_baq_queries FOR DELETE TO authenticated USING (public.has_table_permission('sys_baq_queries','delete'));

CREATE OR REPLACE FUNCTION public.baq_catalog() RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('table',x.table_name,'label',COALESCE(t.table_label,x.table_name),'columns',x.columns) ORDER BY x.table_name),'[]'::jsonb)
 FROM (SELECT c.table_name,jsonb_agg(jsonb_build_object('name',c.column_name,'type',c.data_type) ORDER BY c.ordinal_position) columns
   FROM information_schema.columns c WHERE c.table_schema='public'
   AND (c.table_name LIKE 'erp\_%' ESCAPE '\' OR c.table_name='sys_baq_queries')
   AND public.has_table_permission(c.table_name,'select') GROUP BY c.table_name) x
 LEFT JOIN public.sys_tables t ON t.table_name=x.table_name AND t.is_deleted='n';
$$;

CREATE OR REPLACE FUNCTION public.execute_baq(query_code TEXT, page_number INTEGER DEFAULT 1, page_size INTEGER DEFAULT 100)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
 d JSONB; j JSONB; src JSONB; tn TEXT; ta TEXT; q TEXT; sels TEXT:=''; joins TEXT:=''; wh TEXT:=''; grp TEXT:=''; ord TEXT:='';
 col TEXT; agg TEXT; al TEXT; op TEXT; val TEXT; rows JSONB; total BIGINT;
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
   OR j->>'leftAlias'!~'^[a-z][a-z0-9_]*$' OR j->>'leftField'!~'^[a-z][a-z0-9_]*$' OR j->>'rightField'!~'^[a-z][a-z0-9_]*$' THEN RAISE EXCEPTION 'Invalid or unauthorized join'; END IF;
  joins:=joins||format(' %s JOIN public.%I %I ON %I.%I=%I.%I',upper(j->>'type'),tn,ta,j->>'leftAlias',j->>'leftField',ta,j->>'rightField');
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
GRANT EXECUTE ON FUNCTION public.baq_catalog() TO authenticated;
GRANT EXECUTE ON FUNCTION public.execute_baq(TEXT,INTEGER,INTEGER) TO authenticated;

CREATE OR REPLACE FUNCTION public.update_table_label(target_table_id INTEGER, new_label TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT COALESCE(public.current_user_is_super_admin(),FALSE) THEN
  RAISE EXCEPTION 'Only super administrators can maintain table labels';
 END IF;
 IF NULLIF(BTRIM(new_label),'') IS NULL THEN
  RAISE EXCEPTION 'Table label cannot be empty';
 END IF;
 UPDATE public.sys_tables SET table_label=BTRIM(new_label),updated_at=NOW()
 WHERE id=target_table_id AND is_deleted='n';
 IF NOT FOUND THEN RAISE EXCEPTION 'Table metadata % does not exist',target_table_id; END IF;
 RETURN TRUE;
END $$;
GRANT EXECUTE ON FUNCTION public.update_table_label(INTEGER,TEXT) TO authenticated;

SELECT public.refresh_sys_tables();
INSERT INTO public.sys_menus(parent_id,menu_name,menu_code,menu_type,icon,path,component,sort_order,status)
SELECT p.id,'BAQ管理','baq_designer','C','DatabaseOutlined','/system/baq','./features/baq/BaqDesigner',7,'1' FROM public.sys_menus p WHERE p.menu_code='system'
AND NOT EXISTS(SELECT 1 FROM public.sys_menus WHERE menu_code='baq_designer' AND is_deleted='n');
INSERT INTO public.sys_role_menus(role_id,menu_id) SELECT r.id,m.id FROM public.sys_roles r JOIN public.sys_menus m ON m.menu_code='baq_designer'
WHERE r.role_code='super_admin' AND NOT EXISTS(SELECT 1 FROM public.sys_role_menus x WHERE x.role_id=r.id AND x.menu_id=m.id);
