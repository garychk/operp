CREATE TABLE IF NOT EXISTS public.sys_dict_types (
  id SERIAL PRIMARY KEY,
  code VARCHAR(100) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  status CHAR(1) DEFAULT '1',
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_dict_items (
  id SERIAL PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES public.sys_dict_types(id) ON DELETE CASCADE,
  code VARCHAR(100) NOT NULL,
  label VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  status CHAR(1) DEFAULT '1',
  is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(type_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_dict_types, public.sys_dict_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_dict_types_id_seq, public.sys_dict_items_id_seq TO authenticated;
ALTER TABLE public.sys_dict_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sys_dict_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can manage dictionary types" ON public.sys_dict_types;
CREATE POLICY "Authenticated users can manage dictionary types" ON public.sys_dict_types FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "Authenticated users can manage dictionary items" ON public.sys_dict_items;
CREATE POLICY "Authenticated users can manage dictionary items" ON public.sys_dict_items FOR ALL TO authenticated USING (true) WITH CHECK (true);
SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_dict_types');
SELECT public.install_role_table_rls('sys_dict_items');
INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status)
SELECT parent.id, '数据字典', 'dictionaries', 'C', 'BookOutlined', '/system/dictionaries', './pages/system/Dictionaries', 50, '1'
FROM public.sys_menus parent WHERE parent.menu_code = 'system'
AND NOT EXISTS (SELECT 1 FROM public.sys_menus WHERE menu_code = 'dictionaries' AND is_deleted = 'n');
INSERT INTO public.sys_role_menus (role_id, menu_id)
SELECT r.id, m.id FROM public.sys_roles r JOIN public.sys_menus m ON m.menu_code = 'dictionaries'
WHERE r.role_code = 'super_admin' AND NOT EXISTS (SELECT 1 FROM public.sys_role_menus x WHERE x.role_id = r.id AND x.menu_id = m.id);
