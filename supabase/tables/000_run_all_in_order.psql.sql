-- Supabase ERP consolidated database deployment runner.
-- Usage: run with psql from the repository root:
--   psql "<DATABASE_URL>" -f supabase/tables/000_run_all_in_order.psql.sql
--
-- Do not paste this whole file into Supabase SQL Editor. The \i directives are
-- psql meta commands. In SQL Editor, execute the deploy_*.sql files one by one.
--
-- 顺序必须与 ../000_run_all.local.sh 里的 ORDER 数组保持一致（共 62 个步骤）。
-- 顺序即纯编号顺序，没有额外的前置步骤：
--   - deploy_24_erp_bins.sql 与 deploy_24_inventory_document_ops.sql 同号，
--     前者天然排在前者之前，解开 24 <-> 25 的循环依赖（不要打乱这两个的相对次序）；
--   - deploy_25_ai_memory_and_knowledge.sql、deploy_25_baq_catalog_for_ai.sql、
--     deploy_25_bins_and_location.sql 三个同号脚本都必须在 deploy_24 之后。
-- 建议在干净库上执行；deploy_01 含初始 INSERT，重复跑会撞唯一约束。

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
\i supabase/tables/deploy_24_erp_bins.sql
\i supabase/tables/deploy_24_inventory_document_ops.sql
\i supabase/tables/deploy_25_ai_memory_and_knowledge.sql
\i supabase/tables/deploy_25_baq_catalog_for_ai.sql
\i supabase/tables/deploy_25_bins_and_location.sql

\i supabase/tables/deploy_26_ai_analysis_executor.sql
\i supabase/tables/deploy_27_ai_chat_sessions_and_messages.sql
\i supabase/tables/deploy_28_ai_rag.sql
\i supabase/tables/deploy_29_ai_chat_message_sources.sql
\i supabase/tables/deploy_30_fix_rag_dimension_nomic.sql
\i supabase/tables/deploy_31_notifications.sql
\i supabase/tables/deploy_32_document_naming.sql
\i supabase/tables/deploy_33_uom.sql
\i supabase/tables/deploy_34_outbound_inbound_location.sql
\i supabase/tables/deploy_35_doc_flow_engine.sql
\i supabase/tables/deploy_36_doc_flow_generalization.sql
\i supabase/tables/deploy_37_doc_flow_ledger_rule_ref.sql
\i supabase/tables/deploy_38_doc_flow_connections.sql
\i supabase/tables/deploy_39_ai_entity_catalog.sql

\i supabase/tables/deploy_40_inventory_transaction_types.sql
\i supabase/tables/deploy_41_tenant_isolation.sql
\i supabase/tables/deploy_42_ai_tenant.sql
\i supabase/tables/deploy_43_custom_access_token_hook.sql
\i supabase/tables/deploy_44_tenant_menu.sql
\i supabase/tables/deploy_45_sys_logs_tenant.sql
\i supabase/tables/deploy_46_ai_chat_tenant.sql
\i supabase/tables/deploy_47_naming_counter_tenant.sql
\i supabase/tables/deploy_48_platform_metadata_tenant.sql
\i supabase/tables/deploy_49_workflow_runtime_tenant.sql
\i supabase/tables/deploy_50_tenant_signup.sql
\i supabase/tables/deploy_51_erp_unique_key_tenant.sql
\i supabase/tables/deploy_52_platform_metadata_materialize.sql
\i supabase/tables/deploy_53_fix_sys_config_super_admin.sql
\i supabase/tables/deploy_54_auth_seed_users.sql
\i supabase/tables/deploy_55_mcp_api_keys.sql

\i supabase/tables/deploy_56_production_posting.sql
\i supabase/tables/deploy_57_bom_explosion_kit_check.sql
\i supabase/tables/deploy_58_production_receipt_and_locations.sql
\i supabase/tables/deploy_59_production_receipt_menu.sql
