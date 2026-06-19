-- Apply data-driven role table permissions to system menus.
-- Run 005 and 007 before this script.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_menus TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_menus_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_menus');
