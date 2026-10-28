#!/usr/bin/env bash
# 独立版构建第 1b 步（Linux x86_64）：完整档模块 Karakeep（收藏）和 RSSHub 的 Windows 离线程序包。
# 做法和 prepare-lobe.sh 一样：crane 按摘要导出官方镜像的程序文件夹，原样使用，只把 Linux 平台的二进制依赖
# 换成同版本的 Windows 官方构建（全部核对 integrity / SHA-256，见 versions.json）。不改上游源码。
#
#   karakeep.tar.gz：/app（web + workers）+ /db_migrations（放进 app/db_migrations）
#       sharp 0.35.5 → @img/sharp-win32-x64；re2 1.26.1 → 官方发布的 win32-x64（Node 22 ABI 127）；
#       better-sqlite3 自带 win32-x64 预编译（删掉其他平台）；删 esbuild 的 Linux 可执行文件（运行时不用）
#   rsshub.tar.gz：/app
#       oxc-parser 绑定 → @oxc-parser/binding-win32-x64-msvc；bufferutil / utf-8-validate 的 Linux 预编译删掉（ws 自动用纯 JS）
#
# 用法：prepare-apps.sh <输出目录>      输出：karakeep.tar.gz(.sha256)、rsshub.tar.gz(.sha256)、LICENSE-*.txt
set -Eeuo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
versions="$here/../versions.json"
out="$(mkdir -p "${1:?用法：prepare-apps.sh <输出目录>}" && cd "$1" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
v() { jq -er "$1" "$versions"; }
fetch() { curl -fsSL --retry 3 -o "$3" "$1"; echo "$2  $3" | sha256sum -c --quiet - || { echo "校验失败：$1" >&2; exit 1; }; }

npm_pkg() { # 包名@版本 integrity 解压到的目录
  local spec="$1" integ="$2" dst="$3" got tgz calc
  got="$(npm view "$spec" dist.integrity)"
  [[ "$got" == "$integ" ]] || { echo "$spec 的 integrity 不对：$got" >&2; exit 1; }
  rm -f "$work"/*.tgz
  (cd "$work" && npm pack --silent "$spec" >/dev/null)
  tgz="$(ls "$work"/*.tgz | head -1)"
  calc="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
  [[ "$calc" == "$integ" ]] || { echo "$spec 下载内容与 integrity 不符" >&2; exit 1; }
  rm -rf "$dst"; mkdir -p "$dst"
  tar -xzf "$tgz" -C "$dst" --strip-components=1
  rm -f "$tgz"
}

check_tree() { # 根目录（含 app/）
  local root="$1" app="$1/app" bad_abs elf badname dups
  bad_abs="$(find "$app" -type l -lname '/*' | head -5)"
  [[ -z "$bad_abs" ]] || { echo "有绝对路径的链接：$bad_abs" >&2; exit 1; }
  elf="$(find "$app" -type f -size +4k -print0 | xargs -0 -n 200 file -N --mime-type 2>/dev/null | grep -E 'application/x-(executable|sharedlib|pie-executable)' | head -5 || true)"
  [[ -z "$elf" ]] || { echo "还有 Linux 二进制文件：$elf" >&2; exit 1; }
  badname="$(cd "$root" && find app | grep -E '[<>:"|?*\\]|/(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.[^/]*)?$' -i | head -5 || true)"
  [[ -z "$badname" ]] || { echo "有 Windows 不允许的文件名：$badname" >&2; exit 1; }
  dups="$(cd "$root" && find app | tr '[:upper:]' '[:lower:]' | sort | uniq -d | head -5)"
  [[ -z "$dups" ]] || { echo "有只差大小写的重名文件：$dups" >&2; exit 1; }
}

pack() { # 根目录 名字
  (cd "$1" && tar --format=pax --owner=0 --group=0 --numeric-owner -czf "$out/$2.tar.gz" app)
  sha256sum "$out/$2.tar.gz" | cut -d' ' -f1 >"$out/$2.tar.gz.sha256"
  echo "$2.tar.gz $(stat -c %s "$out/$2.tar.gz") 字节（文件 $(find "$1/app" -type f | wc -l) 个，链接 $(find "$1/app" -type l | wc -l) 个）"
}

echo "== crane"
if [[ -n "${CRANE_BIN:-}" ]]; then cp "$CRANE_BIN" "$work/crane"; else
  fetch "$(v .crane.url)" "$(v .crane.sha256)" "$work/crane.tgz"; tar -xzf "$work/crane.tgz" -C "$work" crane
fi

# ---------------------------------------------------------------------------
echo "== Karakeep $(v .karakeep.version)"
kr="$work/karakeep"; mkdir -p "$kr"
"$work/crane" export "$(v .karakeep.image)@$(v .karakeep.digest_linux_amd64)" - | tar -x -C "$kr" app db_migrations
mv "$kr/db_migrations" "$kr/app/db_migrations"
ka="$kr/app"
test -f "$ka/apps/web/server.js" && test -f "$ka/apps/workers/dist/index.js" && test -f "$ka/db_migrations/index.js" || { echo "Karakeep 镜像结构变了" >&2; exit 1; }

# sharp：web 用的是平铺的 node_modules/@img；workers 用 pnpm 的 .pnpm
sv="$(v .karakeep.sharp)"
sharp_integ="$(jq -er --arg v "$sv" '.sharp_win32[] | select(.version == $v) | .integrity' "$versions")"
npm_pkg "@img/sharp-win32-x64@$sv" "$sharp_integ" "$work/sharp-win32"
for img in "$ka/node_modules/@img"; do
  [[ -d "$img" ]] || continue
  rm -rf "$img/sharp-linux-x64" "$img/sharp-libvips-linux-x64"
  cp -a "$work/sharp-win32" "$img/sharp-win32-x64"
done
wp="$ka/apps/workers/node_modules/.pnpm"
if [[ -d "$wp/@img+sharp-linux-x64@$sv" ]]; then
  mkdir -p "$wp/@img+sharp-win32-x64@$sv/node_modules/@img"
  cp -a "$work/sharp-win32" "$wp/@img+sharp-win32-x64@$sv/node_modules/@img/sharp-win32-x64"
  for sd in "$wp"/sharp@"$sv"*/node_modules/@img; do
    [[ -d "$sd" ]] || continue
    rm -f "$sd/sharp-linux-x64" "$sd/sharp-libvips-linux-x64"
    ln -s "../../../@img+sharp-win32-x64@$sv/node_modules/@img/sharp-win32-x64" "$sd/sharp-win32-x64"
  done
  rm -rf "$wp/@img+sharp-linux-x64@$sv" "$wp"/@img+sharp-libvips-linux-x64@*
  if [[ -d "$wp/node_modules/@img" ]]; then
    rm -f "$wp/node_modules/@img/sharp-linux-x64" "$wp/node_modules/@img/sharp-libvips-linux-x64"
    ln -s "../../@img+sharp-win32-x64@$sv/node_modules/@img/sharp-win32-x64" "$wp/node_modules/@img/sharp-win32-x64"
  fi
fi

# re2：官方发布的 Windows 预编译（brotli 压缩的 .node）
re2dir="$(echo "$wp"/re2@"$(v .karakeep.re2.version)"/node_modules/re2)"
[[ -f "$re2dir/re2.js" ]] || { echo "找不到 re2 $(v .karakeep.re2.version)" >&2; exit 1; }
fetch "$(v .karakeep.re2.url)" "$(v .karakeep.re2.sha256)" "$work/re2.br"
rm -f "$re2dir/build/Release/re2.node"
node -e 'const z=require("zlib"),f=require("fs");f.writeFileSync(process.argv[2],z.brotliDecompressSync(f.readFileSync(process.argv[1])))' "$work/re2.br" "$re2dir/build/Release/re2.node"
file "$re2dir/build/Release/re2.node" | grep -q 'PE32+' || { echo "re2.node 不是 Windows 程序" >&2; exit 1; }

# better-sqlite3：自带 win32-x64 预编译，删掉其他平台的
while IFS= read -r -d '' pb; do
  [[ -f "$pb/win32-x64.node" ]] || { echo "better-sqlite3 缺少 win32-x64 预编译：$pb" >&2; exit 1; }
  find "$pb" -maxdepth 1 -type f -name '*.node' ! -name 'win32-x64.node' -delete
done < <(find "$ka" -type d -name prebuilds \( -path '*better-sqlite3*' -o -path "$ka/db_migrations/prebuilds" \) -print0)
# 其他只给构建用的 Linux 可执行文件（esbuild），运行时不用
find "$ka" -type d \( -path '*/@esbuild/linux-x64' -o -path '*/@esbuild+linux-x64@*' \) -prune -exec rm -rf {} +
find "$ka" -type f -path '*/esbuild/bin/esbuild' -delete
find "$ka" -xtype l -delete
# OCR 语言数据（离线）：tesseract.js 先读 OCR_CACHE_DIR/<语言>.traineddata，没有才上网下载
mkdir -p "$ka/tessdata"
for row in $(jq -c '.karakeep.tessdata[]' "$versions"); do
  pkg="$(jq -r .package <<<"$row")"; ver="$(jq -r .version <<<"$row")"; lang="$(jq -r .lang <<<"$row")"
  npm_pkg "$pkg@$ver" "$(jq -r .integrity <<<"$row")" "$work/td-$lang"
  gunzip -c "$work/td-$lang/4.0.0_best_int/$lang.traineddata.gz" >"$ka/tessdata/$lang.traineddata"
done
fetch "$(v .karakeep.license_url)" "$(v .karakeep.license_sha256)" "$ka/LICENSE-Karakeep.txt"
cp "$ka/LICENSE-Karakeep.txt" "$out/LICENSE-Karakeep.txt"
check_tree "$kr"
pack "$kr" karakeep

# ---------------------------------------------------------------------------
echo "== RSSHub $(v .rsshub.revision)"
rr="$work/rsshub"; mkdir -p "$rr"
"$work/crane" export "$(v .rsshub.image)@$(v .rsshub.digest_linux_amd64)" - | tar -x -C "$rr" app
ra="$rr/app"; rp="$ra/node_modules/.pnpm"
test -f "$ra/dist/index.mjs" || { echo "RSSHub 镜像结构变了" >&2; exit 1; }
ov="$(v .rsshub.oxc_parser.version)"
npm_pkg "@oxc-parser/binding-win32-x64-msvc@$ov" "$(v .rsshub.oxc_parser.integrity)" "$rp/@oxc-parser+binding-win32-x64-msvc@$ov/node_modules/@oxc-parser/binding-win32-x64-msvc"
for od in "$rp"/oxc-parser@"$ov"*/node_modules/@oxc-parser; do
  [[ -d "$od" ]] || continue
  rm -f "$od/binding-linux-x64-gnu" "$od/binding-linux-x64-musl"
  ln -s "../../../@oxc-parser+binding-win32-x64-msvc@$ov/node_modules/@oxc-parser/binding-win32-x64-msvc" "$od/binding-win32-x64-msvc"
done
rm -rf "$rp"/@oxc-parser+binding-linux-x64-*
find "$ra" -type d -path '*/prebuilds/linux-*' -prune -exec rm -rf {} +
find "$ra" -type d \( -path '*/@esbuild/linux-x64' -o -path '*/@esbuild+linux-x64@*' \) -prune -exec rm -rf {} +
find "$ra" -type f -path '*/esbuild/bin/esbuild' -delete
find "$ra" -xtype l -delete
fetch "$(v .rsshub.license_url)" "$(v .rsshub.license_sha256)" "$ra/LICENSE-RSSHub.txt"
cp "$ra/LICENSE-RSSHub.txt" "$out/LICENSE-RSSHub.txt"
check_tree "$rr"
pack "$rr" rsshub
