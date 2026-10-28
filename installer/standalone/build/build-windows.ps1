<#
.SYNOPSIS
  独立版构建第 2 步（CI 的 windows-latest，PowerShell 7）：把全部组件放进一个文件夹，供 Inno Setup 打成一个离线安装包。
  所有第三方组件都按 installer/standalone/versions.json 固定版本、核对 SHA-256（或 npm integrity / PyPI 哈希）。
  用户电脑上安装时不联网下载任何东西（用户决定 2026-10-28：方便优先，安装不能依赖 GitHub / Docker / npm）。

.PARAMETER Stage   输出文件夹（会被清空），里面的 app\ 就是安装后的程序文件夹。
.PARAMETER LobeDir prepare-lobe.sh 的输出（含 lobe.tar.gz 和 lobe.tar.gz.sha256）。
.NOTES 需要先在 VS 开发者环境里运行（编译 pgvector 用 nmake/cl），CI 里用 ilammy/msvc-dev-cmd。
       本文件保存为 UTF-8 带 BOM。不输出任何密钥（构建过程本来就不接触密钥）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Stage,
    [Parameter(Mandatory)][string]$LobeDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3.0

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$v = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\versions.json') | ConvertFrom-Json
$dl = Join-Path $env:RUNNER_TEMP 'aroomo-dl'
if (-not $env:RUNNER_TEMP) { $dl = Join-Path ([IO.Path]::GetTempPath()) 'aroomo-dl' }
New-Item -ItemType Directory -Path $dl -Force | Out-Null
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
$app = Join-Path $Stage 'app'
New-Item -ItemType Directory -Path $app -Force | Out-Null
$bom = [ordered]@{}

function Step([string]$m) { Write-Host "== $m" }

function Get-Verified([string]$Url, [string]$Sha256, [string]$Name) {
    $f = Join-Path $dl $Name
    if (-not (Test-Path $f) -or (Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant() -ne $Sha256) {
        for ($i = 1; $i -le 3; $i++) {
            try { Invoke-WebRequest -Uri $Url -OutFile $f -UseBasicParsing; break } catch { if ($i -eq 3) { throw }; Start-Sleep -Seconds (5 * $i) }
        }
    }
    $h = (Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant()
    if ($h -ne $Sha256) { throw "校验失败：$Url（得到 $h，应为 $Sha256）" }
    return $f
}

function Expand-Into([string]$Zip, [string]$Dest) {
    $tmp = Join-Path $dl ("x-" + [Guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $Zip -DestinationPath $tmp
    $items = @(Get-ChildItem -LiteralPath $tmp)
    # zip 里只有一个顶层文件夹时去掉这一层
    $src = if ($items.Count -eq 1 -and $items[0].PSIsContainer) { $items[0].FullName } else { $tmp }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Get-ChildItem -LiteralPath $src -Force | Move-Item -Destination $Dest
    Remove-Item -Recurse -Force $tmp
}

# ---------------------------------------------------------------------------
Step '1/9 Node.js（Core、LobeHub、Shell 共用）'
$z = Get-Verified $v.node.url $v.node.sha256 'node.zip'
Expand-Into $z (Join-Path $app 'node')
$bom.node = $v.node.version
$node = Join-Path $app 'node\node.exe'
$npm = Join-Path $app 'node\npm.cmd'

# ---------------------------------------------------------------------------
Step '2/9 PostgreSQL（EDB 官方 Windows 免安装包）+ 自己编译 pgvector'
$z = Get-Verified $v.postgresql.url $v.postgresql.sha256 'pgsql.zip'
$pg = Join-Path $app 'pgsql'
Expand-Into $z $pg
$pgvSrc = Join-Path $dl 'pgvector'
if (Test-Path $pgvSrc) { Remove-Item -Recurse -Force $pgvSrc }
git clone --quiet --depth 1 --branch $v.pgvector.version $v.pgvector.repo $pgvSrc
$head = (git -C $pgvSrc rev-parse HEAD).Trim()
if ($head -ne $v.pgvector.commit) { throw "pgvector 提交不对：$head" }
Push-Location $pgvSrc
try {
    $env:PGROOT = $pg
    & nmake /nologo /F Makefile.win
    if ($LASTEXITCODE -ne 0) { throw 'pgvector 编译失败' }
    & nmake /nologo /F Makefile.win install
    if ($LASTEXITCODE -ne 0) { throw 'pgvector 安装失败' }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $pg 'lib\vector.dll'))) { throw '没有生成 vector.dll' }
Copy-Item (Join-Path $pgvSrc 'LICENSE') (Join-Path $pg 'pgvector-LICENSE.txt')
# 不需要的部分（图形管理工具、文档、调试符号、头文件）
foreach ($d in 'pgAdmin 4', 'StackBuilder', 'doc', 'symbols', 'include') {
    $p = Join-Path $pg $d
    if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
Get-ChildItem (Join-Path $pg 'lib') -Filter *.lib -ErrorAction SilentlyContinue | Remove-Item -Force
$bom.postgresql = $v.postgresql.version
$bom.pgvector = "$($v.pgvector.version) ($head，本项目 CI 用 MSVC 编译)"

# ---------------------------------------------------------------------------
Step '3/9 Redis、RustFS、rclone、age'
Expand-Into (Get-Verified $v.redis.url $v.redis.sha256 'redis.zip') (Join-Path $app 'redis')
Expand-Into (Get-Verified $v.rustfs.url $v.rustfs.sha256 'rustfs.zip') (Join-Path $app 'rustfs')
Expand-Into (Get-Verified $v.rclone.url $v.rclone.sha256 'rclone.zip') (Join-Path $app 'rclone')
$ageDir = Join-Path $app 'installer\windows\bin'
Expand-Into (Get-Verified $v.age.url $v.age.sha256 'age.zip') $ageDir
if (Test-Path (Join-Path $ageDir 'LICENSE')) { Move-Item (Join-Path $ageDir 'LICENSE') (Join-Path $ageDir 'age-LICENSE.txt') -Force }
foreach ($f in 'redis\redis-server.exe', 'redis\redis-cli.exe', 'rustfs\rustfs.exe', 'rclone\rclone.exe', 'installer\windows\bin\age.exe', 'installer\windows\bin\age-keygen.exe') {
    if (-not (Test-Path (Join-Path $app $f))) { throw "缺少 $f" }
}
Get-ChildItem (Join-Path $app 'rclone') -Filter *.html -ErrorAction SilentlyContinue | Remove-Item -Force
# 完整档运行时（离线自带）：Chromium（网页代办、Karakeep 抓网页）、Meilisearch（Karakeep 全文搜索）
Expand-Into (Get-Verified $v.chromium.url $v.chromium.sha256 'chrome.zip') (Join-Path $app 'chromium')
if (-not (Test-Path (Join-Path $app 'chromium\chrome.exe'))) { throw '缺少 chromium\chrome.exe' }
New-Item -ItemType Directory -Path (Join-Path $app 'meilisearch') -Force | Out-Null
Copy-Item (Get-Verified $v.meilisearch.url $v.meilisearch.sha256 'meilisearch.exe') (Join-Path $app 'meilisearch\meilisearch.exe')
$bom.chromium = $v.chromium.version; $bom.meilisearch = $v.meilisearch.version
# zstd：备份与服务器同一格式（tar.zst.age，D79）
$zx = Join-Path $dl 'zstd-x'
Expand-Into (Get-Verified $v.zstd.url $v.zstd.sha256 'zstd.zip') $zx
New-Item -ItemType Directory -Path (Join-Path $app 'zstd') -Force | Out-Null
Copy-Item (Join-Path $zx 'zstd.exe') (Join-Path $app 'zstd\zstd.exe')
Remove-Item -Recurse -Force $zx
$bom.zstd = $v.zstd.version
$bom.redis = "$($v.redis.version)（社区 Windows 构建）"; $bom.rustfs = $v.rustfs.version; $bom.rclone = $v.rclone.version; $bom.age = $v.age.version

# ---------------------------------------------------------------------------
Step '4/9 Python（python-build-standalone，D77-3）+ LiteLLM（与服务器版同一版本）'
$py = Join-Path $app 'python'
$pyTgz = Get-Verified $v.python.url $v.python.sha256 'python.tar.gz'
$pyTmp = Join-Path $dl 'py-x'
if (Test-Path $pyTmp) { Remove-Item -Recurse -Force $pyTmp }
New-Item -ItemType Directory -Path $pyTmp | Out-Null
tar -xzf $pyTgz -C $pyTmp
if ($LASTEXITCODE -ne 0) { throw '解开 Python 失败' }
Move-Item (Join-Path $pyTmp 'python') $py
$pyexe = Join-Path $py 'python.exe'
$site = Join-Path $py 'Lib\site-packages'
$scripts = Join-Path $py 'Scripts'
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PYTHONUTF8 = '1'
& $pyexe -m pip install --no-warn-script-location --no-compile $v.litellm.pip $v.litellm.prisma_python
if ($LASTEXITCODE -ne 0) { throw 'pip 安装 LiteLLM 失败' }
$ver = (& $pyexe -c 'import importlib.metadata as m; print(m.version("litellm"))').Trim()
if ($ver -ne $v.litellm.version) { throw "LiteLLM 版本不对：$ver" }
$freeze = & $pyexe -m pip list --format=freeze
Set-Content -LiteralPath (Join-Path $py 'aroomo-python-packages.txt') -Value $freeze -Encoding utf8
$bom.python = $v.python.version; $bom.litellm = $v.litellm.version

Step '5/9 Prisma（LiteLLM 存 Key 的数据库层）：CLI 和引擎放进安装包，运行时不联网'
$cache = Join-Path $app 'litellm\prisma-cache'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
$env:PRISMA_BINARY_CACHE_DIR = $cache
$env:PRISMA_USE_GLOBAL_NODE = '1'
$env:PRISMA_USE_NODEJS_BIN = '0'
$env:PRISMA_HIDE_UPDATE_MESSAGE = '1'
$env:CHECKPOINT_DISABLE = '1'
$env:PATH = (Join-Path $app 'node') + ';' + $env:PATH
$schemaSrc = Join-Path $site 'litellm\proxy\schema.prisma'
if (-not (Test-Path $schemaSrc)) { throw "找不到 $schemaSrc" }
# 只要 Windows（native）引擎，不下载 Linux 引擎
$schema = Join-Path $dl 'schema.prisma'
(Get-Content -Raw $schemaSrc) -replace 'binaryTargets\s*=\s*\[[^\]]*\]', 'binaryTargets = ["native"]' | Set-Content -LiteralPath $schema -Encoding utf8NoBOM
$env:PATH = $scripts + ';' + $env:PATH   # 构建时 prisma 需要 prisma-client-py 命令
& $pyexe -m prisma generate --schema $schema
if ($LASTEXITCODE -ne 0) { throw 'prisma generate 失败' }
& $pyexe -m prisma version
$qe = @(Get-ChildItem -Recurse -File $cache, (Join-Path $site 'prisma') -Include 'query-engine*.exe', 'prisma-query-engine*.exe' -ErrorAction SilentlyContinue)
$se = @(Get-ChildItem -Recurse -File $cache -Include 'schema-engine*.exe' -ErrorAction SilentlyContinue)
Write-Host ("查询引擎：{0}" -f (($qe | ForEach-Object FullName) -join ', '))
Write-Host ("结构引擎：{0}" -f (($se | ForEach-Object FullName) -join ', '))
if ($qe.Count -eq 0 -or $se.Count -eq 0) { throw '没有找到 Prisma 的 Windows 引擎' }
# 记录相对路径，启动脚本据此设置 PRISMA_QUERY_ENGINE_BINARY / PRISMA_SCHEMA_ENGINE_BINARY
$rel = { param($p) $p.Substring($app.Length + 1) }
[ordered]@{ query_engine = (& $rel $qe[0].FullName); schema_engine = (& $rel $se[0].FullName) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'litellm\prisma-engines.json') -Encoding utf8
Copy-Item (Join-Path $repo 'deploy\litellm\config.yaml') (Join-Path $app 'litellm\config.yaml')
# pip 生成的 bin\*.exe 里写死了构建机的路径，装到别处就坏了；LiteLLM 找不到 prisma 命令时会改用 python -m prisma
if (Test-Path $scripts) { Remove-Item -Recurse -Force $scripts }
# 瘦身（D77-3）：pip 只在构建时用；去掉测试、文档、缓存；LiteLLM 企业版目录保留（proxy 启动时会 import，删掉会报错）
& $pyexe -m pip uninstall -y pip setuptools wheel *> $null
foreach ($pat in 'tests', 'test', '__pycache__', 'docs') {
    Get-ChildItem -LiteralPath $site -Recurse -Directory -Filter $pat -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\\litellm\\proxy\\' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($d in 'Lib\test', 'Lib\idlelib', 'Lib\tkinter', 'Lib\turtledemo', 'tcl', 'Lib\ensurepip') {
    $p = Join-Path $py $d; if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
# 预编译 .pyc（D77-3：冷启动快）；编译失败的个别文件不影响运行
& $pyexe -m compileall -q -j 0 $py *> $null

# ---------------------------------------------------------------------------
Step '6/9 Aroomo Core'
$coreOut = Join-Path $app 'core'
Push-Location (Join-Path $repo 'core')
try {
    & $npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Core 构建失败' }
} finally { Pop-Location }
New-Item -ItemType Directory -Path $coreOut -Force | Out-Null
foreach ($d in 'dist', 'migrations') { Copy-Item -Recurse (Join-Path $repo "core\$d") (Join-Path $coreOut $d) }
Copy-Item (Join-Path $repo 'core\package.json'), (Join-Path $repo 'core\package-lock.json') $coreOut
Push-Location $coreOut
try {
    & $npm ci --omit=dev --no-audit --no-fund --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Core 运行依赖安装失败' }
} finally { Pop-Location }

# Aroomo Shell（薄定制层，D69/D76）：仓库里有 shell/ 时一起打包；没有时直接打开 LobeHub
$shellSrc = Join-Path $repo 'shell'
if (Test-Path (Join-Path $shellSrc 'package.json')) {
    Step '6b/9 Aroomo Shell'
    Push-Location $shellSrc
    try {
        & $npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Shell npm ci 失败' }
        & $npm run build
        if ($LASTEXITCODE -ne 0) { throw 'Shell 构建失败' }
    } finally { Pop-Location }
    $shellOut = Join-Path $app 'shell'
    New-Item -ItemType Directory -Path $shellOut -Force | Out-Null
    foreach ($d in 'dist', 'public') { if (Test-Path (Join-Path $shellSrc $d)) { Copy-Item -Recurse (Join-Path $shellSrc $d) (Join-Path $shellOut $d) } }
    Copy-Item (Join-Path $shellSrc 'package.json') $shellOut
    $bom.shell = 'included'
} else {
    $bom.shell = 'not in this build'
}

# ---------------------------------------------------------------------------
Step '7/9 LobeHub（官方镜像里的程序，prepare-lobe.sh 已换好 Windows 版 sharp/ffmpeg）'
$sha = (Get-Content -Raw (Join-Path $LobeDir 'lobe.tar.gz.sha256')).Trim()
$h = (Get-FileHash -Algorithm SHA256 (Join-Path $LobeDir 'lobe.tar.gz')).Hash.ToLowerInvariant()
if ($h -ne $sha) { throw 'lobe.tar.gz 校验失败' }
Copy-Item (Join-Path $LobeDir 'lobe.tar.gz'), (Join-Path $LobeDir 'lobe.tar.gz.sha256') $app
$bom.lobehub = $v.lobehub.version
# 完整档模块（prepare-apps.sh 的输出，和 lobe.tar.gz 放在同一个文件夹）：收藏 Karakeep、RSSHub
foreach ($m in 'karakeep', 'rsshub') {
    $f = Join-Path $LobeDir "$m.tar.gz"
    if (-not (Test-Path $f)) { Write-Host "（这个版本不带 $m）"; continue }
    $msha = (Get-Content -Raw "$f.sha256").Trim()
    if ((Get-FileHash -Algorithm SHA256 $f).Hash.ToLowerInvariant() -ne $msha) { throw "$m.tar.gz 校验失败" }
    Copy-Item $f, "$f.sha256" $app
}
if (Test-Path (Join-Path $LobeDir 'karakeep.tar.gz')) { $bom.karakeep = $v.karakeep.version }
if (Test-Path (Join-Path $LobeDir 'rsshub.tar.gz')) { $bom.rsshub = $v.rsshub.revision }

# ---------------------------------------------------------------------------
Step '8/9 Aroomo 启动器、托盘、安装脚本、许可证'
$inst = Join-Path $app 'installer'
New-Item -ItemType Directory -Path (Join-Path $inst 'windows'), (Join-Path $inst 'standalone\runtime') -Force | Out-Null
Copy-Item (Join-Path $repo 'installer\windows\Aroomo.psm1') (Join-Path $inst 'windows')
Copy-Item (Join-Path $repo 'installer\standalone\*.psm1'), (Join-Path $repo 'installer\standalone\*.ps1'), (Join-Path $repo 'installer\standalone\aroomo-launch.vbs'), (Join-Path $repo 'installer\standalone\standalone.env.example') (Join-Path $inst 'standalone')
Copy-Item (Join-Path $repo 'installer\standalone\runtime\*') (Join-Path $inst 'standalone\runtime')
Copy-Item (Join-Path $repo 'installer\standalone\aroomo.ico') $app -ErrorAction SilentlyContinue
$lic = Join-Path $app 'licenses'
New-Item -ItemType Directory -Path $lic -Force | Out-Null
Copy-Item (Join-Path $repo 'installer\standalone\NOTICE.txt') $lic
Copy-Item (Join-Path $LobeDir 'LICENSE-LobeHub.txt') (Join-Path $lic 'LobeHub-LICENSE.txt')
foreach ($n in 'Karakeep', 'RSSHub') { $f = Join-Path $LobeDir "LICENSE-$n.txt"; if (Test-Path $f) { Copy-Item $f (Join-Path $lic "$n-LICENSE.txt") } }
if (Test-Path (Join-Path $app 'node\LICENSE')) { Copy-Item (Join-Path $app 'node\LICENSE') (Join-Path $lic 'nodejs-LICENSE.txt') }
$litLic = Get-ChildItem $site -Directory -Filter 'litellm-*.dist-info' | Select-Object -First 1
if ($litLic) { Get-ChildItem $litLic.FullName -Recurse -Filter LICENSE* | Select-Object -First 1 | Copy-Item -Destination (Join-Path $lic 'litellm-LICENSE.txt') }
$bom.built_at = (Get-Date).ToUniversalTime().ToString('o')
$bom.commit = $env:GITHUB_SHA
$bom | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'aroomo-components.json') -Encoding utf8

# ---------------------------------------------------------------------------
Step '9/9 体积'
$size = (Get-ChildItem -Recurse -File $app | Measure-Object Length -Sum).Sum
foreach ($d in Get-ChildItem $app -Directory) {
    $s = (Get-ChildItem -Recurse -File $d.FullName | Measure-Object Length -Sum).Sum
    Write-Host ("{0,-12} {1,8:N0} MB" -f $d.Name, ($s / 1MB))
}
Write-Host ("合计（未解开 LobeHub）{0:N0} MB" -f ($size / 1MB))
Set-Content -LiteralPath (Join-Path $Stage 'staged-bytes.txt') -Value $size
