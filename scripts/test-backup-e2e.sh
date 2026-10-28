#!/usr/bin/env bash
# 备份 / 恢复端到端测试（CI 的 backup-e2e job；本地有 Docker 也能跑）。只用占位凭据。
#
#   起 postgres + rustfs → 生成一次性测试主密钥（age）→ 写测试数据和一个对象
#   → 备份到「异地」S3（另一个 rustfs 容器，用公钥加密，D64）→ 检查保护（没有公钥、备份环境里出现私钥、
#   恢复不带确认、服务未停）→ 保留策略（异地 keep-last、本机只留 3 份）→ .env 在加密包里
#   → down -v 删光数据 → 用错的主密钥恢复被拒 → 用对的主密钥恢复 → 核对行数和对象内容 → 恢复演练。
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
  | grep -vE '^(BACKUP_AGE_RECIPIENT|BACKUP_S3_|BACKUP_CHECK)=' >"$env_file"
cat >>"$env_file" <<EOF
AROOMO_ENV_FILE=$env_file
BACKUP_S3_ENDPOINT=http://backup-target:9000
BACKUP_S3_BUCKET=$bucket
BACKUP_S3_PREFIX=server
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
  docker volume rm -f aroomo-e2e-local >/dev/null 2>&1 || true
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

step="生成一次性测试主密钥"
keygen() { docker run --rm --network none --entrypoint age-keygen aroomo-backup:dev 2>/dev/null; }
keys=$(keygen)
AROOMO_BACKUP_IDENTITY=$(grep '^AGE-SECRET-KEY-1' <<<"$keys")
pub=$(sed -n 's/^# public key: //p' <<<"$keys")
wrong_identity=$(keygen | grep '^AGE-SECRET-KEY-1')
[[ -n "$AROOMO_BACKUP_IDENTITY" && "$pub" == age1* && -n "$wrong_identity" ]] || die "生成测试主密钥失败"
echo "BACKUP_AGE_RECIPIENT=$pub" >>"$env_file"
ok "测试主密钥就绪（公钥 ${pub:0:12}…；只写入临时 env 的是公钥）"
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

step="没有主密钥时拒绝恢复"
set +e
out=$(dc --profile restore run --rm -T restore --yes-overwrite-database 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q '需要主密钥' <<<"$out"; then die "没有主密钥时应拒绝恢复：$out"; fi
ok "没有主密钥时拒绝恢复"

step="服务未停时拒绝恢复"
export AROOMO_BACKUP_IDENTITY
set +e
out=$(dc --profile restore run --rm -T -e AROOMO_BACKUP_IDENTITY restore --yes-overwrite-database 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q 'rustfs 还在运行' <<<"$out"; then die "rustfs 运行时应拒绝恢复：$out"; fi
ok "rustfs 运行时拒绝恢复"

step="备份的保护：没有公钥 / 备份环境里出现主密钥都拒绝"
set +e
out=$(dc --profile backup run --rm -T -e BACKUP_AGE_RECIPIENT= backup now 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q 'BACKUP_AGE_RECIPIENT 未设置' <<<"$out"; then die "没有公钥时应拒绝备份：$out"; fi
set +e
out=$(dc --profile backup run --rm -T -e AROOMO_BACKUP_IDENTITY backup now 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q '出现了主密钥' <<<"$out"; then die "备份环境里有主密钥时应拒绝：$out"; fi
ok "没有公钥、或环境里出现主密钥时拒绝备份"

step="备份"
out=$(dc --profile backup run --rm -T backup now)
line=$(tail -1 <<<"$out")
echo "$line"
[[ "$(jq -r .status <<<"$line")" == ok ]] || die "备份失败：$line"
[[ "$(jq -r .checked <<<"$line")" == true ]] || die "BACKUP_CHECK=always 时应重新下载核对"
[[ "$(jq -r .offsite <<<"$line")" == true ]] || die "应上传到异地"
[[ "$(jq -r .env_included <<<"$line")" == true ]] || die ".env 应打进加密包"
snap1=$(jq -r .snapshot_id <<<"$line")
ok "备份成功：$snap1"

step="异地文件：age 加密、meta 里是公钥、没有明文"
# shellcheck disable=SC2016  # 变量在容器内展开
listing=$(dc --profile backup run --rm -T --entrypoint bash backup -c \
  '. /opt/aroomo/scripts/lib/backup-common.sh; offsite_setup; d=$(offsite_dir); rclone lsf "$d"; f=$(list_backups offsite | tail -1); rclone cat --count 21 "$d/$f"; echo; rclone cat "$d/${f%.tar.zst.age}.meta.json"; rclone cat "$d/$f" | grep -c placeholder-enc || true')
echo "$listing"
grep -q '^age-encryption.org/v1' <<<"$listing" || die "异地文件不是 age 格式"
grep -q "\"recipient\":\"$pub\"" <<<"$listing" || die "meta.json 里的公钥不对"
[[ "$(tail -1 <<<"$listing")" == 0 ]] || die "密文里出现了明文测试数据"
ok "异地文件已加密，meta 只含公钥"

step=".env 在加密包里，用主密钥能取出且与原文件一致"
# shellcheck disable=SC2016  # 变量在容器内展开
got=$(dc --profile restore run --rm -T -e AROOMO_BACKUP_IDENTITY --entrypoint bash restore -c \
  '. /opt/aroomo/scripts/lib/backup-common.sh; offsite_setup; f=$(list_backups offsite | tail -1); rclone cat "$(offsite_dir)/$f" | age -d -i <(printf "%s\n" "$AROOMO_BACKUP_IDENTITY") | zstd -dc | tar -xOf - data/secrets/aroomo.env | sha256sum | cut -d" " -f1')
[[ "$got" == "$(sha256sum "$env_file" | cut -d' ' -f1)" ]] || die ".env 取出后不一致"
ok ".env 随加密备份保存（D64）"

step="保留策略（异地）"
dc --profile backup run --rm -T -e RETENTION_KEEP_LAST=1 -e RETENTION_KEEP_DAILY=0 \
  -e RETENTION_KEEP_WEEKLY=0 -e RETENTION_KEEP_MONTHLY=0 -e BACKUP_CHECK=never backup now >/dev/null
count=$(dc --profile backup run --rm -T backup snapshots 2>/dev/null | grep -c '\.tar\.zst\.age$' || true)
(( count == 1 )) || die "RETENTION_KEEP_LAST=1 时异地应只剩 1 份，实际 $count"
ok "异地保留策略生效（keep-last=1 后只剩 1 份）"

step="本机只留最近 3 份（D65），没配异地时照常备份"
for _ in 1 2 3 4; do
  sleep 1  # 文件名精确到秒
  line=$(dc --profile backup run --rm -T -v aroomo-e2e-local:/local -e BACKUP_LOCAL_DIR=/local -e BACKUP_S3_ENDPOINT= backup now | tail -1)
  [[ "$(jq -r .status <<<"$line")" == ok && "$(jq -r .offsite <<<"$line")" == false ]] || die "本机备份失败：$line"
done
n=$(dc --profile backup run --rm -T -v aroomo-e2e-local:/local --entrypoint sh backup -c 'ls /local/*.tar.zst.age | wc -l' | tr -d '[:space:]')
(( n == 3 )) || die "本机应只留 3 份，实际 $n"
ok "本机只留 3 份；没配异地时 offsite=false 但备份成功"

step="模拟灾难：删除全部数据卷"
dc down -v
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]] || die "数据卷没有删干净"
ok "数据已全部删除"

step="用错的主密钥恢复：拒绝，且不动数据库"
dc up -d --wait postgres
set +e
out=$(AROOMO_BACKUP_IDENTITY="$wrong_identity" dc --profile restore run --rm -T -e AROOMO_BACKUP_IDENTITY restore --yes-overwrite-database 2>&1)
code=$?
set -e
if (( code == 0 )) || ! grep -q '主密钥不对' <<<"$out"; then die "错的主密钥应被拒绝：$out"; fi
ok "错的主密钥被拒绝"

step="在空白环境里恢复"
out=$(dc --profile restore run --rm -T -e AROOMO_BACKUP_IDENTITY restore --yes-overwrite-database --no-secrets)
line=$(tail -1 <<<"$out")
echo "$line"
[[ "$(jq -r .status <<<"$line")" == ok ]] || die "恢复失败：$line"
[[ "$(jq -r .verified <<<"$line")" == true ]] || die "恢复后没有通过行数核对"
[[ "$(jq -r .files_restored <<<"$line")" == true ]] || die "对象存储文件没有恢复"
[[ "$(jq -r .secrets_in_backup <<<"$line")" == true ]] || die "备份里应有 .env"
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
