#!/usr/bin/env bash
# Aroomo 生产发布脚本（工单 #171 / D209）：生产只部署 main 上打了 v0.x.y 标签的版本，一条命令回滚到上一个。
# 只在生产服务器 /opt/aroomo 上运行；staging 走 deploy/staging/deploy-staging.sh（只跟 dev）。
#
#   scripts/release-tag.sh list                          列出 main 上的标签（标出当前 / 上一个）
#   scripts/release-tag.sh status                        当前版本、上一个版本、最近日志
#   scripts/release-tag.sh deploy vX.Y.Z                 演练：做全部检查并显示更新日志，不切换
#   scripts/release-tag.sh deploy vX.Y.Z --confirm vX.Y.Z   真正切换（版本号必须写两遍，防手滑）
#   scripts/release-tag.sh rollback                      演练：显示将回到哪个版本
#   scripts/release-tag.sh rollback --confirm <上一个版本>  真正回滚
#   加 --hotfix：跳过合并闸门（#189），其他检查照旧。
#
# 切换前一律打印「需要主会话：确认生产切到标签版」，由主会话确认后带 --confirm 再跑。
# 切换步骤：git fetch --tags → 检查标签在 main 上 → 合并闸门 → 生产前检查与备份（#229）
#           → checkout 标签 → .env 自检 → 构建 → up -d → 健康检查 → 失败自动回到上一个版本。
#
# 绝不做的事：git clean、git add -A、git stash -u（服务器上有未被忽略的本地密钥文件）；
#            不打印 .env 的任何值；不碰 main（只读 origin/main）。
#
# 环境变量（测试和排障用，生产不用设）：
#   RELEASE_ROOT（默认 /opt/aroomo）RELEASE_REMOTE（origin）RELEASE_MAIN_BRANCH（main）
#   RELEASE_TIER（默认 standard，与现有生产一致）RELEASE_HEALTH_TIMEOUT_S（420）
#   RELEASE_HEALTH_CMD（测试用：命令 <服务名> 输出 healthy 即通过）RELEASE_SKIP_CONSOLE=1（测试用：不构建控制台）
#   RELEASE_REQUIRE_PRECHECK（默认 0；#229 的 release-precheck.sh 合入后改为 1）
set -Eeuo pipefail

ROOT="${RELEASE_ROOT:-/opt/aroomo}"
REMOTE="${RELEASE_REMOTE:-origin}"
MAIN_BRANCH="${RELEASE_MAIN_BRANCH:-main}"
TIER="${RELEASE_TIER:-standard}"
HEALTH_TIMEOUT_S="${RELEASE_HEALTH_TIMEOUT_S:-420}"
SERVICES=(core lobe shell)
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
CONFIRM_MSG="需要主会话：确认生产切到标签版"

# 把自己复制到临时文件再执行：checkout 会替换本文件，正在运行的脚本不能被改到一半
if [ -z "${RELEASE_TAG_COPY:-}" ]; then
  tmp="$(mktemp /tmp/release-tag.XXXXXX)"
  cp "$0" "$tmp"
  RELEASE_TAG_COPY="$tmp" exec bash "$tmp" "$@"
fi
trap 'rm -f "$RELEASE_TAG_COPY"' EXIT

state="$ROOT/.release"
mkdir -p "$state"
log() { printf '%s %s\n' "$(date '+%F %T %Z')" "$*" | tee -a "$state/history.log" >&2; }
die() { log "拒绝：$*"; exit 1; }

git_() { git -C "$ROOT" "$@"; }
compose() { AROOMO_TIER="$TIER" "$ROOT/scripts/compose.sh" "$@"; }

short() {
  local r="$1"
  if [[ "$r" =~ $TAG_RE ]]; then printf '%s' "$r"; else printf '%s' "${r:0:7}"; fi
}

read_state() { cat "$state/$1" 2>/dev/null || true; }

# 当前版本：状态文件优先；没有（首次）就用服务器现在检出的提交
current_ref() {
  local c; c="$(read_state current)"
  if [ -z "$c" ]; then c="$(git_ rev-parse HEAD)"; fi
  printf '%s' "$c"
}

fetch_remote() {
  git_ fetch -q "$REMOTE" "+refs/heads/$MAIN_BRANCH:refs/remotes/$REMOTE/$MAIN_BRANCH" \
    || die "拉取 $REMOTE/$MAIN_BRANCH 失败"
  # 不加 --force：已有的 v* 标签被改动 = 异常，宁可停下
  git_ fetch -q --tags "$REMOTE" || die "拉取标签失败（本地标签与远端不一致？不要强制覆盖 v* 标签，先查原因）"
}

list_tags() {
  local cur prev t
  cur="$(read_state current)"; prev="$(read_state previous)"
  git_ tag --list 'v*' --sort=-v:refname | while read -r t; do
    [[ "$t" =~ $TAG_RE ]] || continue
    git_ merge-base --is-ancestor "refs/tags/$t^{commit}" "refs/remotes/$REMOTE/$MAIN_BRANCH" 2>/dev/null || continue
    local mark=""
    [ "$t" = "$cur" ] && mark=" [当前]"
    [ "$t" = "$prev" ] && mark=" [上一个]"
    printf '%s  %s  %s%s\n' "$t" "$(git_ log -1 --format='%h %cs' "refs/tags/$t^{commit}")" \
      "$(git_ log -1 --format=%s "refs/tags/$t^{commit}" | cut -c1-70)" "$mark"
  done
}

# 把 ref（标签名或提交）解析成提交
commit_of() { git_ rev-parse -q --verify "$1^{commit}" 2>/dev/null; }

check_env() {
  local env="$ROOT/deploy/.env" v n
  [ -f "$env" ] || { log "缺少 deploy/.env"; return 1; }
  grep -q '^CORE_CHAT_TOKEN=..*' "$env" || { log "deploy/.env 缺 CORE_CHAT_TOKEN（不自动生成，请主会话处理）"; return 1; }
  v="$(grep '^KEY_VAULTS_SECRET=' "$env" | cut -d= -f2- || true)"
  n="$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c || echo 0)"
  case "$n" in 16|24|32) ;; *) log "deploy/.env 的 KEY_VAULTS_SECRET 不是有效的 base64 密钥（解码 ${n} 字节；不自动重新生成）"; return 1 ;; esac
}

service_status() {
  local s="$1" id
  if [ -n "${RELEASE_HEALTH_CMD:-}" ]; then "$RELEASE_HEALTH_CMD" "$s"; return; fi
  id="$(compose ps -q "$s" 2>/dev/null || true)"
  if [ -n "$id" ]; then
    docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
  else
    echo missing
  fi
}

wait_healthy() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT_S )) s ok
  while :; do
    ok=1
    for s in "${SERVICES[@]}"; do [ "$(service_status "$s")" = healthy ] || ok=0; done
    [ "$ok" = 1 ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then
      for s in "${SERVICES[@]}"; do log "  $s: $(service_status "$s")"; done
      return 1
    fi
    sleep "${RELEASE_HEALTH_POLL_S:-5}"
  done
}

build_console_if_needed() {
  local from="$1" to="$2"
  [ "${RELEASE_SKIP_CONSOLE:-0}" = 1 ] && return 0
  if [ ! -f "$ROOT/web/console/dist/index.html" ] || [ -z "$from" ] \
     || ! git_ diff --quiet "$from" "$to" -- web/console 2>/dev/null; then
    log "构建控制台"
    "$ROOT/scripts/build-console.sh" >/dev/null
    test -f "$ROOT/web/console/dist/index.html"
  fi
}

# 切到 ref 并起服务；每一步显式 || return 1（在 if 里调用时 set -e 不生效）
switch_to() {
  local ref="$1" from="$2" to
  to="$(commit_of "$ref")" || { log "找不到 $ref"; return 1; }
  git_ -c advice.detachedHead=false checkout -q --force "$to" || { log "检出 $(short "$ref") 失败"; return 1; }
  check_env || return 1
  build_console_if_needed "$from" "$to" || { log "控制台构建失败"; return 1; }
  export AROOMO_COMMIT="$to"
  compose build core shell >/dev/null 2>&1 || { log "镜像构建失败"; return 1; }
  compose pull --ignore-buildable -q >/dev/null 2>&1 || true
  compose up -d --remove-orphans >/dev/null 2>&1 || { log "compose up 失败"; return 1; }
  wait_healthy || { log "健康检查超时"; return 1; }
}

# 真正切换：成功记 current/previous；失败自动回到原版本
do_switch() {
  local target="$1" cur="$2" from
  from="$(commit_of "$cur" || true)"
  log "开始切换：$(short "$cur") → $(short "$target")"
  if switch_to "$target" "$from"; then
    if [ "$cur" != "$target" ]; then printf '%s\n' "$cur" >"$state/previous"; fi
    printf '%s\n' "$target" >"$state/current"
    log "切换成功：生产现在是 $(short "$target")"
    return 0
  fi
  log "切换失败：$(short "$target")，自动回到 $(short "$cur")"
  if switch_to "$cur" "$(commit_of "$target" || true)"; then
    log "已回到 $(short "$cur")，生产仍是它"
  else
    log "回退也失败，需要人工处理（生产状态未知）"
  fi
  return 1
}

# 合并闸门（#189）：仓库里有带 needs-leader-review 的开放 PR 就拒绝发布（hotfix 豁免）
run_gate() {
  local hotfix="$1" gate="$ROOT/scripts/merge-gate.sh"
  if [ "$hotfix" = 1 ]; then log "hotfix：跳过合并闸门"; return 0; fi
  if [ -x "$gate" ]; then
    "$gate" || die "合并闸门不通过：还有带 needs-leader-review 的开放 PR"
  else
    log "提示：合并闸门（#189）尚未启用，已跳过（调用点：scripts/merge-gate.sh）"
  fi
}

# 生产前检查 + 部署前备份（#229）。dry 时只检查、不备份
run_precheck() {
  local dry="$1" pre="$ROOT/scripts/release-precheck.sh"
  if [ -x "$pre" ]; then
    if [ "$dry" = 1 ]; then "$pre" --no-backup || die "生产前检查不通过"
    else "$pre" || die "生产前检查或部署前备份不通过，不部署"; fi
  elif [ "${RELEASE_REQUIRE_PRECHECK:-0}" = 1 ]; then
    die "缺少 scripts/release-precheck.sh，不部署"
  else
    log "提示：生产前检查（#229）尚未启用，已跳过（调用点：scripts/release-precheck.sh）"
  fi
}

cmd="${1:-status}"; shift || true
target=""; confirm=""; hotfix=0
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) confirm="${2:-}"; shift 2 || die "--confirm 后面要写版本号" ;;
    --hotfix) hotfix=1; shift ;;
    -*) die "不认识的参数 $1" ;;
    *) target="$1"; shift ;;
  esac
done

case "$cmd" in
  list)
    fetch_remote
    list_tags
    exit 0 ;;
  status)
    echo "当前版本：$(short "$(current_ref)")（实际检出 $(git_ rev-parse --short HEAD)）"
    echo "上一个版本：$( [ -n "$(read_state previous)" ] && short "$(read_state previous)" || echo 无 )"
    tail -n 8 "$state/history.log" 2>/dev/null || true
    exit 0 ;;
  deploy|rollback) ;;
  *) die "用法：release-tag.sh list | status | deploy vX.Y.Z [--confirm vX.Y.Z] [--hotfix] | rollback [--confirm <版本>]" ;;
esac

exec 9>"$state/lock"
flock -n 9 || die "另一个发布正在进行"

cur="$(current_ref)"
if [ "$cmd" = rollback ]; then
  target="$(read_state previous)"
  [ -n "$target" ] || die "没有记录的上一个版本，无法回滚"
  log "回滚目标：$(short "$target")（当前 $(short "$cur")）"
else
  [[ "$target" =~ $TAG_RE ]] || die "要部署的版本必须是 main 上形如 v0.1.0 的标签（拒绝：${target:-空}）"
  fetch_remote
  commit_of "refs/tags/$target" >/dev/null || die "找不到标签 $target"
  git_ merge-base --is-ancestor "refs/tags/$target^{commit}" "refs/remotes/$REMOTE/$MAIN_BRANCH" \
    || die "标签 $target 不在 $MAIN_BRANCH 上，生产只部署 main 上的标签"
  if [ "$(commit_of "refs/tags/$target")" = "$(git_ rev-parse HEAD)" ] && [ "$(read_state current)" = "$target" ]; then
    log "生产已经是 $target，无需部署"; exit 0
  fi
  echo "--- 更新日志（$(short "$cur") → $target）---"
  git_ log --format='%h %s' "$(commit_of "$cur" || echo "$target")..refs/tags/$target^{commit}" 2>/dev/null | head -40 || true
  echo "---"
  run_gate "$hotfix"
fi

# 没带对的 --confirm：只演练
if [ -z "$confirm" ] || { [ "$confirm" != "$target" ] && [ "$confirm" != "$(short "$target")" ]; }; then
  if [ "$cmd" = deploy ]; then run_precheck 1; fi
  log "演练完成，未切换。$CONFIRM_MSG：$(short "$target")。确认后运行：scripts/release-tag.sh $cmd $( [ "$cmd" = deploy ] && echo "$target " )--confirm $(short "$target")"
  exit 0
fi

if [ "$cmd" = deploy ]; then run_precheck 0; fi
log "$CONFIRM_MSG（已确认：$(short "$target")）"
do_switch "$target" "$cur"
