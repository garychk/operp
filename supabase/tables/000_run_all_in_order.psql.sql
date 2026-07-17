-- Supabase ERP consolidated database deployment runner.
-- Usage: run with psql from the repository root:
--   psql "<DATABASE_URL>" -f supabase/tables/000_run_all_in_order.psql.sql
--
-- Do not paste this whole file into Supabase SQL Editor. The \i directives are
-- psql meta commands. In SQL Editor, execute the four deploy_*.sql files one by one.

\i supabase/tables/deploy_01_schema_and_seed.sql
\i supabase/tables/deploy_02_permissions_core.sql
\i supabase/tables/deploy_03_system_rls_and_menu_permissions.sql
\i supabase/tables/deploy_04_apply_erp_table_rls.sql
\i supabase/tables/deploy_05_auth_super_admin.sql
\i supabase/tables/deploy_06_payables_source_fields.sql
\i supabase/tables/deploy_07_system_config.sql
\i supabase/tables/deploy_08_custom_pages.sql
