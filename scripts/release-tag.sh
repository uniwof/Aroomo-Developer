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
#   没有本地 --hotfix：闸门永远跑；紧急修复的豁免只认 GitHub 上该 PR 的 hotfix 标签（由 merge-gate.py 判定，#352 M3）。
#   合并闸门需要环境里有只读 GH_TOKEN（不写 .env、不进日志）；目标版本没有 scripts/ci/merge-gate.py 就拒绝部署。
#   加 --lobe-session-ok：回退目标写死 SHELL_AUTH: lobe-session 也照样切（只在确实要回旧登录、LobeHub 在跑时用）。
#
# 版本专属的 compose 叠加文件（docs/ops/RELEASE.md「回退到 v0.1.0」）：
#   .release/compose-extra/<版本>（版本 = 标签名，或提交号前 7 位）一行一个叠加文件的绝对路径；
#   「nobuild: 服务名…」= 这些服务用叠加文件里指定的现成镜像，不重建（否则会用旧代码重建并覆盖那个镜像标签）。
#   切到这个版本时（deploy、rollback、切换失败自动回退）都叠上；列出的文件不存在就拒绝切换。
#   生产 v0.1.0 的 Shell 来自 /opt/aroomo-overrides/prod-shell-core-auth.yml（core-session 镜像），不叠它回退后所有者进不去。
#
# 切换前一律打印「需要主会话：确认生产切到标签版」，由主会话确认后带 --confirm 再跑。
# 切换步骤：git fetch --tags → 检查标签在 main 上 → 工作区干净 + .env 自检（演练也做）→ 数据库迁移不超前
#           → 合并闸门、生产前检查与备份（#229；都用目标版本里的 scripts/）→ checkout 标签（不加 --force）
#           → 构建 → up -d → 健康检查 → 失败自动回到上一个版本；
#           但数据库已经执行过回退目标不认识的迁移时不回退代码，写「需要人工处理」（先用部署前备份恢复）。
#
# 绝不做的事：git clean、git add -A、git stash -u（服务器上有未被忽略的本地密钥文件）；
#            不打印 .env 的任何值；不碰 main（只读 origin/main）。
#
# 环境变量（测试和排障用，生产不用设）：
#   RELEASE_ROOT（默认 /opt/aroomo）RELEASE_REMOTE（origin）RELEASE_MAIN_BRANCH（main）
#   RELEASE_TIER（默认 standard，与现有生产一致）RELEASE_HEALTH_TIMEOUT_S（420）
#   RELEASE_HEALTH_CMD（测试用：命令 <服务名> 输出 healthy 即通过）RELEASE_SKIP_CONSOLE=1（测试用：不构建控制台）
#   RELEASE_REQUIRE_PRECHECK（默认 1：目标版本缺 scripts/release-precheck.sh 就拒绝部署；只有测试设 0）
#   RELEASE_DB_CMD（测试用：从 stdin 读一条 SQL、输出无表头结果的命令；默认走 compose exec postgres psql，只读）
#   RELEASE_PRECHECK_DB（默认 aroomo_core）
#   RELEASE_REQUIRE_GATE（默认 1：目标版本缺 scripts/ci/merge-gate.py 就拒绝部署；只有测试设 0）
#   RELEASE_GATE_REPO（默认 uniwof/Aroomo-Developer）RELEASE_PYTHON（默认 python3）
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
# compose 的输出不丢掉：写进只有本用户能读的日志，出问题好排查（日志里没有 .env 的值）
# 不设全局 umask：checkout 和构建出来的文件要保持正常权限（644/755），否则镜像里非 root 进程读不了
compose_log="$state/compose.log"
touch "$compose_log"; chmod 600 "$compose_log"
log() { printf '%s %s\n' "$(date '+%F %T %Z')" "$*" | tee -a "$state/history.log" >&2; }
die() { log "拒绝：$*"; exit 1; }

git_() { git -C "$ROOT" "$@"; }
# 当前要用的叠加文件（load_extra 设置）。有叠加文件时不经过目标版本的 compose.sh（v0.1.0 的 compose.sh 不认叠加文件），
# 按 compose.sh 的同一组文件直接调 docker compose，再加上叠加文件。
EXTRA_FILES=()
NOBUILD=()
compose() {
  if [ "${#EXTRA_FILES[@]}" -gt 0 ]; then
    local f args=(-f "$ROOT/deploy/docker-compose.yml" -f "$ROOT/deploy/tiers/$TIER.yml")
    for f in "${EXTRA_FILES[@]}"; do args+=(-f "$f"); done
    # shellcheck disable=SC2086  # RELEASE_DOCKER 只在测试里设成桩命令
    ${RELEASE_DOCKER:-docker} compose --project-directory "$ROOT/deploy" "${args[@]}" "$@"
  else
    AROOMO_TIER="$TIER" "$ROOT/scripts/compose.sh" "$@"
  fi
}

# load_extra <版本>：读 .release/compose-extra/<版本>，设 EXTRA_FILES / NOBUILD。文件里列的叠加文件不存在 → 返回 1
load_extra() {
  local name="$1" line f missing=0
  EXTRA_FILES=(); NOBUILD=()
  [ -f "$state/compose-extra/$name" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"; line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    case "$line" in
      nobuild:*) for f in ${line#nobuild:}; do NOBUILD+=("$f"); done ;;
      /*) if [ -f "$line" ]; then EXTRA_FILES+=("$line"); else log "叠加文件不存在：$line（.release/compose-extra/$name 里列的）"; missing=1; fi ;;
      *) log ".release/compose-extra/$name 里这一行看不懂（要绝对路径或 nobuild: 服务名）：$line"; missing=1 ;;
    esac
  done <"$state/compose-extra/$name"
  [ "$missing" = 0 ]
}

# 回退目标的 compose 写死了 SHELL_AUTH: lobe-session、又没配叠加文件 → 切过去所有者会被挡在外面（LobeHub 已停）
LOBE_OK=0
guard_shell_auth() { # guard_shell_auth <提交> <版本名> <用途>
  local commit="$1" name="$2" why="$3"
  [ "$LOBE_OK" = 1 ] && return 0
  git_ show "$commit:deploy/docker-compose.yml" 2>/dev/null | grep -qE '^[[:space:]]*SHELL_AUTH:[[:space:]]*"?lobe-session"?[[:space:]]*$' || return 0
  load_extra "$name" || return 1
  if [ "${#EXTRA_FILES[@]}" = 0 ]; then
    log "$why $name 的 compose 写死 SHELL_AUTH: lobe-session，又没有 .release/compose-extra/$name：切过去 Shell 只认 LobeHub 登录，所有者会进不去。先按 docs/ops/RELEASE.md「回退到 v0.1.0」配好叠加文件（或确认要回旧登录时加 --lobe-session-ok）"
    return 1
  fi
  log "$why $name 时会叠加：${EXTRA_FILES[*]}${NOBUILD[*]:+（不重建：${NOBUILD[*]}）}"
}

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
    "$ROOT/scripts/build-console.sh" >>"$compose_log" 2>&1
    test -f "$ROOT/web/console/dist/index.html"
  fi
}

# 工作区里已跟踪的文件有改动就拒绝（切换不加 --force，不悄悄丢掉服务器上的手工修改）。只列文件名。
require_clean_tree() {
  local dirty
  dirty="$(git_ status --porcelain --untracked-files=no | cut -c4- | head -20)"
  if [ -n "$dirty" ]; then
    log "工作区有未提交的改动（已跟踪文件）："
    printf '%s\n' "$dirty" | sed 's/^/    /' >&2
    die "先处理这些改动（不要在服务器上直接改已跟踪的文件），再发布"
  fi
}

# 一条 SQL（stdin）→ 制表符分隔的行，只读
db_q() {
  if [ -n "${RELEASE_DB_CMD:-}" ]; then
    # shellcheck disable=SC2086  # 命令由调用方给出，允许带参数
    $RELEASE_DB_CMD
  else
    compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
      psql -X -q -A -t -F $'\t' -v ON_ERROR_STOP=1 -U postgres -d "${RELEASE_PRECHECK_DB:-aroomo_core}"
  fi
}

# 数据库已执行的迁移里，有没有 <提交> 里的 core/migrations/ 不认识的。
# 返回 0 = 没有（可以放心切到它）；1 = 有（切过去会让新迁移的数据面对旧代码）；2 = 读不出来。
# 超前的迁移文件名写进全局 MIG_UNKNOWN（只有文件名，没有数据）。
MIG_UNKNOWN=""
db_ahead_of() {
  local commit="$1" has applied known
  has="$(printf '%s\n' "select coalesce(to_regclass('public.core_schema_migrations')::text, '')" | db_q 2>/dev/null)" || return 2
  # 生产库一定有迁移记录表；查不到（schema 不对、连错库）不能当成「没迁移过」放行，按读不出处理（失败即关闭）
  [ -n "$has" ] || { MIG_UNKNOWN=""; return 2; }
  applied="$(printf '%s\n' "select version from core_schema_migrations" | db_q 2>/dev/null)" || return 2
  known="$(git_ ls-tree --name-only "$commit" core/migrations/ 2>/dev/null | sed 's|.*/||' | grep -E '^[0-9]{4}_[a-z0-9_]+\.sql$' || true)"
  MIG_UNKNOWN="$(comm -23 <(printf '%s\n' "$applied" | grep . | sort) <(printf '%s\n' "$known" | grep . | sort) | tr '\n' ' ')"
  [ -z "$MIG_UNKNOWN" ]
}

# 回退/切换到 <提交> 前的迁移检查：不过就返回 1，并写明原因
migration_guard() {
  local commit="$1" why="$2" rc=0
  db_ahead_of "$commit" || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) log "需要人工处理：数据库已执行 ${MIG_UNKNOWN% }（$(short "$commit") 不认识这些迁移），$why。先用部署前备份恢复数据库（docs/ops/BACKUP.md），再回滚代码"; return 1 ;;
    *) log "需要人工处理：读不出数据库的迁移记录（或迁移记录表 public.core_schema_migrations 不存在），无法确认 $(short "$commit") 能不能用现在的数据库，$why"; return 1 ;;
  esac
}

# 取出 <提交> 里的 scripts/ 到临时目录并打印路径（生产前检查和闸门要用目标版本自己的那份）
extract_scripts() {
  local commit="$1" d
  d="$(mktemp -d /tmp/release-scripts.XXXXXX)"
  git_ archive "$commit" scripts 2>/dev/null | tar -x -C "$d" 2>/dev/null || true
  # 迁移目录也取出来：precheck 检查 1 要知道本次发布有哪些待执行迁移（分开取，旧版本没有这个目录也不影响 scripts/）
  git_ archive "$commit" core/migrations 2>/dev/null | tar -x -C "$d" 2>/dev/null || true
  printf '%s' "$d"
}

# 切到 ref 并起服务；每一步显式 || return 1（在 if 里调用时 set -e 不生效）
switch_to() {
  local ref="$1" from="$2" to
  to="$(commit_of "$ref")" || { log "找不到 $ref"; return 1; }
  load_extra "$(short "$ref")" || { log "$(short "$ref") 的叠加文件不全，不切换"; return 1; }
  git_ -c advice.detachedHead=false checkout -q "$to" || { log "检出 $(short "$ref") 失败"; return 1; }
  check_env || return 1
  build_console_if_needed "$from" "$to" || { log "控制台构建失败"; return 1; }
  export AROOMO_COMMIT="$to"
  local s build=() up=(-d --remove-orphans)
  for s in core shell; do [[ " ${NOBUILD[*]} " == *" $s "* ]] || build+=("$s"); done
  # 有不重建的服务：up 也不许顺手构建（镜像缺了宁可失败，也不用旧代码造一个同名镜像）
  [ "${#NOBUILD[@]}" = 0 ] || up+=(--no-build)
  [ "${#EXTRA_FILES[@]}" = 0 ] || log "叠加：${EXTRA_FILES[*]}${NOBUILD[*]:+；不重建：${NOBUILD[*]}}"
  if [ "${#build[@]}" -gt 0 ]; then
    compose build "${build[@]}" >>"$compose_log" 2>&1 || { log "镜像构建失败"; return 1; }
  fi
  compose pull --ignore-buildable -q >>"$compose_log" 2>&1 || true
  compose up "${up[@]}" >>"$compose_log" 2>&1 || { log "compose up 失败"; return 1; }
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
  log "切换失败：$(short "$target")，准备回到 $(short "$cur")"
  if ! migration_guard "$(commit_of "$cur" || echo "$cur")" "没有自动回退，生产代码停在 $(short "$target")，记录的当前版本仍是 $(short "$cur")"; then
    return 1
  fi
  log "自动回到 $(short "$cur")"
  if switch_to "$cur" "$(commit_of "$target" || true)"; then
    log "已回到 $(short "$cur")，生产仍是它"
  else
    log "回退也失败，需要人工处理（生产状态未知）"
  fi
  return 1
}

# 合并闸门（#189 / #351）：用目标版本里的 scripts/ci/merge-gate.py（hotfix 豁免）。
# 仓库里有带 needs-leader-review 且无 leader-approved 的 PR → 非零退出 → 拒绝发布（演练也查，失败即关闭）。
# GH_TOKEN 从调用者环境继承（只读、仅本仓库的令牌），不写文件、不打印、不传给别的命令。
# 闸门固定只读（MERGE_GATE_READONLY=1，#352 M2）：PR 带 hotfix 标签照样放行，但服务器不写评论/标签，
# 补审跟踪由 CI 的 merge-gate 工作流在 v* 标签推送时写。没有本地跳过开关（#352 M3）。
run_gate() {
  local gate="$1/scripts/ci/merge-gate.py"
  if [ ! -f "$gate" ]; then
    [ "${RELEASE_REQUIRE_GATE:-1}" = 1 ] \
      || { log "提示：目标版本没有合并闸门（#189），RELEASE_REQUIRE_GATE=0 已放行"; return 0; }
    die "目标版本 $(short "$target") 里没有 scripts/ci/merge-gate.py（#189），不部署（首个可部署标签要在 #351/#352 进 main 之后打；回到更早的版本用 rollback）"
  fi
  [ -n "${GH_TOKEN:-}" ] || die "合并闸门要查 GitHub：需要主会话在环境里提供只读 GH_TOKEN（read -rs GH_TOKEN; export GH_TOKEN），不要写进 .env 或命令行"
  command -v "${RELEASE_PYTHON:-python3}" >/dev/null || die "服务器没有 python3，合并闸门跑不了，不部署"
  MERGE_GATE_READONLY=1 REPO="${RELEASE_GATE_REPO:-uniwof/Aroomo-Developer}" TAG_SHA="$tcommit" TAG_NAME="$target" PR_NUMBER="" GITHUB_STEP_SUMMARY="" \
    "${RELEASE_PYTHON:-python3}" -B "$gate" || die "合并闸门不通过（见上面列出的待审 PR），不部署"
}

# 生产前检查 + 部署前备份（#229）。dry 时只检查、不备份。脚本取自目标版本（只有新版本知道自己要跑哪些迁移）
run_precheck() {
  local dry="$1" pre="$2/scripts/release-precheck.sh"
  if [ -x "$pre" ]; then
    if [ "$dry" = 1 ]; then RELEASE_ROOT="$ROOT" RELEASE_TIER="$TIER" "$pre" --no-backup || die "生产前检查不通过"
    else RELEASE_ROOT="$ROOT" RELEASE_TIER="$TIER" "$pre" || die "生产前检查或部署前备份不通过，不部署"; fi
  elif [ "${RELEASE_REQUIRE_PRECHECK:-1}" = 1 ]; then
    die "目标版本 $(short "$target") 里没有 scripts/release-precheck.sh，不部署"
  else
    log "提示：生产前检查（#229）尚未启用，已跳过（调用点：scripts/release-precheck.sh）"
  fi
}

cmd="${1:-status}"; shift || true
target=""; confirm=""
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) confirm="${2:-}"; shift 2 || die "--confirm 后面要写版本号" ;;
    --hotfix) die "没有本地 --hotfix 了（#352 M3）：紧急修复的豁免只认 GitHub 上该 PR 的 hotfix 标签（合并闸门判定），给 PR 加上 hotfix 标签后照常部署" ;;
    --lobe-session-ok) LOBE_OK=1; shift ;;
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
  *) die "用法：release-tag.sh list | status | deploy vX.Y.Z [--confirm vX.Y.Z] | rollback [--confirm <版本>]" ;;
esac

exec 9>"$state/lock"
flock -n 9 || die "另一个发布正在进行"

cur="$(current_ref)"
if [ "$cmd" = rollback ]; then
  target="$(read_state previous)"
  [ -n "$target" ] || die "没有记录的上一个版本，无法回滚"
  log "回滚目标：$(short "$target")（当前 $(short "$cur")）"
  commit_of "$target" >/dev/null || die "找不到回滚目标 $(short "$target")"
  tcommit="$(commit_of "$target")"
else
  [[ "$target" =~ $TAG_RE ]] || die "要部署的版本必须是 main 上形如 v0.1.0 的标签（拒绝：${target:-空}）"
  fetch_remote
  commit_of "refs/tags/$target" >/dev/null || die "找不到标签 $target"
  git_ merge-base --is-ancestor "refs/tags/$target^{commit}" "refs/remotes/$REMOTE/$MAIN_BRANCH" \
    || die "标签 $target 不在 $MAIN_BRANCH 上，生产只部署 main 上的标签"
  tcommit="$(commit_of "refs/tags/$target")"
  if [ "$tcommit" = "$(git_ rev-parse HEAD)" ] && [ "$(read_state current)" = "$target" ]; then
    log "生产已经是 $target，无需部署"; exit 0
  fi
  echo "--- 更新日志（$(short "$cur") → $target）---"
  git_ log --format='%h %s' "$(commit_of "$cur" || echo "$target")..refs/tags/$target^{commit}" 2>/dev/null | head -40 || true
  echo "---"
fi

# 演练也做的只读检查：工作区干净、.env 合格、数据库迁移不超前于目标版本
require_clean_tree
check_env || die "deploy/.env 不合格（见上一行），先处理再发布"
migration_guard "$tcommit" "拒绝切到它" || die "数据库迁移与目标版本不匹配"
# 回退目标（rollback 的目标；deploy 失败时自动回到的当前版本）不能把所有者挡在门外
if [ "$cmd" = rollback ]; then
  guard_shell_auth "$tcommit" "$(short "$target")" "回滚到" || die "回滚目标的 Shell 登录方式不对，不回滚"
elif ccommit="$(commit_of "$cur")"; then
  guard_shell_auth "$ccommit" "$(short "$cur")" "切换失败时会自动回到" || die "自动回退目标的 Shell 登录方式不对，先配好叠加文件再部署"
fi
EXTRA_FILES=(); NOBUILD=()

# 生产前检查和闸门用目标版本里的 scripts/（RELEASE_ROOT 仍指向生产目录）
tscripts="$(extract_scripts "$tcommit")"
trap 'rm -f "$RELEASE_TAG_COPY"; rm -rf "$tscripts"' EXIT
if [ "$cmd" = deploy ]; then run_gate "$tscripts"; fi

# 没带对的 --confirm：只演练
if [ -z "$confirm" ] || { [ "$confirm" != "$target" ] && [ "$confirm" != "$(short "$target")" ]; }; then
  if [ "$cmd" = deploy ]; then run_precheck 1 "$tscripts"; fi
  log "演练完成，未切换。$CONFIRM_MSG：$(short "$target")。确认后运行：scripts/release-tag.sh $cmd $( [ "$cmd" = deploy ] && echo "$target " )--confirm $(short "$target")"
  exit 0
fi

if [ "$cmd" = deploy ]; then run_precheck 0 "$tscripts"; fi
log "$CONFIRM_MSG（已确认：$(short "$target")）"
do_switch "$target" "$cur"
