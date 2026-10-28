#!/usr/bin/env bash
# 独立版构建第 1 步（Linux x86_64，CI 的 ubuntu 机器）：从 LobeHub 官方 Docker 镜像取出程序，做成 Windows 能用的 lobe.tar.gz。
# DECISIONS D66、D76。可用 LOBE_IMAGE=镜像@sha256:摘要 换成带 Aroomo 薄层的镜像。只用固定版本、核对校验值（installer/standalone/versions.json）。
#
#   1. crane 按摘要（digest）导出 lobehub/lobehub:2.2.20 的 linux/amd64 文件系统里的 /app（内容寻址，摘要就是校验）
#   2. 不改 LobeHub 的任何文件；只把两个 Linux 平台二进制依赖换成同版本的 Windows 官方构建：
#        sharp（图片处理）：@img/sharp-linux-x64 → @img/sharp-win32-x64（npm 官方包，核对 integrity）
#        ffmpeg-static：Linux 的 ffmpeg → 同一发布（b6.1.1）的 ffmpeg.exe（核对 SHA-256）
#   3. 加上 LobeHub 的许可证文件（LICENSE-LobeHub.txt）
#   4. 检查：不能残留 Linux 可执行文件；路径在 Windows 上合法、不重名（不区分大小写）；没有绝对路径的链接
#   5. 打包为 pax 格式的 tar.gz（保留符号链接，安装时由 runtime/unpack-lobe.cjs 建成目录联接）
#
# 用法：installer/standalone/build/prepare-lobe.sh <输出目录>
# 输出：<输出目录>/lobe.tar.gz、lobe.tar.gz.sha256
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
versions="$here/../versions.json"
out="$(mkdir -p "${1:?用法：prepare-lobe.sh <输出目录>}" && cd "$1" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

v() { jq -er "$1" "$versions"; }

fetch() { # url sha256 输出文件
  curl -fsSL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c --quiet - || { echo "校验失败：$1" >&2; exit 1; }
}

echo "== 1/5 下载 crane 并导出官方镜像"
if [[ -n "${CRANE_BIN:-}" ]]; then
  cp "$CRANE_BIN" "$work/crane"   # 只用于在非 x86_64 机器上本地试跑
else
  fetch "$(v .crane.url)" "$(v .crane.sha256)" "$work/crane.tgz"
  tar -xzf "$work/crane.tgz" -C "$work" crane
fi
img="${LOBE_IMAGE:-$(v .lobehub.image)@$(v .lobehub.digest_linux_amd64)}"
mkdir -p "$work/root"
"$work/crane" export "$img" - | tar -x -C "$work/root" app
app="$work/root/app"
test -f "$app/server.js" && test -f "$app/docker.cjs" || { echo "镜像里没有 /app/server.js 或 /app/docker.cjs" >&2; exit 1; }

echo "== 2/5 换 sharp 的平台包"
pnpm_dir="$app/node_modules/.pnpm"
for row in $(jq -c '.sharp_win32[]' "$versions"); do
  ver="$(jq -r .version <<<"$row")"
  integ="$(jq -r .integrity <<<"$row")"
  got="$(npm view "@img/sharp-win32-x64@$ver" dist.integrity)"
  [[ "$got" == "$integ" ]] || { echo "sharp-win32-x64@$ver 的 integrity 不对：$got" >&2; exit 1; }
  (cd "$work" && npm pack --silent "@img/sharp-win32-x64@$ver" >/dev/null)
  tgz="$work/img-sharp-win32-x64-$ver.tgz"
  calc="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
  [[ "$calc" == "$integ" ]] || { echo "sharp-win32-x64@$ver 下载内容与 integrity 不符" >&2; exit 1; }
  dst="$pnpm_dir/@img+sharp-win32-x64@$ver/node_modules/@img/sharp-win32-x64"
  mkdir -p "$dst"
  tar -xzf "$tgz" -C "$dst" --strip-components=1
  # 每个用到这个版本的 sharp：去掉 linux 链接，加上 win32 链接
  for sd in "$pnpm_dir"/sharp@"$ver"*/node_modules/@img; do
    [[ -d "$sd" ]] || continue
    rm -f "$sd/sharp-linux-x64" "$sd/sharp-libvips-linux-x64"
    ln -s "../../../@img+sharp-win32-x64@$ver/node_modules/@img/sharp-win32-x64" "$sd/sharp-win32-x64"
  done
  rm -rf "$pnpm_dir/@img+sharp-linux-x64@$ver"
done
rm -rf "$pnpm_dir"/@img+sharp-libvips-linux-x64@*
# pnpm 提升到 .pnpm/node_modules 的链接：换成 win32（指向最高版本）
hoist="$pnpm_dir/node_modules/@img"
if [[ -d "$hoist" ]]; then
  rm -f "$hoist/sharp-linux-x64" "$hoist/sharp-libvips-linux-x64"
  top="$(jq -r '.sharp_win32[-1].version' "$versions")"
  ln -s "../../@img+sharp-win32-x64@$top/node_modules/@img/sharp-win32-x64" "$hoist/sharp-win32-x64"
fi

echo "== 3/5 换 ffmpeg-static 的平台文件"
ff="$(echo "$pnpm_dir"/ffmpeg-static@*/node_modules/ffmpeg-static)"
[[ -f "$ff/index.js" ]] || { echo "找不到 ffmpeg-static" >&2; exit 1; }
want="$(v .ffmpeg_win32.release)"
have="$(jq -r '.["ffmpeg-static"]["binary-release-tag"]' "$ff/package.json")"
[[ "$have" == "$want" ]] || { echo "ffmpeg-static 用的是 $have，versions.json 写的是 $want" >&2; exit 1; }
fetch "$(v .ffmpeg_win32.url)" "$(v .ffmpeg_win32.sha256)" "$work/ffmpeg.gz"
fetch "$(v .ffmpeg_win32.license_url)" "$(v .ffmpeg_win32.license_sha256)" "$work/ffmpeg.LICENSE"
rm -f "$ff/ffmpeg" "$ff/ffmpeg.README"
gunzip -c "$work/ffmpeg.gz" >"$ff/ffmpeg.exe"
cp "$work/ffmpeg.LICENSE" "$ff/ffmpeg.LICENSE"

echo "== 4/5 许可证和检查"
fetch "$(v .lobehub.license_url)" "$(v .lobehub.license_sha256)" "$app/LICENSE-LobeHub.txt"
cp "$app/LICENSE-LobeHub.txt" "$out/LICENSE-LobeHub.txt"
# 断链（上游镜像里本来就有）和指向镜像外的绝对链接
bad_abs="$(find "$app" -type l -lname '/*' | head -5)"
[[ -z "$bad_abs" ]] || { echo "有绝对路径的链接：$bad_abs" >&2; exit 1; }
elf="$(find "$app" -type f -size +4k -print0 | xargs -0 -n 200 file -N --mime-type 2>/dev/null | grep -E 'application/x-(executable|sharedlib|pie-executable)' | head -5 || true)"
[[ -z "$elf" ]] || { echo "还有 Linux 二进制文件：$elf" >&2; exit 1; }
badname="$(cd "$work/root" && find app | grep -E '[<>:"|?*\\]|/(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?$' -i | head -5 || true)"
[[ -z "$badname" ]] || { echo "有 Windows 不允许的文件名：$badname" >&2; exit 1; }
dups="$(cd "$work/root" && find app | tr '[:upper:]' '[:lower:]' | sort | uniq -d | head -5)"
[[ -z "$dups" ]] || { echo "有只差大小写的重名文件：$dups" >&2; exit 1; }

echo "== 5/5 打包"
(cd "$work/root" && tar --format=pax --owner=0 --group=0 --numeric-owner -czf "$out/lobe.tar.gz" app)
sha="$(sha256sum "$out/lobe.tar.gz" | cut -d' ' -f1)"
echo "$sha" >"$out/lobe.tar.gz.sha256"
echo "lobe.tar.gz $(stat -c %s "$out/lobe.tar.gz") 字节 sha256 $sha（文件 $(find "$app" -type f | wc -l) 个，链接 $(find "$app" -type l | wc -l) 个）"
