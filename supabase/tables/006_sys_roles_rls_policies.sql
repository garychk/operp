-- RLS policies for sys_roles.
-- Keep role options readable for logged-in users while filtering soft-deleted rows.
ALTER TABLE public.sys_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read active roles" ON public.sys_roles;
CREATE POLICY "Authenticated users can read active roles"
ON public.sys_roles
FOR SELECT
TO authenticated
USING (is_deleted = 'n');

DROP POLICY IF EXISTS "Authenticated users can insert roles" ON public.sys_roles;
CREATE POLICY "Authenticated users can insert roles"
ON public.sys_roles
FOR INSERT
TO authenticated
WITH CHECK (is_deleted = 'n');

DROP POLICY IF EXISTS "Authenticated users can update roles" ON public.sys_roles;
CREATE POLICY "Authenticated users can update roles"
ON public.sys_roles
FOR UPDATE
TO authenticated
USING (is_deleted = 'n')
WITH CHECK (is_deleted = 'n');

DROP POLICY IF EXISTS "Authenticated users can delete roles" ON public.sys_roles;
CREATE POLICY "Authenticated users can delete roles"
ON public.sys_roles
FOR DELETE
TO authenticated
USING (is_deleted = 'n');
