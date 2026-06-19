-- Apply data-driven role table permissions to ERP business tables only.
-- This intentionally excludes sys_* tables to avoid locking the auth and
-- permission bootstrap tables behind their own RLS checks.
-- Run 005 and 007 before this script.

DO $$
DECLARE
  table_record RECORD;
BEGIN
  PERFORM public.refresh_sys_tables();

  FOR table_record IN
    SELECT table_name
    FROM public.sys_tables
    WHERE is_deleted = 'n'
      AND status = '1'
      AND table_name LIKE 'erp\_%' ESCAPE '\'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated',
      table_record.table_name
    );

    IF EXISTS (
      SELECT 1
      FROM pg_class sequence_class
      JOIN pg_namespace sequence_schema ON sequence_schema.oid = sequence_class.relnamespace
      WHERE sequence_schema.nspname = 'public'
        AND sequence_class.relkind = 'S'
        AND sequence_class.relname = table_record.table_name || '_id_seq'
    ) THEN
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE public.%I TO authenticated',
        table_record.table_name || '_id_seq'
      );
    END IF;

    PERFORM public.install_role_table_rls(table_record.table_name);
  END LOOP;
END $$;
