-- Supabase ERP consolidated deployment script
-- Generated from smaller migration scripts for implementation convenience.
-- Source files:
--   supabase\tables\008_apply_sys_logs_role_rls.sql
--   supabase\tables\009_sys_users_self_profile_rls.sql
--   supabase\tables\010_apply_sys_menus_role_rls.sql
--   supabase\tables\012_allow_authenticated_read_active_sys_menus.sql
--   supabase\tables\013_create_current_user_menu_paths_rpc.sql
--   supabase\tables\014_create_current_user_is_super_admin_rpc.sql
--   supabase\tables\015_allow_manage_sys_role_menus.sql
--   supabase\tables\016_allow_manage_sys_user_roles.sql


-- ============================================================
-- Begin: supabase\tables\008_apply_sys_logs_role_rls.sql
-- ============================================================
-- Apply data-driven role table permissions to system logs.
-- Run 005 and 007 before this script.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_logs TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_logs_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_logs');

-- ============================================================
-- End: supabase\tables\008_apply_sys_logs_role_rls.sql
-- ============================================================

-- ============================================================
-- Begin: apply sys_config role RLS
-- ============================================================
-- Apply data-driven role table permissions to system configuration.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_config TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_config_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_config');

-- ============================================================
-- End: apply sys_config role RLS
-- ============================================================
-- ============================================================
-- Begin: supabase\tables\009_sys_users_self_profile_rls.sql
-- ============================================================
-- RLS policies required by AuthContext when sys_users has RLS enabled.
-- Users can read/create/update their own profile by auth_id; admins can still
-- manage sys_users through the data-driven table permission model.

GRANT SELECT, INSERT, UPDATE ON public.sys_users TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_users_id_seq TO authenticated;

ALTER TABLE public.sys_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own profile" ON public.sys_users;
CREATE POLICY "Users can read own profile"
ON public.sys_users
FOR SELECT
TO authenticated
USING (
  auth_id = auth.uid()
  AND is_deleted = 'n'
);

DROP POLICY IF EXISTS "Users can create own profile" ON public.sys_users;
CREATE POLICY "Users can create own profile"
ON public.sys_users
FOR INSERT
TO authenticated
WITH CHECK (
  auth_id = auth.uid()
  AND is_deleted = 'n'
);

DROP POLICY IF EXISTS "Users can update own profile" ON public.sys_users;
CREATE POLICY "Users can update own profile"
ON public.sys_users
FOR UPDATE
TO authenticated
USING (
  auth_id = auth.uid()
  AND is_deleted = 'n'
)
WITH CHECK (
  auth_id = auth.uid()
  AND is_deleted = 'n'
);

DROP POLICY IF EXISTS "Role table permission can read users" ON public.sys_users;
CREATE POLICY "Role table permission can read users"
ON public.sys_users
FOR SELECT
TO authenticated
USING (public.has_table_permission('sys_users', 'select'));

DROP POLICY IF EXISTS "Role table permission can insert users" ON public.sys_users;
CREATE POLICY "Role table permission can insert users"
ON public.sys_users
FOR INSERT
TO authenticated
WITH CHECK (public.has_table_permission('sys_users', 'insert'));

DROP POLICY IF EXISTS "Role table permission can update users" ON public.sys_users;
CREATE POLICY "Role table permission can update users"
ON public.sys_users
FOR UPDATE
TO authenticated
USING (public.has_table_permission('sys_users', 'update'))
WITH CHECK (public.has_table_permission('sys_users', 'update'));

-- ============================================================
-- End: supabase\tables\009_sys_users_self_profile_rls.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\010_apply_sys_menus_role_rls.sql
-- ============================================================
-- Apply data-driven role table permissions to system menus.
-- Run 005 and 007 before this script.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_menus TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_menus_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_menus');

-- ============================================================
-- End: supabase\tables\010_apply_sys_menus_role_rls.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\012_allow_authenticated_read_active_sys_menus.sql
-- ============================================================
-- Allow all authenticated users to read active menu definitions.
-- Menu visibility is still decided by sys_role_menus in the frontend auth flow;
-- this policy only prevents login/menu bootstrap from being blocked by sys_menus RLS.

GRANT SELECT ON public.sys_menus TO authenticated;

ALTER TABLE public.sys_menus ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read active menus" ON public.sys_menus;
CREATE POLICY "Authenticated users can read active menus"
ON public.sys_menus
FOR SELECT
TO authenticated
USING (
  is_deleted = 'n'
  AND status = '1'
);

-- ============================================================
-- End: supabase\tables\012_allow_authenticated_read_active_sys_menus.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\013_create_current_user_menu_paths_rpc.sql
-- ============================================================
-- Return menu paths visible to the currently authenticated user.
-- SECURITY DEFINER lets the login/menu bootstrap read role-menu links without
-- requiring broad client SELECT access to sys_role_menus.

CREATE OR REPLACE FUNCTION public.current_user_menu_paths()
RETURNS TABLE(path TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH current_roles AS (
    SELECT DISTINCT ur.role_id
    FROM public.sys_users u
    JOIN public.sys_user_roles ur ON ur.user_id = u.id
    WHERE u.auth_id = auth.uid()
      AND u.is_deleted = 'n'
      AND u.status = '1'
      AND ur.is_deleted = 'n'
      AND ur.role_id IS NOT NULL
  )
  SELECT DISTINCT m.path::TEXT
  FROM current_roles cr
  JOIN public.sys_roles r ON r.id = cr.role_id
  JOIN public.sys_role_menus rm ON rm.role_id = r.id
  JOIN public.sys_menus m ON m.id = rm.menu_id
  WHERE r.is_deleted = 'n'
    AND r.status = '1'
    AND rm.is_deleted = 'n'
    AND m.is_deleted = 'n'
    AND m.status = '1'
    AND m.path IS NOT NULL
    AND m.path <> '';
$$;

GRANT EXECUTE ON FUNCTION public.current_user_menu_paths() TO authenticated;

-- ============================================================
-- End: supabase\tables\013_create_current_user_menu_paths_rpc.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\014_create_current_user_is_super_admin_rpc.sql
-- ============================================================
-- Return whether the currently authenticated user has the super_admin role.

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.sys_users u
    JOIN public.sys_user_roles ur ON ur.user_id = u.id
    JOIN public.sys_roles r ON r.id = ur.role_id
    WHERE u.auth_id = auth.uid()
      AND u.is_deleted = 'n'
      AND u.status = '1'
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND r.role_code = 'super_admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.current_user_is_super_admin() TO authenticated;

-- ============================================================
-- End: supabase\tables\014_create_current_user_is_super_admin_rpc.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\015_allow_manage_sys_role_menus.sql
-- ============================================================
-- Allow authorized users to manage role-menu permission links.
-- This table backs the "角色管理 -> 权限 -> 菜单权限" editor.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_role_menus TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_role_menus_id_seq TO authenticated;

ALTER TABLE public.sys_role_menus ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can read role menu links" ON public.sys_role_menus;
CREATE POLICY "Authorized users can read role menu links"
ON public.sys_role_menus
FOR SELECT
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_roles', 'select')
  )
);

DROP POLICY IF EXISTS "Authorized users can insert role menu links" ON public.sys_role_menus;
CREATE POLICY "Authorized users can insert role menu links"
ON public.sys_role_menus
FOR INSERT
TO authenticated
WITH CHECK (
  COALESCE(is_deleted, 'n') = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_roles', 'update')
  )
);

DROP POLICY IF EXISTS "Authorized users can update role menu links" ON public.sys_role_menus;
CREATE POLICY "Authorized users can update role menu links"
ON public.sys_role_menus
FOR UPDATE
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_roles', 'update')
  )
)
WITH CHECK (
  COALESCE(is_deleted, 'n') = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_roles', 'update')
  )
);

DROP POLICY IF EXISTS "Authorized users can delete role menu links" ON public.sys_role_menus;
CREATE POLICY "Authorized users can delete role menu links"
ON public.sys_role_menus
FOR DELETE
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_roles', 'update')
  )
);

-- ============================================================
-- End: supabase\tables\015_allow_manage_sys_role_menus.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\016_allow_manage_sys_user_roles.sql
-- ============================================================
-- Allow authorized users to manage user-role links.
-- This table backs the "用户管理 -> 角色" editor and is also needed when
-- loading the current user's roles during login.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_user_roles TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_user_roles_id_seq TO authenticated;

ALTER TABLE public.sys_user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own role links" ON public.sys_user_roles;
CREATE POLICY "Users can read own role links"
ON public.sys_user_roles
FOR SELECT
TO authenticated
USING (
  is_deleted = 'n'
  AND user_id = public.current_sys_user_id()
);

DROP POLICY IF EXISTS "Authorized users can read user role links" ON public.sys_user_roles;
CREATE POLICY "Authorized users can read user role links"
ON public.sys_user_roles
FOR SELECT
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_users', 'select')
  )
);

DROP POLICY IF EXISTS "Authorized users can insert user role links" ON public.sys_user_roles;
CREATE POLICY "Authorized users can insert user role links"
ON public.sys_user_roles
FOR INSERT
TO authenticated
WITH CHECK (
  COALESCE(is_deleted, 'n') = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_users', 'update')
  )
);

DROP POLICY IF EXISTS "Authorized users can update user role links" ON public.sys_user_roles;
CREATE POLICY "Authorized users can update user role links"
ON public.sys_user_roles
FOR UPDATE
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_users', 'update')
  )
)
WITH CHECK (
  COALESCE(is_deleted, 'n') = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_users', 'update')
  )
);

DROP POLICY IF EXISTS "Authorized users can delete user role links" ON public.sys_user_roles;
CREATE POLICY "Authorized users can delete user role links"
ON public.sys_user_roles
FOR DELETE
TO authenticated
USING (
  is_deleted = 'n'
  AND (
    public.current_user_is_super_admin()
    OR public.has_table_permission('sys_users', 'update')
  )
);

-- ============================================================
-- End: supabase\tables\016_allow_manage_sys_user_roles.sql
-- ============================================================
