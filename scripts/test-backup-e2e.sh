#!/usr/bin/env bash
# 备份 / 恢复端到端测试（CI 的 backup-e2e job；本地有 Docker 也能跑）。只用占位凭据。
#
#   起 postgres + rustfs → 写测试数据和一个对象 → 备份到「异地」S3（另一个 rustfs 容器）
#   → 检查恢复的二次确认和「服务未停」保护 → down -v 删光数据 → 恢复 → 核对行数和对象内容
#   → 检查保留策略 → 跑一次恢复演练脚本并生成报告。
#
# 环境变量：E2E_REPORT_DIR（演练报告输出目录，默认 drill-reports/）
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
deploy="$root/deploy"
project=aroomo-e2e
net=aroomo-e2e
target=aroomo-e2e-target
target_image="rustfs/rustfs:1.0.4"
rc_image="rustfs/rc:v0.1.36"
target_ak=placeholder-target-access
target_sk=placeholder-target-secret
bucket=aroomo-e2e-backups

env_file="$(mktemp)"
sed 's/CHANGE_ME/placeholder/g' "$deploy/.env.example" \
  | grep -vE '^(RESTIC_REPOSITORY|RESTIC_PASSWORD|BACKUP_S3_|BACKUP_CHECK)=' >"$env_file"
cat >>"$env_file" <<EOF
RESTIC_REPOSITORY=s3:http://backup-target:9000/$bucket/aroomo
RESTIC_PASSWORD=placeholder-restic-password
BACKUP_S3_ACCESS_KEY_ID=$target_ak
BACKUP_S3_SECRET_ACCESS_KEY=$target_sk
BACKUP_S3_REGION=us-east-1
BACKUP_CHECK=always
EOF

files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/standard.yml" -f "$deploy/test/e2e.yml")
dc() { docker compose -p "$project" --project-directory "$deploy" --env-file "$env_file" "${files[@]}" "$@"; }
psql_q() { dc exec -T postgres psql -X -q -At -U postgres -v ON_ERROR_STOP=1 "$@"; }

step=""
ok() { printf '✓ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
cleanup() {
  local code=$?
  if (( code != 0 )); then
    echo "---- 失败于：$step；最近日志 ----" >&2
    dc logs --tail 50 >&2 2>&1 || true
  fi
  dc --profile backup --profile restore down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$target" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  rm -f "$env_file"
  exit "$code"
}
trap cleanup EXIT

step="启动异地备份目标"
docker network create "$net" >/dev/null
docker run -d --name "$target" --network "$net" --network-alias backup-target \
  "$target_image" --access-key "$target_ak" --secret-key "$target_sk" /data >/dev/null
for _ in $(seq 1 60); do
  docker exec "$target" sh -c 'wget -qO- http://localhost:9000/health >/dev/null 2>&1' && break
  sleep 1
done
docker run --rm --network "$net" --entrypoint sh "$rc_image" -c \
  "rc alias set t http://backup-target:9000 $target_ak $target_sk >/dev/null && rc mb t/$bucket --ignore-existing"
ok "备份目标就绪"

step="构建备份镜像并启动 postgres + rustfs"
dc --profile backup build backup
dc up -d --wait postgres rustfs
dc run --rm rustfs-init
ok "服务就绪"

step="写入测试数据"
psql_q -d lobechat -c "create table e2e_messages(id serial primary key, body text);
  insert into e2e_messages(body) select 'msg-' || g from generate_series(1, 1000) g;"
psql_q -d litellm -c "create table \"E2E_ModelTable\"(id int primary key, enc text);
  insert into \"E2E_ModelTable\" values (1, 'placeholder-enc-1'), (2, 'placeholder-enc-2'), (3, 'placeholder-enc-3');
  alter table \"E2E_ModelTable\" owner to litellm;"
psql_q -d aroomo_core -c "create table e2e_audit(id int); insert into e2e_audit select generate_series(1, 5);"
# shellcheck disable=SC2016  # 变量在容器内展开
dc run --rm --entrypoint sh rustfs-init -c \
  'rc alias set r http://rustfs:9000 "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null && echo aroomo-e2e-object-v1 >/tmp/o.txt && rc cp /tmp/o.txt "r/$BUCKET/e2e/o.txt"'
ok "测试数据已写入"

step="恢复的二次确认"
set +e
dc --profile restore run --rm -T restore >/dev/null 2>&1
code=$?
set -e
(( code == 64 )) || die "不带 --yes-overwrite-database 时应退出 64，实际 $code"
ok "不带确认参数时拒绝恢复（退出 64）"

step="服务未停时拒绝恢复"
set +e
out=$(dc --profile restore run --rm -T restore --yes-overwrite-database 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q 'rustfs 还在运行' <<<"$out"; then die "rustfs 运行时应拒绝恢复：$out"; fi
ok "rustfs 运行时拒绝恢复"

step="备份"
out=$(dc --profile backup run --rm -T backup now)
line=$(tail -1 <<<"$out")
echo "$line"
[[ "$(jq -r .status <<<"$line")" == ok ]] || die "备份失败：$line"
[[ "$(jq -r .checked <<<"$line")" == true ]] || die "BACKUP_CHECK=always 时应执行 restic check"
snap1=$(jq -r .snapshot_id <<<"$line")
ok "备份成功，快照 ${snap1:0:8}"

step="保留策略"
dc --profile backup run --rm -T backup now >/dev/null
count=$(dc --profile backup run --rm -T --entrypoint restic backup snapshots --json | jq length)
(( count == 1 )) || die "同一天两次备份后按 keep-daily 应只剩 1 个快照，实际 $count"
ok "保留策略生效（同一天只保留最新 1 个）"

step="模拟灾难：删除全部数据卷"
dc down -v
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]] || die "数据卷没有删干净"
ok "数据已全部删除"

step="在空白环境里恢复"
dc up -d --wait postgres
out=$(dc --profile restore run --rm -T restore --yes-overwrite-database)
line=$(tail -1 <<<"$out")
echo "$line"
[[ "$(jq -r .status <<<"$line")" == ok ]] || die "恢复失败：$line"
[[ "$(jq -r .verified <<<"$line")" == true ]] || die "恢复后没有通过行数核对"
[[ "$(jq -r .files_restored <<<"$line")" == true ]] || die "对象存储文件没有恢复"
ok "恢复成功：$(jq -c .phases <<<"$line")"

step="核对恢复后的数据"
[[ "$(psql_q -d lobechat -c 'select count(*) from e2e_messages')" == 1000 ]] || die "lobechat 行数不对"
[[ "$(psql_q -d litellm -c 'select count(*) from "E2E_ModelTable"')" == 3 ]] || die "litellm 行数不对"
[[ "$(psql_q -d litellm -c "select tableowner from pg_tables where tablename = 'E2E_ModelTable'")" == litellm ]] || die "litellm 表的所有者不对"
[[ "$(psql_q -d aroomo_core -c 'select count(*) from e2e_audit')" == 5 ]] || die "aroomo_core 行数不对"
dc up -d --wait rustfs
# shellcheck disable=SC2016  # 变量在容器内展开
obj=$(dc run --rm --entrypoint sh rustfs-init -c \
  'rc alias set r http://rustfs:9000 "$RUSTFS_ACCESS_KEY" "$RUSTFS_SECRET_KEY" >/dev/null && rc cat "r/$BUCKET/e2e/o.txt"' | tr -d '\r')
[[ "$obj" == aroomo-e2e-object-v1 ]] || die "对象内容不对：$obj"
ok "三个库的行数、表所有者、对象内容都与备份前一致"

step="恢复演练脚本"
dc down -v
DRILL_ENV_FILE="$env_file" DRILL_EXTRA_COMPOSE="$deploy/test/e2e.yml" DRILL_PROJECT=aroomo-e2e-drill \
  DRILL_REPORT_DIR="${E2E_REPORT_DIR:-$root/drill-reports}" "$here/restore-drill.sh"
report=$(find "${E2E_REPORT_DIR:-$root/drill-reports}" -name 'restore-drill-*.md' | sort | tail -1)
cat "$report"
grep -q '\*\*通过\*\*' "$report" || die "演练报告不是「通过」"
ok "恢复演练通过，报告：$report"

echo "全部通过"
