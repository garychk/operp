-- Allow authenticated clients to load and save form/print-template settings.
-- This script is idempotent and can be run independently on existing databases.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sys_forms TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.sys_forms_id_seq TO authenticated;

SELECT public.refresh_sys_tables();
SELECT public.install_role_table_rls('sys_forms');
