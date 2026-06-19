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
