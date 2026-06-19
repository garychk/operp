-- Supabase ERP consolidated deployment script
-- Generated from smaller migration scripts for implementation convenience.
-- Source files:
--   supabase\tables\005_grant_system_management_permissions.sql
--   supabase\tables\006_sys_roles_rls_policies.sql
--   supabase\tables\007_create_role_table_permissions.sql


-- ============================================================
-- Begin: supabase\tables\005_grant_system_management_permissions.sql
-- ============================================================
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

-- ============================================================
-- End: supabase\tables\005_grant_system_management_permissions.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\006_sys_roles_rls_policies.sql
-- ============================================================
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

-- ============================================================
-- End: supabase\tables\006_sys_roles_rls_policies.sql
-- ============================================================

-- ============================================================
-- Begin: supabase\tables\007_create_role_table_permissions.sql
-- ============================================================
-- Data-driven table permissions for role-based RLS.
-- Frontend pages maintain rows in sys_role_table_permissions; table RLS policies
-- can call has_table_permission(table_name, action_name) to enforce them.

CREATE TABLE IF NOT EXISTS public.sys_tables (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    table_name VARCHAR(128) NOT NULL UNIQUE,
    table_label VARCHAR(128) NOT NULL,
    module_name VARCHAR(64) DEFAULT 'system',
    status CHAR(1) DEFAULT '1',
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.sys_role_table_permissions (
    id SERIAL PRIMARY KEY,
    corp_id VARCHAR(128),
    emp_id VARCHAR(128),
    role_id INTEGER NOT NULL REFERENCES public.sys_roles(id) ON DELETE CASCADE,
    table_id INTEGER NOT NULL REFERENCES public.sys_tables(id) ON DELETE CASCADE,
    can_select BOOLEAN DEFAULT FALSE,
    can_insert BOOLEAN DEFAULT FALSE,
    can_update BOOLEAN DEFAULT FALSE,
    can_delete BOOLEAN DEFAULT FALSE,
    is_deleted CHAR(1) DEFAULT 'n',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(role_id, table_id)
);

CREATE INDEX IF NOT EXISTS idx_sys_tables_table_name
  ON public.sys_tables(table_name);

CREATE INDEX IF NOT EXISTS idx_sys_role_table_permissions_role
  ON public.sys_role_table_permissions(role_id);

CREATE INDEX IF NOT EXISTS idx_sys_role_table_permissions_table
  ON public.sys_role_table_permissions(table_id);

CREATE OR REPLACE FUNCTION public.refresh_sys_tables()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.sys_tables (table_name, table_label, module_name)
  SELECT
    table_name,
    table_name,
    CASE
      WHEN table_name LIKE 'sys_%' THEN 'system'
      WHEN table_name LIKE 'erp_%' THEN 'erp'
      ELSE 'business'
    END
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND table_name NOT IN ('sys_tables', 'sys_role_table_permissions')
  ON CONFLICT (table_name) DO UPDATE SET
    module_name = EXCLUDED.module_name,
    is_deleted = 'n',
    status = '1',
    updated_at = NOW();
$$;

SELECT public.refresh_sys_tables();

CREATE OR REPLACE FUNCTION public.current_sys_user_id()
RETURNS INTEGER
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.sys_users
  WHERE auth_id = auth.uid()
    AND is_deleted = 'n'
    AND status = '1'
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.has_table_permission(target_table_name TEXT, action_name TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_user_id INTEGER;
BEGIN
  current_user_id := public.current_sys_user_id();

  IF current_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND r.role_code = 'super_admin'
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.sys_user_roles ur
    JOIN public.sys_roles r ON r.id = ur.role_id
    JOIN public.sys_role_table_permissions rp ON rp.role_id = r.id
    JOIN public.sys_tables t ON t.id = rp.table_id
    WHERE ur.user_id = current_user_id
      AND ur.is_deleted = 'n'
      AND r.is_deleted = 'n'
      AND r.status = '1'
      AND rp.is_deleted = 'n'
      AND t.is_deleted = 'n'
      AND t.status = '1'
      AND t.table_name = target_table_name
      AND CASE action_name
        WHEN 'select' THEN rp.can_select
        WHEN 'insert' THEN rp.can_insert
        WHEN 'update' THEN rp.can_update
        WHEN 'delete' THEN rp.can_delete
        ELSE FALSE
      END
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.install_role_table_rls(target_table_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name = target_table_name
  ) THEN
    RAISE EXCEPTION 'public.% does not exist', target_table_name;
  END IF;

  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target_table_name);

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_select_' || target_table_name, target_table_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.has_table_permission(%L, %L))',
    'role_select_' || target_table_name,
    target_table_name,
    target_table_name,
    'select'
  );

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_insert_' || target_table_name, target_table_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.has_table_permission(%L, %L))',
    'role_insert_' || target_table_name,
    target_table_name,
    target_table_name,
    'insert'
  );

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_update_' || target_table_name, target_table_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.has_table_permission(%L, %L)) WITH CHECK (public.has_table_permission(%L, %L))',
    'role_update_' || target_table_name,
    target_table_name,
    target_table_name,
    'update',
    target_table_name,
    'update'
  );

  EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'role_delete_' || target_table_name, target_table_name);
  EXECUTE format(
    'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.has_table_permission(%L, %L))',
    'role_delete_' || target_table_name,
    target_table_name,
    target_table_name,
    'delete'
  );
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_tables TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_tables_id_seq TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_role_table_permissions TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_role_table_permissions_id_seq TO authenticated;

GRANT EXECUTE ON FUNCTION public.current_sys_user_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_table_permission(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_sys_tables() TO authenticated;

ALTER TABLE public.sys_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sys_role_table_permissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read permission tables" ON public.sys_tables;
CREATE POLICY "Authenticated users can read permission tables"
ON public.sys_tables
FOR SELECT
TO authenticated
USING (is_deleted = 'n');

DROP POLICY IF EXISTS "Authenticated users can manage table permissions" ON public.sys_role_table_permissions;
CREATE POLICY "Authenticated users can manage table permissions"
ON public.sys_role_table_permissions
FOR ALL
TO authenticated
USING (is_deleted = 'n')
WITH CHECK (is_deleted = 'n');

-- ============================================================
-- End: supabase\tables\007_create_role_table_permissions.sql
-- ============================================================
