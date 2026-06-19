-- Allow logged-in users to maintain system users, roles, menus, and permission links
-- from the frontend system management pages.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_user_roles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_user_roles_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_users TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_users_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_roles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_roles_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_menus TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_menus_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_role_menus TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_role_menus_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_logs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_logs_id_seq TO authenticated;
