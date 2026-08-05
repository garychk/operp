-- Supabase ERP consolidated database deployment runner.
-- Usage: run with psql from the repository root:
--   psql "<DATABASE_URL>" -f supabase/tables/000_run_all_in_order.psql.sql
--
-- Do not paste this whole file into Supabase SQL Editor. The \i directives are
-- psql meta commands. In SQL Editor, execute the deploy_*.sql files one by one.

\i supabase/tables/deploy_01_schema_and_seed.sql
\i supabase/tables/deploy_02_permissions_core.sql
\i supabase/tables/deploy_03_system_rls_and_menu_permissions.sql
\i supabase/tables/deploy_04_apply_erp_table_rls.sql
\i supabase/tables/deploy_05_auth_super_admin.sql
\i supabase/tables/deploy_06_payables_source_fields.sql
\i supabase/tables/deploy_07_system_config.sql
\i supabase/tables/deploy_08_custom_pages.sql

\i supabase/tables/deploy_09_data_dictionary.sql
\i supabase/tables/deploy_10_quality_inspection.sql
\i supabase/tables/deploy_11_sys_forms_rls.sql
\i supabase/tables/deploy_12_baq.sql
\i supabase/tables/deploy_13_stock_posting_rpc.sql

\i supabase/tables/deploy_14_workflow_engine.sql
\i supabase/tables/deploy_15_document_types.sql
\i supabase/tables/deploy_16_workflow_routing_engine.sql
\i supabase/tables/deploy_17_voucher_posting_rpc.sql
\i supabase/tables/deploy_18_finance_reporting_views.sql
\i supabase/tables/deploy_19_accounting_period_controls.sql
\i supabase/tables/deploy_20_depreciation_and_settlement.sql
\i supabase/tables/deploy_21_finance_required_subjects.sql
\i supabase/tables/deploy_22_accounting_period_generation.sql
\i supabase/tables/deploy_23_fix_voucher_posting_rls.sql
