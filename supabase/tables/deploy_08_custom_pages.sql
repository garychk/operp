CREATE TABLE IF NOT EXISTS public.sys_custom_pages (
  id SERIAL PRIMARY KEY, corp_id VARCHAR(128), emp_id VARCHAR(128), name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE, description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  menu_id INTEGER REFERENCES public.sys_menus(id) ON DELETE SET NULL,
  config JSONB NOT NULL DEFAULT '{"widgets":[]}'::jsonb, is_deleted CHAR(1) DEFAULT 'n',
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sys_custom_pages_status ON public.sys_custom_pages(status, is_deleted);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_custom_pages TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_custom_pages_id_seq TO authenticated;
ALTER TABLE public.sys_custom_pages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated users can read custom pages" ON public.sys_custom_pages;
CREATE POLICY "Authenticated users can read custom pages" ON public.sys_custom_pages FOR SELECT TO authenticated USING (is_deleted = 'n');
DROP POLICY IF EXISTS "Authenticated users can manage custom pages" ON public.sys_custom_pages;
CREATE POLICY "Authenticated users can manage custom pages" ON public.sys_custom_pages FOR ALL TO authenticated USING (true) WITH CHECK (true);
INSERT INTO public.sys_menus (parent_id, menu_name, menu_code, menu_type, icon, path, component, sort_order, status)
SELECT parent.id, '页面设计器', 'page_designer', 'C', 'AppstoreAddOutlined', '/system/page-designer', './features/page-builder/PageDesigner', 6, '1'
FROM public.sys_menus parent WHERE parent.menu_code = 'system'
AND NOT EXISTS (SELECT 1 FROM public.sys_menus WHERE menu_code = 'page_designer' AND is_deleted = 'n');
INSERT INTO public.sys_role_menus (role_id, menu_id)
SELECT role.id, menu.id FROM public.sys_roles role JOIN public.sys_menus menu ON menu.menu_code = 'page_designer'
WHERE role.role_code = 'super_admin' AND NOT EXISTS (SELECT 1 FROM public.sys_role_menus link WHERE link.role_id = role.id AND link.menu_id = menu.id);
