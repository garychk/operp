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
\i supabase/tables/deploy_24_inventory_document_ops.sql
\i supabase/tables/deploy_25_ai_memory_and_knowledge.sql
\i supabase/tables/deploy_25_baq_catalog_for_ai.sql
\i supabase/tables/deploy_26_ai_analysis_executor.sql
\i supabase/tables/deploy_27_ai_chat_sessions_and_messages.sql
\i supabase/tables/deploy_28_ai_rag.sql
\i supabase/tables/deploy_29_ai_chat_message_sources.sql
