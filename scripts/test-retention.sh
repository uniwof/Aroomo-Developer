#!/usr/bin/env bash
# 保留策略（scripts/lib/backup-common.sh 的 retention_keep）单元测试。只需要 bash + jq。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/backup-common.sh
. "$here/lib/backup-common.sh"

fail=0
check() { # check <说明> <期望（空格分隔，按时间排序）> <last> <daily> <weekly> <monthly> <输入时间…>
  local what="$1" want="$2"; shift 2
  local args=("$1" "$2" "$3" "$4"); shift 4
  local got
  got=$(for t in "$@"; do echo "aroomo-x-${t}.tar.zst.age"; done | retention_keep "${args[@]}" | sed -E 's/^aroomo-x-(.*)\.tar\.zst\.age$/\1/' | sort | tr '\n' ' ' | sed 's/ $//')
  if [[ "$got" == "$want" ]]; then echo "ok   $what"; else echo "FAIL $what：期望 [$want]，实际 [$got]" >&2; fail=1; fi
}

check "本机只留最近 3 份" "20261028T020000Z 20261028T030000Z 20261028T040000Z" 3 0 0 0 \
  20261028T010000Z 20261028T040000Z 20261028T020000Z 20261028T030000Z
check "每天留最新一份，最多 2 天" "20261027T033000Z 20261028T200000Z" 0 2 0 0 \
  20261026T033000Z 20261027T033000Z 20261028T033000Z 20261028T200000Z
check "每周（周一开始）留最新一份" "20261025T033000Z 20261028T033000Z" 0 0 2 0 \
  20261019T033000Z 20261025T033000Z 20261026T033000Z 20261028T033000Z
check "每月留最新一份" "20260930T033000Z 20261028T033000Z" 0 0 0 2 \
  20260901T033000Z 20260930T033000Z 20261001T033000Z 20261028T033000Z
check "多条规则取并集" "20261020T033000Z 20261027T033000Z 20261028T200000Z" 0 2 2 1 \
  20261001T033000Z 20261002T033000Z 20261003T033000Z 20261010T033000Z 20261020T033000Z 20261027T033000Z 20261028T033000Z 20261028T200000Z
check "空输入不报错" "" 3 0 0 0
exit "$fail"
