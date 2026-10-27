#!/usr/bin/env bash
# 恢复演练（PRODUCT §7.6、§15.3；DECISIONS v4.3 P0-e：P0 必须完成一次恢复演练并记录耗时）。
#
# 在一套「隔离的临时 compose 项目」里（不同 project name → 全新的卷、不发布端口）从快照恢复，
# 逐表核对行数，检查对象存储能启动，记录每个阶段的耗时，写一份 Markdown 报告，最后清理。
# 不会碰正在运行的正式服务和它们的数据。
#
# 用法（在服务器或本机的仓库根目录）：
#   scripts/restore-drill.sh                      # 最新快照
#   scripts/restore-drill.sh --snapshot 3f0d08c9  # 指定快照
#   scripts/restore-drill.sh --keep               # 演练后保留临时项目（排查用；记得手动 down -v）
#
# 环境变量：
#   DRILL_ENV_FILE       默认 deploy/.env（读取备份仓库地址、口令、数据库密码）
#   DRILL_TIER           默认 demo-2g（演练只起 postgres / rustfs，占用最少内存）
#   DRILL_REPORT_DIR     默认 drill-reports/
#   DRILL_PROJECT        默认 aroomo-drill-<时间>
#   DRILL_EXTRA_COMPOSE  额外叠加的 compose 文件（空格分隔；CI 用来接入测试用的备份目标网络）
#   DRILL_CHECK_LITELLM  1 = 额外用恢复后的库启动 LiteLLM，检查能启动且日志里没有解密错误
#                        （需要 .env 里的 LITELLM_SALT_KEY 与备份时一致）
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
deploy="$root/deploy"

snapshot="latest"
keep=0
while (( $# )); do
  case "$1" in
    --snapshot) snapshot="${2:?--snapshot 需要快照 id}"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "restore-drill: 未知参数 $1" >&2; exit 64 ;;
  esac
done

env_file="${DRILL_ENV_FILE:-$deploy/.env}"
tier="${DRILL_TIER:-demo-2g}"
stamp="$(date +%Y%m%d-%H%M%S)"
project="${DRILL_PROJECT:-aroomo-drill-$stamp}"
report_dir="${DRILL_REPORT_DIR:-$root/drill-reports}"
report="$report_dir/restore-drill-$stamp.md"

[[ -f "$env_file" ]] || { echo "restore-drill: 找不到 $env_file" >&2; exit 2; }
[[ -f "$deploy/tiers/$tier.yml" ]] || { echo "restore-drill: 未知档位 $tier" >&2; exit 2; }
[[ "$project" != "aroomo" ]] || { echo "restore-drill: 演练项目名不能是 aroomo（会碰到正式数据）" >&2; exit 2; }

# 只用基础文件 + 档位文件；绝不叠加 data-dir.yml（会绑定到正式数据目录）和 local.yml（端口冲突）
files=(-f "$deploy/docker-compose.yml" -f "$deploy/tiers/$tier.yml")
read -r -a extra <<<"${DRILL_EXTRA_COMPOSE:-}"
for f in "${extra[@]}"; do
  [[ "$(basename "$f")" == "data-dir.yml" ]] && { echo "restore-drill: 演练不能叠加 data-dir.yml" >&2; exit 2; }
  files+=(-f "$f")
done
dc() { docker compose -p "$project" --project-directory "$deploy" --env-file "$env_file" "${files[@]}" "$@"; }

workdir="$(mktemp -d)"
phase_names=()
phase_secs=()
current=""
phase_t0=0
result="失败"
failed_step=""
restore_json=""
restore_snapshot=""
object_files="未检查"
litellm_check="未检查（DRILL_CHECK_LITELLM=0）"

log() { printf 'restore-drill: %s\n' "$*" >&2; }
begin() { current="$1"; phase_t0=$(date +%s); log "▶ $1"; }
end() { phase_names+=("$current"); phase_secs+=("$(( $(date +%s) - phase_t0 ))"); current=""; }

json_get() { # json_get <json> <python 表达式，d 为解析后的对象>
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))' "$1" "$2" 2>/dev/null || echo "?"
}

write_report() {
  mkdir -p "$report_dir"
  local total=0 i
  for i in "${phase_secs[@]}"; do total=$(( total + i )); done
  {
    echo "# 恢复演练报告 $stamp"
    echo
    echo "| 项目 | 结果 |"
    echo "|------|------|"
    echo "| 结论 | **$result**${failed_step:+（失败于：$failed_step）} |"
    echo "| 时间 | $(date '+%Y-%m-%d %H:%M:%S %Z') |"
    echo "| 机器 | $(hostname) |"
    echo "| 快照 | ${restore_snapshot:-$snapshot} |"
    echo "| 档位 | $tier（临时项目 \`$project\`） |"
    echo "| 总耗时 | ${total} 秒 |"
    echo "| 对象存储文件数 | $object_files |"
    echo "| LiteLLM 启动检查 | $litellm_check |"
    echo
    echo "## 各阶段耗时"
    echo
    echo "| 阶段 | 秒 |"
    echo "|------|----|"
    for i in "${!phase_names[@]}"; do echo "| ${phase_names[$i]} | ${phase_secs[$i]} |"; done
    if [[ -n "$restore_json" ]]; then
      echo
      echo "恢复脚本内部阶段（秒）：\`$(json_get "$restore_json" 'd.get("phases")')\`"
    fi
    echo
    echo "## 恢复日志（摘录）"
    echo
    echo '```'
    grep -E '^restore:' "$workdir/restore.err" 2>/dev/null | tail -40 || echo "（无）"
    echo '```'
    echo
    echo "## 需要人工确认"
    echo
    echo "- [ ] 离线另存的 \`LITELLM_SALT_KEY\` 还在，且与 .env 一致（用 \`DRILL_CHECK_LITELLM=1\` 重跑，或在恢复后的界面里确认各成员 Key 状态正常）"
    echo "- [ ] \`RESTIC_PASSWORD\` 离线另存的副本可用"
    echo "- [ ] 把本报告的结论和总耗时写进简报 / 周报（PRODUCT §15.3）"
  } >"$report"
  log "报告：$report"
}

finish() {
  local code=$?
  if (( code != 0 )) && [[ -n "$current" ]]; then
    failed_step="$current"
    end
  fi
  (( code == 0 )) && result="通过"
  if (( keep )); then
    log "保留临时项目 $project（清理：docker compose -p $project down -v）"
  else
    log "清理临时项目 $project"
    dc --profile restore down -v --remove-orphans >/dev/null 2>&1 || log "清理失败，请手动执行：docker compose -p $project down -v"
  fi
  write_report || true
  rm -rf "$workdir"
  exit "$code"
}
trap finish EXIT

log "临时项目：$project（档位 $tier）"

begin "准备（构建备份镜像）"
dc --profile restore build restore >&2
end

begin "启动空白数据库"
dc up -d --wait postgres >&2
end

begin "从快照恢复（数据库 + 对象存储 + 行数核对）"
if ! dc --profile restore run --rm -T restore --yes-overwrite-database "$snapshot" \
    >"$workdir/restore.out" 2>"$workdir/restore.err"; then
  tail -20 "$workdir/restore.err" >&2
  restore_json="$(tail -1 "$workdir/restore.out" 2>/dev/null || true)"
  false
fi
restore_json="$(tail -1 "$workdir/restore.out")"
restore_snapshot="$(json_get "$restore_json" 'd["snapshot_id"][:8]')"
end

begin "启动对象存储并检查"
dc up -d --wait rustfs >&2
object_files="$(dc --profile restore run --rm -T --entrypoint sh restore -c \
  'find /restore-root/data/rustfs -type f | wc -l' 2>/dev/null | tr -d '[:space:]')"
end

if [[ "${DRILL_CHECK_LITELLM:-0}" == "1" ]]; then
  begin "用恢复后的库启动 LiteLLM"
  litellm_check="失败"
  dc up -d --wait litellm >&2
  if dc logs litellm 2>&1 | grep -qiE 'decrypt|InvalidToken'; then
    litellm_check="启动了，但日志里有解密错误：LITELLM_SALT_KEY 可能与备份时不同"
    false
  fi
  litellm_check="通过（能启动，日志无解密错误）"
  end
fi

log "演练通过"
