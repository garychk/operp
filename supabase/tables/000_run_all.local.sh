#!/bin/bash
# ============================================================================
# 把 supabase/tables/deploy_*.sql 按正确顺序灌进本地 Supabase 实例。
#
# 用法：
#   ./000_run_all.local.sh --check        # 只校验顺序与文件是否存在，不执行
#   ./000_run_all.local.sh                # 执行（每个脚本一个事务，失败即回滚并记录）
#   ./000_run_all.local.sh --allow-dirty  # 跳过「public 必须为空」的前置检查
#
# 环境变量：
#   DB_CONTAINER  指定数据库容器名，默认自动探测 supabase_db_*
#   LOG_DIR       日志目录，默认 ./../.deploy-logs
#
# 顺序即纯编号顺序，没有额外的前置步骤：
#   - deploy_24 ↔ deploy_25 的循环依赖已从上游根除（erp_bins 建表拆到 deploy_24_erp_bins.sql，
#     排在同号的 deploy_24_inventory_document_ops.sql 之前）；
#   - vector 扩展的 schema 问题已在 deploy_28 内修正（WITH SCHEMA extensions）。
#
# 建议：先 `supabase db reset` 拿到干净库再跑，因为 deploy_41/48/51 会给
#       「当时已存在的」表补 tenant_id —— 前置表缺失会被静默跳过，不会报错。
#
# 注意：`supabase db reset` 之后库不是立刻就稳定干净的 —— 实测 reset 返回后
#       约 90 秒内可能出现「旧 schema 又回来」的窗口。若在脏库上跑，deploy_01
#       会以 "relation ... already exists / duplicate key" 失败并整文件回滚，
#       后面 deploy_41/48/51 的静默跳过会让结果不可信。
#       所以这里做了「public 必须为空」的前置拦截；请 reset 后**立即**执行本脚本，
#       确需在已有数据上增量执行时用 --allow-dirty。
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/../.deploy-logs}"
CHECK_ONLY=0
ALLOW_DIRTY=0
for arg in "$@"; do
  [ "$arg" = "--check" ] && CHECK_ONLY=1
  [ "$arg" = "--allow-dirty" ] && ALLOW_DIRTY=1
done

ORDER=(
  deploy_01_schema_and_seed.sql
  deploy_02_permissions_core.sql
  deploy_03_system_rls_and_menu_permissions.sql
  deploy_04_apply_erp_table_rls.sql
  deploy_05_auth_super_admin.sql
  deploy_06_payables_source_fields.sql
  deploy_07_system_config.sql
  deploy_08_custom_pages.sql
  deploy_09_data_dictionary.sql
  deploy_10_quality_inspection.sql
  deploy_11_sys_forms_rls.sql
  deploy_12_baq.sql
  deploy_13_stock_posting_rpc.sql
  deploy_14_workflow_engine.sql
  deploy_15_document_types.sql
  deploy_16_workflow_routing_engine.sql
  deploy_17_voucher_posting_rpc.sql
  deploy_18_finance_reporting_views.sql
  deploy_19_accounting_period_controls.sql
  deploy_20_depreciation_and_settlement.sql
  deploy_21_finance_required_subjects.sql
  deploy_22_accounting_period_generation.sql
  deploy_23_fix_voucher_posting_rls.sql
  deploy_24_erp_bins.sql
  deploy_24_inventory_document_ops.sql
  deploy_25_ai_memory_and_knowledge.sql
  deploy_25_baq_catalog_for_ai.sql
  deploy_25_bins_and_location.sql
  deploy_26_ai_analysis_executor.sql
  deploy_27_ai_chat_sessions_and_messages.sql
  deploy_28_ai_rag.sql
  deploy_29_ai_chat_message_sources.sql
  deploy_30_fix_rag_dimension_nomic.sql
  deploy_31_notifications.sql
  deploy_32_document_naming.sql
  deploy_33_uom.sql
  deploy_34_outbound_inbound_location.sql
  deploy_35_doc_flow_engine.sql
  deploy_36_doc_flow_generalization.sql
  deploy_37_doc_flow_ledger_rule_ref.sql
  deploy_38_doc_flow_connections.sql
  deploy_39_ai_entity_catalog.sql
  deploy_40_inventory_transaction_types.sql
  deploy_41_tenant_isolation.sql
  deploy_42_ai_tenant.sql
  deploy_43_custom_access_token_hook.sql
  deploy_44_tenant_menu.sql
  deploy_45_sys_logs_tenant.sql
  deploy_46_ai_chat_tenant.sql
  deploy_47_naming_counter_tenant.sql
  deploy_48_platform_metadata_tenant.sql
  deploy_49_workflow_runtime_tenant.sql
  deploy_50_tenant_signup.sql
  deploy_51_erp_unique_key_tenant.sql
  deploy_52_platform_metadata_materialize.sql
  deploy_53_fix_sys_config_super_admin.sql
  deploy_54_auth_seed_users.sql
  deploy_55_mcp_api_keys.sql
  deploy_56_production_posting.sql
  deploy_57_bom_explosion_kit_check.sql
  deploy_58_production_receipt_and_locations.sql
  deploy_59_production_receipt_menu.sql
  deploy_60_mrp_planning_parameters.sql
  deploy_61_planned_conversion_and_cost.sql
  deploy_62_production_report_and_cost_menu.sql
  deploy_63_mps_master_schedule.sql
  deploy_64_mps_menu.sql
)

# ---------------------------------------------------------------- 文件自检
missing=0
for item in "${ORDER[@]}"; do
  if [ ! -f "$SCRIPT_DIR/$item" ]; then
    echo "缺失: $item"
    missing=$((missing + 1))
  fi
done
if [ "$missing" -gt 0 ]; then
  echo "有 $missing 个脚本不存在，中止。"
  exit 1
fi
echo "顺序校验通过：共 ${#ORDER[@]} 个步骤，文件齐全。"

if [ "$CHECK_ONLY" = "1" ]; then
  i=0
  for item in "${ORDER[@]}"; do
    i=$((i + 1))
    printf '%2d. %s\n' "$i" "$item"
  done
  exit 0
fi

# ---------------------------------------------------------------- 定位容器
if [ -z "${DB_CONTAINER:-}" ]; then
  DB_CONTAINER="$(docker ps --filter 'label=com.supabase.cli.project' --format '{{.Names}}' \
    | grep '^supabase_db_' | head -1)"
fi
if [ -z "${DB_CONTAINER:-}" ]; then
  echo "未找到本地 Supabase 数据库容器，请先执行 supabase start。"
  exit 1
fi
echo "目标容器：$DB_CONTAINER"

# ------------------------------------------------- 前置检查：public 必须为空
if [ "$ALLOW_DIRTY" = "0" ]; then
  existing="$(docker exec -i "$DB_CONTAINER" \
    psql -U postgres -d postgres -tAc \
    "select count(*) from information_schema.tables where table_schema='public';" 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$existing" ]; then
    echo "无法读取 public 表数量，请确认容器 $DB_CONTAINER 正常。"
    exit 1
  fi
  if [ "$existing" != "0" ]; then
    echo "public schema 已有 $existing 个对象（表 / 视图），拒绝在脏库上执行。"
    echo "  理由：deploy_41/48/51 只给「当时已存在的表」补 tenant_id，缺表会被静默跳过，"
    echo "        结果看似成功但前端会因 RLS fail-closed 整表不可见。"
    echo "  做法：先 supabase db reset，然后立即重跑本脚本（reset 后约 90 秒内库可能又变脏）；"
    echo "        确需增量执行时加 --allow-dirty。"
    exit 1
  fi
  echo "前置检查：public schema 为空 ✓"
fi
echo "日志目录：$LOG_DIR"

mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

# ---------------------------------------------------------------- 执行
total=0
failed=0
failed_list=""

for item in "${ORDER[@]}"; do
  name="${item%.sql}"
  total=$((total + 1))
  log="$LOG_DIR/$name.log"
  start=$(date +%s)
  if docker exec -i "$DB_CONTAINER" \
        psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction -q \
        -f - < "$SCRIPT_DIR/$item" > "$log" 2>&1; then
    printf 'OK    %-46s %2ss\n' "$name" "$(( $(date +%s) - start ))"
  else
    failed=$((failed + 1))
    failed_list="$failed_list $name"
    printf 'FAIL  %-46s %2ss\n' "$name" "$(( $(date +%s) - start ))"
  fi
done

echo "--------------------------------------------------"
echo "总计 $total 个步骤，失败 $failed 个"
if [ "$failed" -gt 0 ]; then
  echo "失败清单:$failed_list"
  echo "失败详情见 $LOG_DIR/<脚本名>.log"
  exit 1
fi
exit 0
