#!/usr/bin/env bash
# Trivy 镜像漏洞扫描（#177 / #337）：HIGH/CRITICAL 且有修复版本的漏洞 → 退出码 1。
# 放行名单 .github/trivyignore.txt（一行一个编号，exp: 到期日，到期自动失效）。
# 用法：scripts/ci/trivy-scan.sh 镜像1 [镜像2 ...]
# 只开漏洞扫描（--scanners vuln），不扫密钥，输出里不会有任何密钥内容。
set -euo pipefail
[ $# -gt 0 ] || { echo "用法：$0 镜像 [镜像 ...]" >&2; exit 2; }

# 2026-03 Trivy 供应链事件后官方确认安全的版本（GHSA-69fq-xp46-6x23）；
# 不用 trivy-action，直接下载官方二进制并核对写死的 SHA-256（官方 checksums 文件里的值）
TRIVY_VERSION=0.69.3
TRIVY_SHA256=1816b632dfe529869c740c0913e36bd1629cb7688bd5634f4a858c1d57c88b75
root=$(cd "$(dirname "$0")/../.." && pwd)
bin=${RUNNER_TEMP:-/tmp}/trivy-${TRIVY_VERSION}

if [ ! -x "$bin/trivy" ]; then
  mkdir -p "$bin"
  curl -sSfL -o "$bin/trivy.tgz" \
    "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
  echo "${TRIVY_SHA256}  $bin/trivy.tgz" | sha256sum -c -
  tar xzf "$bin/trivy.tgz" -C "$bin" trivy
fi

rc=0
for img in "$@"; do
  echo "== Trivy：$img"
  "$bin/trivy" image --quiet --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed \
    --ignorefile "$root/.github/trivyignore.txt" --exit-code 1 --format table "$img" || rc=1
done
exit "$rc"
