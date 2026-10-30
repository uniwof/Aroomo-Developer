#!/usr/bin/env bash
# 服务器迁移：在新机器上一条命令恢复整套 Aroomo（D116-12；操作手册 docs/ops/MIGRATE.md）。
#
# 步骤：检查 → 拉起数据库/对象存储 → 从备份（R2 或本机）恢复（需要主密钥）→ 用备份里的配置启动全部服务
#       → 健康检查 → （可选）切换 Tunnel。旧机器只读保留 7 天由人按手册操作，本脚本不碰旧机器。
#
# ⚠ 会删除并重建新机器上的数据库、清空对象存储卷。必须带 --yes-overwrite-database（D50/D63：不可逆操作要确认）。
# ⚠ 默认不切换 Tunnel：同一个 Tunnel 有两台机器同时连着时，请求会被随机分给两边，数据会分叉。
#   先确认旧机器已停掉 cloudflared（手册第 4 步），再加 --switch-tunnel。
#
# 主密钥（age 私钥，AGE-SECRET-KEY-1 开头，D64）只在恢复这一步临时提供，不写进任何文件：
#   交互运行时 restore 会提示输入（不显示）；或先 read -rs AROOMO_BACKUP_IDENTITY; export AROOMO_BACKUP_IDENTITY
#
# 新机器上事先要有：本仓库（dev 或要部署的分支）、Docker + compose 插件、
#   deploy/.env —— 只需「从哪里取备份」几项：BACKUP_S3_ENDPOINT / BACKUP_S3_BUCKET / BACKUP_S3_ACCESS_KEY_ID /
#   BACKUP_S3_SECRET_ACCESS_KEY（或 BACKUP_LOCAL_DIR）、数据库初始化需要的密码（从 deploy/.env.example 生成即可，
#   恢复后会被备份里的配置整体替换）。
#
# 用法（仓库根目录）：
#   scripts/migrate.sh --check                                   # 只做检查，不改任何东西
#   scripts/migrate.sh --yes-overwrite-database                  # 恢复最新备份，不切 Tunnel
#   scripts/migrate.sh --yes-overwrite-database --snapshot 20261028T033000Z --switch-tunnel
#
# 环境变量：MIGRATE_TIER（默认按机器内存自动选，同 scripts/select-tier.sh）
#           MIGRATE_HEALTH_TIMEOUT（默认 600 秒）
# 输出：过程写 stderr；最后一行 JSON（各阶段耗时）写 stdout。
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
deploy="$root/deploy"
env_file="$deploy/.env"

snapshot="latest"
confirm=0
check_only=0
switch_tunnel=0
while (( $# )); do
  case "$1" in
    --snapshot) snapshot="${2:?--snapshot 需要备份名}"; shift 2 ;;
    --yes-overwrite-database) confirm=1; shift ;;
    --check) check_only=1; shift ;;
    --switch-tunnel) switch_tunnel=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "migrate: 未知参数 $1" >&2; exit 64 ;;
  esac
done

log() { printf '[migrate %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "失败：$*"; exit 1; }
t0=$(date +%s)
declare -A took=()
stage_start=$t0
stage_done() { local now; now=$(date +%s); took[$1]=$(( now - stage_start )); stage_start=$now; }

env_get() { grep -E "^$1=" "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# ---------- 1. 检查 ----------
command -v docker >/dev/null || die "没有 docker"
docker compose version >/dev/null 2>&1 || die "没有 docker compose 插件"
[[ -f "$env_file" ]] || die "缺少 deploy/.env（只需备份位置几项，见脚本开头）"
if [[ -z "$(env_get BACKUP_S3_ENDPOINT)" && -z "$(env_get BACKUP_LOCAL_DIR)" ]]; then
  die "deploy/.env 里没有备份位置（BACKUP_S3_* 或 BACKUP_LOCAL_DIR）"
fi
# 只检查是否填了，不打印任何值
for k in BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
  if [[ -n "$(env_get BACKUP_S3_ENDPOINT)" && -z "$(env_get "$k")" ]]; then die "deploy/.env 里 $k 为空"; fi
done
tier="${MIGRATE_TIER:-$("$here/select-tier.sh")}"
log "档位：$tier；备份：$snapshot；切换 Tunnel：$([[ $switch_tunnel == 1 ]] && echo 是 || echo 否)"
compose() { AROOMO_TIER="$tier" "$here/compose.sh" "$@"; }
compose config -q || die "compose 配置校验没通过"
stage_done check

log "可用的备份："
compose --profile restore run --rm restore --list >&2 || die "列不出备份（备份位置或令牌不对？）"
stage_done list

if (( check_only )); then
  log "只做检查：通过。"
  printf '{"ok":true,"check_only":true,"took":{"check":%s,"list":%s}}\n' "${took[check]}" "${took[list]}"
  exit 0
fi
(( confirm )) || die "会覆盖这台机器上的数据库。确认无误后加 --yes-overwrite-database 再运行"

# ---------- 2. 拉起数据库和对象存储（其余服务保持停止） ----------
compose stop lobe litellm core shell cloudflared >/dev/null 2>&1 || true
compose up -d postgres redis >&2
compose stop rustfs >/dev/null 2>&1 || true
stage_done prepare

# ---------- 3. 恢复（主密钥只经环境变量名传入容器） ----------
id_args=()
[[ -n "${AROOMO_BACKUP_IDENTITY:-}" ]] && id_args=(-e AROOMO_BACKUP_IDENTITY)
compose --profile restore run --rm "${id_args[@]}" restore --yes-overwrite-database "$snapshot" >&2 \
  || die "恢复没有成功（主密钥不对，或备份损坏）"
stage_done restore

# ---------- 4. 用备份里的配置替换 deploy/.env（先备份新机器原来的） ----------
restored="$deploy/.restore/aroomo.env"
if [[ -f "$restored" ]]; then
  cp -p "$env_file" "$env_file.pre-migrate-$(date -u +%Y%m%dT%H%M%SZ)"
  install -m 600 "$restored" "$env_file"
  rm -f "$restored"
  log "已换成备份里的配置（原 deploy/.env 另存为 .pre-migrate-*）"
else
  log "备份里没有配置文件，沿用当前 deploy/.env（LITELLM_SALT_KEY 必须与旧机器一致，否则模型 Key 解不开）"
fi
chmod 600 "$env_file" "$env_file".pre-migrate-* 2>/dev/null || true
stage_done config

# ---------- 5. 启动（Tunnel 默认不启） ----------
# 只点名启动主服务（不靠 COMPOSE_PROFILES 置空：.env 里的 tunnel 可能仍生效，cloudflared 会抢先连上）
want=(postgres redis rustfs litellm core lobe shell)
compose up -d "${want[@]}" >&2
(( switch_tunnel )) && compose up -d cloudflared >&2
stage_done start

# ---------- 6. 健康检查 ----------
deadline=$(( $(date +%s) + ${MIGRATE_HEALTH_TIMEOUT:-600} ))
while :; do
  bad=()
  for s in "${want[@]}"; do
    st=$(compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk -v s="$s" '$1==s{print $2}')
    [[ "$st" == healthy ]] || bad+=("$s")
  done
  (( ${#bad[@]} == 0 )) && break
  (( $(date +%s) > deadline )) && die "这些服务没有就绪：${bad[*]}（docker compose logs 查看）"
  sleep 5
done
stage_done health
log "全部服务就绪。"
if (( ! switch_tunnel )); then
  log "Tunnel 未切换。确认旧机器已停 cloudflared 后运行：scripts/compose.sh up -d cloudflared（不必重跑本脚本）"
fi

total=$(( $(date +%s) - t0 ))
printf '{"ok":true,"snapshot":"%s","tier":"%s","switch_tunnel":%s,"took":{"check":%s,"list":%s,"prepare":%s,"restore":%s,"config":%s,"start":%s,"health":%s,"total":%s}}\n' \
  "$snapshot" "$tier" "$([[ $switch_tunnel == 1 ]] && echo true || echo false)" \
  "${took[check]}" "${took[list]}" "${took[prepare]}" "${took[restore]}" "${took[config]}" "${took[start]}" "${took[health]}" "$total"
