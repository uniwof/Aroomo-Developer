#!/usr/bin/env bash
# D179 Python 许可证闸门：对仓库内每个 requirements*.txt 建临时 venv 安装后用 pip-licenses 检查。
# 判定规则与 npm 共用 policy.mjs（pip-licenses 输出 JSON → node 判定）。
set -Eeuo pipefail
root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mapfile -t reqs < <(find "$root" -name 'requirements*.txt' -not -path '*/node_modules/*' -not -path '*/.git/*' | sort)
if [ "${#reqs[@]}" -eq 0 ]; then
  echo "未找到 requirements*.txt，Python 依赖为空，跳过"
  exit 0
fi

rc=0
for req in "${reqs[@]}"; do
  tmp="$(mktemp -d)"
  python3 -m venv "$tmp/venv"
  "$tmp/venv/bin/pip" install -q --disable-pip-version-check -r "$req"
  # pip-licenses 本身（MIT）装在同一 venv 里，结果中排除它和 pip 自身
  "$tmp/venv/bin/pip" install -q --disable-pip-version-check 'pip-licenses==5.0.0'
  "$tmp/venv/bin/pip-licenses" --format=json --with-system \
    --ignore-packages pip-licenses prettytable wcwidth pip setuptools wheel tomli \
    > "$tmp/licenses.json"
  if ! node "$here/judge-python.mjs" "$tmp/licenses.json" "${req#"$root"/}"; then rc=1; fi
  rm -rf "$tmp"
done
exit "$rc"
