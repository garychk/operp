#!/bin/bash
# ============================================================================
# 云端版全量部署：把 supabase/tables/deploy_*.sql 灌进远程 Supabase 项目。
#
# 与 000_run_all.local.sh 的关系：ORDER 数组从 000_run_all.local.sh 动态解析，
# 保持单一事实来源；只把执行通道从 `docker exec` 换成远程 psql。
#
# 用法：
#   DATABASE_URL='postgresql://postgres.<ref>:<密码>@aws-0-<区域>.pooler.supabase.com:5432/postgres' \
#     ./100_run_all.cloud.sh                # 执行（public 必须为空）
#   ... ./100_run_all.cloud.sh --check     # 只校验顺序
#   ... ./100_run_all.cloud.sh --allow-dirty
#
# 说明：
#   - 云端没有 supabase db reset；清库 = DROP SCHEMA public CASCADE + 重建 + 还原
#     anon/authenticated/service_role 默认授权（见 .workbuddy/memory 里的云端流程）。
#   - 每个脚本一个事务（psql --single-transaction），失败即回滚并记录。
#   - 密码中的 @ 等特殊字符必须 URL 编码（@ -> %40）。
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_RUNNER="$SCRIPT_DIR/000_run_all.local.sh"
LOG_DIR="${LOG_DIR:-$SCRIPT_DIR/../.deploy-logs-cloud}"
PSQL_IMAGE="${PSQL_IMAGE:-postgres:15-alpine}"
CHECK_ONLY=0
ALLOW_DIRTY=0
for arg in "$@"; do
  [ "$arg" = "--check" ] && CHECK_ONLY=1
  [ "$arg" = "--allow-dirty" ] && ALLOW_DIRTY=1
done

# ---- 从本地 runner 解析 ORDER 数组（单一事实来源）----
ORDER=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"   # ltrim
  [ -n "$line" ] && ORDER+=("$line")
done < <(sed -n '/^ORDER=(/,/^)/p' "$LOCAL_RUNNER" \
         | grep -v '^ORDER=(' | grep -v '^)' | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')

if [ "${#ORDER[@]}" -eq 0 ]; then
  echo "无法从 $LOCAL_RUNNER 解析 ORDER 数组。"
  exit 1
fi

# ---- 文件自检 ----
missing=0
for item in "${ORDER[@]}"; do
  [ -f "$SCRIPT_DIR/$item" ] || { echo "缺失: $item"; missing=$((missing + 1)); }
done
if [ "$missing" -gt 0 ]; then
  echo "有 $missing 个脚本不存在，中止。"
  exit 1
fi
echo "顺序校验通过：共 ${#ORDER[@]} 个步骤，文件齐全。"

# ---- psql 执行函数（每步起新容器，避免常驻连接被 pooler 回收）----
run_psql() {  # stdin = SQL；附加 psql 参数放在 "$@"（会插在 -f - 之前）
  docker run --rm -i "$PSQL_IMAGE" \
    psql "$DATABASE_URL" "$@" -v ON_ERROR_STOP=1 --single-transaction -q -f -
}

if [ "$CHECK_ONLY" = "1" ]; then
  i=0
  for item in "${ORDER[@]}"; do
    i=$((i + 1)); printf '%2d. %s\n' "$i" "$item"
  done
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "缺少 DATABASE_URL 环境变量，用法见文件头注释。"
  exit 1
fi

# ---- 前置检查：public 必须为空 ----
if [ "$ALLOW_DIRTY" = "0" ]; then
  existing="$(echo "select count(*) from information_schema.tables where table_schema='public';" \
    | run_psql -tA 2>/dev/null | tr -d '[:space:]')"
  if [ -z "$existing" ]; then
    echo "无法读取 public 表数量，请确认 DATABASE_URL 可用。"
    exit 1
  fi
  if [ "$existing" != "0" ]; then
    echo "public schema 已有 $existing 个对象，拒绝在脏库上执行（理由同本地 runner：deploy_41/48/51 会静默跳过缺失表）。"
    echo "先执行云端清库，或加 --allow-dirty。"
    exit 1
  fi
  echo "前置检查：public schema 为空 ✓"
fi

echo "日志目录：$LOG_DIR"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

# ---- 执行 ----
total=0; failed=0; failed_list=""
for item in "${ORDER[@]}"; do
  name="${item%.sql}"
  total=$((total + 1))
  log="$LOG_DIR/$name.log"
  start=$(date +%s)
  if run_psql < "$SCRIPT_DIR/$item" > "$log" 2>&1; then
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
