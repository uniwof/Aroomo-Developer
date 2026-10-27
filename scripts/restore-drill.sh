#!/usr/bin/env bash
# 恢复演练脚本：在隔离的 compose 项目里从最新快照恢复并校验，结束后清理并输出耗时报告。
#
# 用法：
#   scripts/restore-drill.sh [--keep-running] [snapshot-id]
#
# 环境变量（可从 deploy/.env 读取，也可单独指定）：
#   RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deploy="$here/../deploy"

keep_running=0
snapshot="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-running)
      keep_running=1
      shift
      ;;
    *)
      snapshot="$1"
      shift
      ;;
  esac
done

# 如果 deploy/.env 存在，载入其变量（若环境变量未设置）
if [[ -f "$deploy/.env" ]]; then
  set -a
  # shellcheck source=/dev/null disable=SC1091
  source "$deploy/.env"
  set +a
fi

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY 未设置}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD 未设置}"

rand_id=$(( RANDOM % 90000 + 10000 ))
project_name="aroomo-drill-$rand_id"

# 如果使用本地目录作为 restic 仓库（如 file:// 或本地路径），共享宿主机目录；S3/HTTP 仓库不受影响
extra_volumes=()
if [[ "$RESTIC_REPOSITORY" =~ ^file:// || "$RESTIC_REPOSITORY" =~ ^/ ]]; then
  repo_dir="${RESTIC_REPOSITORY#file://}"
  extra_volumes+=("-v" "$repo_dir:$repo_dir")
fi

tmp_env="$(mktemp)"
cleanup() {
  local exit_code=$?
  rm -f "$tmp_env"
  if [[ "$keep_running" -eq 0 ]]; then
    echo "drill: 清理临时演练环境 ($project_name)..." >&2
    docker compose --project-name "$project_name" --project-directory "$deploy" down -v --remove-orphans >/dev/null 2>&1 || true
  else
    echo "drill: 已保留演练容器 ($project_name)" >&2
  fi
  if [[ $exit_code -ne 0 ]]; then
    echo "drill: 演练失败！" >&2
  fi
}
trap cleanup EXIT

# 生成临时 env 文件
if [[ -f "$deploy/.env" ]]; then
  cp "$deploy/.env" "$tmp_env"
else
  sed 's/CHANGE_ME/placeholder/g' "$deploy/.env.example" > "$tmp_env"
fi

started_all=$(date +%s)
echo "======================================================="
echo "       Aroomo 恢复演练 (Project: $project_name)"
echo "======================================================="
echo "演练开始时间: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
echo "使用快照: $snapshot"
echo "-------------------------------------------------------"

started_step=$(date +%s)
echo "drill: [1/4] 启动隔离的 PostgreSQL 与 RustFS 容器..."
docker compose --project-name "$project_name" --project-directory "$deploy" --env-file "$tmp_env" \
  -f "$deploy/docker-compose.yml" \
  up -d postgres rustfs >/dev/null

echo "drill: 等待 PostgreSQL 准备就绪..."
until docker compose --project-name "$project_name" --project-directory "$deploy" --env-file "$tmp_env" \
  exec -T postgres pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do
  sleep 1
done
step1_duration=$(( $(date +%s) - started_step ))
echo "drill: 隔离数据库服务就绪 (用时 ${step1_duration}s)"

started_step=$(date +%s)
echo "drill: [2/4] 从快照 $snapshot 恢复数据库与文件..."
docker compose --project-name "$project_name" --project-directory "$deploy" --env-file "$tmp_env" \
  --profile backup run --rm \
  "${extra_volumes[@]}" \
  -e RESTIC_REPOSITORY="$RESTIC_REPOSITORY" \
  -e RESTIC_PASSWORD="$RESTIC_PASSWORD" \
  -e AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-${BACKUP_S3_ACCESS_KEY_ID:-}}" \
  -e AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-${BACKUP_S3_SECRET_ACCESS_KEY:-}}" \
  -e AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-${BACKUP_S3_REGION:-auto}}" \
  backup restore --yes-overwrite-database "$snapshot"

step2_duration=$(( $(date +%s) - started_step ))
echo "drill: 恢复完成 (用时 ${step2_duration}s)"

started_step=$(date +%s)
echo "drill: [3/4] 校验恢复后数据的完整性..."
for db in lobechat litellm aroomo_core; do
  count=$(docker compose --project-name "$project_name" --project-directory "$deploy" --env-file "$tmp_env" \
    exec -T postgres psql -U postgres -d "$db" -t -A -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');" 2>/dev/null || echo "0")
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [[ "$count" -le 0 ]]; then
    echo "drill: 校验失败！数据库 $db 无有效数据 (表数量: $count)" >&2
    exit 1
  fi
  echo "drill: 数据库 $db 校验通过 (数据表数量: $count)"
done
step3_duration=$(( $(date +%s) - started_step ))

ended_all=$(date +%s)
total_duration=$(( ended_all - started_all ))

echo "-------------------------------------------------------"
echo "              恢复演练耗时报告"
echo "-------------------------------------------------------"
echo " 环境启动耗时: ${step1_duration} 秒"
echo " 数据恢复耗时: ${step2_duration} 秒"
echo " 数据校验耗时: ${step3_duration} 秒"
echo " 演练总耗时:   ${total_duration} 秒"
echo " 演练结果:     SUCCESS"
echo "======================================================="
