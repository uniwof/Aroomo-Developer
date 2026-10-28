# Aroomo 独立版（不需要 Docker / WSL）：安装器与启停脚本共用的函数。DECISIONS D66。
# 和 Docker 版是同一套程序（LobeHub、LiteLLM、PostgreSQL 17 + pgvector、Redis、RustFS、Core、Shell），只是作为本机进程运行；
# 一个 PostgreSQL 实例里分库（lobechat / litellm / aroomo_core），一个 Node 运行时（D77-3）。设计见 docs/architecture/STANDALONE.md。
# 目标运行环境：Windows PowerShell 5.1。也能在 PowerShell 7 上跑（测试用）。
# 注意：本文件必须保存为「UTF-8 带 BOM」。原则：任何函数都不在屏幕或日志里输出密钥。

Set-StrictMode -Version 2.0

$script:MinBuild = 17763   # Windows 10 1809
$script:RegPath = 'HKCU:\Software\Aroomo\Standalone'
# 备份格式和服务器一致（D79）：format 2 = tar + zstd + age，文件名 aroomo-<标签>-<UTC 时间>.tar.zst.age（scripts/lib/backup-common.sh）。
# 早期测试版的 standalone-1（.tar.gz.age）仍然能恢复，保留策略也照常清理
$script:BackupRegex = '^aroomo-(?<tag>[a-z0-9-]+)-(?<stamp>\d{8}T\d{6}Z)\.tar\.(zst|gz)\.age$'
$script:BackupFormat = 2

# ---------------------------------------------------------------------------
# 版本、路径
# ---------------------------------------------------------------------------
function Test-AroomoSAWindowsBuild {
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][int]$Build)
    if ($Build -lt $script:MinBuild) {
        return [pscustomobject]@{ Ok = $false; Message = "这台电脑的 Windows 版本太旧（内部版本 $Build）。独立版需要 Windows 10 1809 或更新。请在「设置 → Windows 更新」里更新。" }
    }
    return [pscustomobject]@{ Ok = $true; Message = "Windows 版本可以（内部版本 $Build）。" }
}

function Test-AroomoSANonAscii {
    # 路径里有中文等非 ASCII 字符时返回 $true（PostgreSQL 在这种路径下容易出问题）
    [OutputType([bool])]
    param([string]$Path)
    if (-not $Path) { return $false }
    foreach ($ch in $Path.ToCharArray()) { if ([int]$ch -gt 127) { return $true } }
    return $false
}

function Get-AroomoSADefaultDataDir {
    # 优先：非系统盘、剩余 ≥ 20 GB、空间最大；否则用户目录；用户目录有中文时退到系统盘根目录
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [object[]]$Drives = $null,
        [string]$UserProfile = $env:USERPROFILE,
        [string]$SystemDrive = $env:SystemDrive
    )
    if ($null -eq $Drives) {
        $Drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
                [pscustomobject]@{ Name = $_.DeviceID; FreeGB = [int]($_.FreeSpace / 1GB); IsSystem = ($_.DeviceID -eq $SystemDrive) }
            })
    }
    $best = $Drives | Where-Object { -not $_.IsSystem -and $_.FreeGB -ge 20 } | Sort-Object -Property FreeGB -Descending | Select-Object -First 1
    if ($best) { return "$($best.Name)\AroomoStandalone" }
    if (Test-AroomoSANonAscii $UserProfile) { return "$SystemDrive\AroomoStandalone" }
    return [IO.Path]::Combine($UserProfile, 'AroomoStandalone')
}

function Get-AroomoSAPaths {
    # 程序文件夹和数据文件夹里每样东西的位置（只计算，不访问磁盘）
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$AppDir, [Parameter(Mandatory)][string]$DataDir)
    $c = { param($a, $b) [IO.Path]::Combine($a, $b) }
    return @{
        AppDir      = $AppDir
        DataDir     = $DataDir
        Node        = (& $c $AppDir 'node\node.exe')
        NodeDir     = (& $c $AppDir 'node')
        Python      = (& $c $AppDir 'python\python.exe')
        PythonDir   = (& $c $AppDir 'python')
        LiteLLMDir  = (& $c $AppDir 'litellm')
        ShellDir    = (& $c $AppDir 'shell')
        PgBin       = (& $c $AppDir 'pgsql\bin')
        Redis       = (& $c $AppDir 'redis\redis-server.exe')
        RedisCli    = (& $c $AppDir 'redis\redis-cli.exe')
        RustFS      = (& $c $AppDir 'rustfs\rustfs.exe')
        Rclone      = (& $c $AppDir 'rclone\rclone.exe')
        Age         = (& $c $AppDir 'installer\windows\bin\age.exe')
        Zstd        = (& $c $AppDir 'zstd\zstd.exe')
        CoreDir     = (& $c $AppDir 'core')
        LobeDir     = (& $c $AppDir 'lobe')
        LobeArchive = (& $c $AppDir 'lobe.tar.gz')
        LobeSha     = (& $c $AppDir 'lobe.tar.gz.sha256')
        Meili       = (& $c $AppDir 'meilisearch\meilisearch.exe')
        Chrome      = (& $c $AppDir 'chromium\chrome.exe')
        KarakeepDir = (& $c $AppDir 'karakeep')
        RsshubDir   = (& $c $AppDir 'rsshub')
        MeiliData   = (& $c $DataDir 'meilisearch')
        KarakeepData = (& $c $DataDir 'karakeep')
        BrowserProfile = (& $c $DataDir 'browser-profile')
        Runtime     = (& $c $AppDir 'installer\standalone\runtime')
        Config      = (& $c $DataDir 'config')
        EnvFile     = (& $c $DataDir 'config\aroomo.env')
        RedisConf   = (& $c $DataDir 'config\redis.conf')
        PgData      = (& $c $DataDir 'pgdata')
        RedisData   = (& $c $DataDir 'redis')
        RustFSData  = (& $c $DataDir 'rustfs')
        Logs        = (& $c $DataDir 'logs')
        Run         = (& $c $DataDir 'run')
        Backups     = (& $c $DataDir 'backups')
    }
}

function Get-AroomoSAInstallInfo {
    [OutputType([hashtable])]
    param()
    $h = @{ AppDir = $null; DataDir = $null }
    if (Test-Path $script:RegPath) {
        $p = Get-ItemProperty -Path $script:RegPath -ErrorAction SilentlyContinue
        if ($p) {
            if ($p.PSObject.Properties['AppDir']) { $h.AppDir = $p.AppDir }
            if ($p.PSObject.Properties['DataDir']) { $h.DataDir = $p.DataDir }
        }
    }
    return $h
}

function Set-AroomoSAInstallInfo {
    param([Parameter(Mandatory)][string]$AppDir, [Parameter(Mandatory)][string]$DataDir)
    if (-not (Test-Path $script:RegPath)) { New-Item -Path $script:RegPath -Force | Out-Null }
    Set-ItemProperty -Path $script:RegPath -Name AppDir -Value $AppDir
    Set-ItemProperty -Path $script:RegPath -Name DataDir -Value $DataDir
}

function Remove-AroomoSAInstallInfo {
    param()
    if (Test-Path $script:RegPath) { Remove-Item -Path $script:RegPath -Recurse -Force }
}

# ---------------------------------------------------------------------------
# 配置（aroomo.env）
# ---------------------------------------------------------------------------
function Get-AroomoSAPortDefaults {
    [OutputType([System.Collections.Specialized.OrderedDictionary])]
    param()
    # 和 Docker 版（3210、9000…）错开，两个版本可以同时装在一台电脑上
    # 完整档模块：Meilisearch 7780、无界面浏览器 9282、收藏 Karakeep 3283（后台任务 3284）、RSSHub 1280
    return [ordered]@{ SHELL_PORT = 3280; LOBE_PORT = 3281; RUSTFS_PORT = 9280; PG_PORT = 54329; REDIS_PORT = 63799; LITELLM_PORT = 40280; CORE_PORT = 38280
        MEILI_PORT = 7780; BROWSER_PORT = 9282; KARAKEEP_PORT = 3283; KARAKEEP_WORKERS_PORT = 3284; RSSHUB_PORT = 1280 }
}

function New-AroomoSABase64Secret {
    [OutputType([string])]
    param([ValidateSet(16, 24, 32)][int]$Bytes = 32)
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buf)
}

function Get-AroomoSAInitialValues {
    # 第一次安装时写进 aroomo.env 的非随机值（端口由调用方找好空闲的传进来）
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][hashtable]$Ports,
        [string]$HostName = $env:COMPUTERNAME,
        [string]$Jwks = ''
    )
    $v = @{}
    foreach ($k in $Ports.Keys) { $v[$k] = [string]$Ports[$k] }
    $v['S3_ENDPOINT'] = "http://localhost:$($Ports['RUSTFS_PORT'])"
    $v['BACKUP_S3_PREFIX'] = (Get-AroomoPcBackupPrefix -HostName $HostName)
    if ($Jwks) { $v['JWKS_KEY'] = $Jwks }
    # LobeHub 的 KEY_VAULTS_SECRET 必须是 base64 编码的 32 字节（不能用十六进制随机串，2026-10-28 CI：「got 48 bytes」）
    $v['KEY_VAULTS_SECRET'] = New-AroomoSABase64Secret
    return $v
}

function Get-AroomoSAEnvProblems {
    # 检查配置是否完整（返回问题列表，不含任何值）
    [OutputType([string[]])]
    param([Parameter(Mandatory)][hashtable]$Config)
    $need = @('PG_PORT', 'POSTGRES_PASSWORD', 'CORE_DB_PASSWORD', 'LITELLM_DB_PASSWORD', 'REDIS_PORT', 'REDIS_PASSWORD', 'RUSTFS_PORT',
        'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'LOBE_PORT', 'SHELL_PORT', 'KEY_VAULTS_SECRET', 'AUTH_SECRET', 'LITELLM_PORT',
        'LITELLM_MASTER_KEY', 'LITELLM_SALT_KEY', 'LOBE_LITELLM_VIRTUAL_KEY', 'CORE_PORT', 'CORE_OWNER_TOKEN')
    $problems = New-Object System.Collections.Generic.List[string]
    foreach ($k in $need) {
        if (-not $Config.ContainsKey($k) -or -not $Config[$k] -or $Config[$k] -match 'CHANGE_ME') { $problems.Add("缺少 $k") }
    }
    foreach ($k in @('POSTGRES_PASSWORD', 'CORE_DB_PASSWORD', 'LITELLM_DB_PASSWORD', 'REDIS_PASSWORD')) {
        if ($Config.ContainsKey($k) -and $Config[$k] -and $Config[$k] -notmatch '^[A-Za-z0-9]+$') { $problems.Add("$k 只能是字母和数字") }
    }
    foreach ($k in (Get-AroomoSAPortDefaults).Keys) {
        if ($Config.ContainsKey($k) -and $Config[$k] -and ($Config[$k] -notmatch '^\d+$' -or [int]$Config[$k] -lt 1 -or [int]$Config[$k] -gt 65535)) { $problems.Add("$k 不是合法端口") }
    }
    foreach ($line in $Config.Values) {
        if ([string]$line -cmatch 'AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{50,}') { $problems.Add('配置里出现了主密钥（AGE-SECRET-KEY-1…），必须删掉') ; break }
    }
    return $problems.ToArray()
}

# ---------------------------------------------------------------------------
# 服务定义（和 deploy/docker-compose.yml 一一对应）
# ---------------------------------------------------------------------------
function ConvertTo-AroomoSAForwardSlash {
    param([Parameter(Mandatory)][string]$Path)
    return ($Path -replace '\\', '/')
}

function Get-AroomoSAPgConf {
    # 追加到 postgresql.conf 的设置：只听 127.0.0.1、指定端口、日志不含语句内容
    [OutputType([string])]
    param([Parameter(Mandatory)][int]$Port)
    return @"

# ---- Aroomo 独立版（D66）----
listen_addresses = '127.0.0.1'
port = $Port
max_connections = 100
shared_buffers = 128MB
logging_collector = off
log_statement = 'none'
log_min_duration_statement = -1
timezone = 'Asia/Shanghai'
"@
}

function Get-AroomoSARedisConf {
    # 与 Docker 版 redis 一致：60 秒内 1000 次修改存盘、开启 AOF；另加密码，只听 127.0.0.1
    [OutputType([string])]
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$DataDir, [Parameter(Mandatory)][string]$Secret)
    # redis-windows 是 MSYS2 编译的：D:/… 这种 Windows 路径会被当成相对路径（2026-10-28 CI：
    # "/app/redis/D:/a/…/redis.conf"）。所以 Redis 以 <数据文件夹>\config 为工作目录启动，配置和数据目录都用相对路径。
    $dir = '../' + (Split-Path -Leaf $DataDir)
    return @"
# Aroomo 独立版 Redis 配置（安装程序生成；含密码，只有当前用户能读）
bind 127.0.0.1
protected-mode yes
port $Port
dir "$dir"
save 60 1000
appendonly yes
requirepass $Secret
"@
}

function Test-AroomoSAShell {
    # 这个版本带不带 Aroomo Shell（薄定制层）；带的话用户打开的是 Shell 的端口
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Paths)
    return (Test-Path -LiteralPath ([IO.Path]::Combine($Paths.ShellDir, 'dist', 'index.js')))
}

function Get-AroomoSAPublicUrl {
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Paths, [Parameter(Mandatory)][hashtable]$Config)
    $port = if (Test-AroomoSAShell -Paths $Paths) { $Config['SHELL_PORT'] } else { $Config['LOBE_PORT'] }
    return "http://localhost:$port"
}

function Get-AroomoSAPrismaEnv {
    # LiteLLM 用 Prisma 访问数据库：CLI 和引擎都在安装包里，不联网（构建时记录在 litellm\prisma-engines.json）
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable]$Paths)
    $e = @{
        PRISMA_BINARY_CACHE_DIR = [IO.Path]::Combine($Paths.LiteLLMDir, 'prisma-cache')
        PRISMA_USE_GLOBAL_NODE = '1'; PRISMA_USE_NODEJS_BIN = '0'; PRISMA_HIDE_UPDATE_MESSAGE = '1'; CHECKPOINT_DISABLE = '1'
        PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING = '1'
    }
    $f = [IO.Path]::Combine($Paths.LiteLLMDir, 'prisma-engines.json')
    if (Test-Path -LiteralPath $f) {
        $j = Get-Content -Raw -LiteralPath $f | ConvertFrom-Json
        $e['PRISMA_QUERY_ENGINE_BINARY'] = [IO.Path]::Combine($Paths.AppDir, $j.query_engine)
        $e['PRISMA_SCHEMA_ENGINE_BINARY'] = [IO.Path]::Combine($Paths.AppDir, $j.schema_engine)
    }
    return $e
}

function Get-AroomoSAModuleSpecs {
    # 完整档模块（所有者 2026-10-28：全部功能离线可用）。都只听 127.0.0.1；没带的模块不出现
    [OutputType([object[]])]
    param([Parameter(Mandatory)][hashtable]$Paths, [Parameter(Mandatory)][hashtable]$Config, [string]$LiteLLMUrl, [string]$Tz, [string]$SysPath)
    $c = $Config
    $out = @()
    $hasKarakeep = (Test-AroomoSAModule -Paths $Paths -Name 'karakeep') -and $c['MEILI_MASTER_KEY'] -and $c['KARAKEEP_PORT']
    $hasRsshub = (Test-AroomoSAModule -Paths $Paths -Name 'rsshub') -and $c['RSSHUB_PORT']
    $browserUrl = "http://127.0.0.1:$($c['BROWSER_PORT'])"
    if ($hasKarakeep -and (Test-Path -LiteralPath $Paths.Meili)) {
        $out += [pscustomobject]@{
            Name = 'meilisearch'; Label = '全文搜索（Meilisearch）'; Kind = 'process'; Port = [int]$c['MEILI_PORT']; TimeoutSec = 90
            Exe = $Paths.Meili
            Arguments = @('--http-addr', "127.0.0.1:$($c['MEILI_PORT'])", '--db-path', $Paths.MeiliData, '--dump-dir', ([IO.Path]::Combine($Paths.MeiliData, 'dumps')),
                '--env', 'production', '--no-analytics')
            # 主密钥走环境变量，不出现在命令行（别的程序能看到命令行）
            WorkingDir = $Paths.DataDir; Env = @{ MEILI_MASTER_KEY = $c['MEILI_MASTER_KEY'] }; Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['MEILI_PORT'])/health"
        }
    }
    if (($hasKarakeep -or $hasRsshub) -and (Test-Path -LiteralPath $Paths.Chrome) -and $c['BROWSER_PORT']) {
        # 无界面浏览器（Karakeep 抓网页、截图）：随包的 Chromium，只开本机调试端口，单独的配置文件夹
        $out += [pscustomobject]@{
            Name = 'browser'; Label = '网页抓取浏览器（Chromium）'; Kind = 'process'; Port = [int]$c['BROWSER_PORT']; TimeoutSec = 60
            Exe = $Paths.Chrome
            Arguments = @('--headless=new', "--remote-debugging-port=$($c['BROWSER_PORT'])", '--remote-debugging-address=127.0.0.1', "--user-data-dir=$($Paths.BrowserProfile)",
                '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-sync', '--disable-component-update', '--disable-background-networking',
                '--metrics-recording-only', '--mute-audio', '--hide-scrollbars', 'about:blank')
            WorkingDir = $Paths.DataDir; Env = @{}; Health = 'http'; HealthUrl = "$browserUrl/json/version"
        }
    }
    if ($hasKarakeep) {
        $kEnv = @{
            NODE_ENV = 'production'; NODE_OPTIONS = ''; TZ = $Tz; PATH = "$($Paths.NodeDir);$SysPath"
            KARAKEEP_DIR = $Paths.KarakeepDir; DATA_DIR = $Paths.KarakeepData
            PORT = $c['KARAKEEP_PORT']; HOSTNAME = '127.0.0.1'
            NEXTAUTH_URL = "http://localhost:$($c['KARAKEEP_PORT'])"; NEXTAUTH_URL_INTERNAL = "http://127.0.0.1:$($c['KARAKEEP_PORT'])"
            NEXTAUTH_SECRET = $c['KARAKEEP_NEXTAUTH_SECRET']; NEXT_TELEMETRY_DISABLED = '1'; DISABLE_NEW_RELEASE_CHECK = 'true'
            MEILI_ADDR = "http://127.0.0.1:$($c['MEILI_PORT'])"; MEILI_MASTER_KEY = $c['MEILI_MASTER_KEY']
            BROWSER_WEB_URL = $browserUrl
            # 抓网页本身要联网；广告过滤规则要从网上下载，离线启动时关掉；视频下载需要 yt-dlp（没带）
            CRAWLER_ENABLE_ADBLOCKER = 'false'; CRAWLER_VIDEO_DOWNLOAD = 'false'
            OCR_CACHE_DIR = [IO.Path]::Combine($Paths.KarakeepDir, 'tessdata'); OCR_LANGS = 'eng,chi_sim'
            # AI 打标签 / 摘要：走本机 LiteLLM（与 LobeHub 同一个只能调模型的虚拟 Key）
            OPENAI_BASE_URL = "$LiteLLMUrl/v1"; OPENAI_API_KEY = $c['LOBE_LITELLM_VIRTUAL_KEY']
            WORKERS_HOST = '127.0.0.1'; WORKERS_PORT = $c['KARAKEEP_WORKERS_PORT']
        }
        $out += [pscustomobject]@{
            Name = 'karakeep'; Label = '收藏（Karakeep）'; Kind = 'process'; Port = [int]$c['KARAKEEP_PORT']; TimeoutSec = 300
            Exe = $Paths.Node; Arguments = @(([IO.Path]::Combine($Paths.Runtime, 'karakeep-start.cjs')), 'web')
            WorkingDir = [IO.Path]::Combine($Paths.KarakeepDir, 'apps', 'web'); Env = $kEnv
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['KARAKEEP_PORT'])/api/health"
        }
        $out += [pscustomobject]@{
            Name = 'karakeep-workers'; Label = '收藏后台任务（抓取、搜索索引、OCR）'; Kind = 'process'; Port = [int]$c['KARAKEEP_WORKERS_PORT']; TimeoutSec = 180
            Exe = $Paths.Node; Arguments = @(([IO.Path]::Combine($Paths.Runtime, 'karakeep-start.cjs')), 'workers')
            WorkingDir = [IO.Path]::Combine($Paths.KarakeepDir, 'apps', 'workers'); Env = $kEnv
            Health = 'tcp'; HealthUrl = $null
        }
    }
    if ($hasRsshub) {
        $out += [pscustomobject]@{
            Name = 'rsshub'; Label = '订阅源（RSSHub）'; Kind = 'process'; Port = [int]$c['RSSHUB_PORT']; TimeoutSec = 240
            Exe = $Paths.Node; Arguments = @('--max-http-header-size=32768', ([IO.Path]::Combine($Paths.RsshubDir, 'dist', 'index.mjs')))
            WorkingDir = $Paths.RsshubDir
            Env = @{
                NODE_ENV = 'production'; NODE_OPTIONS = ''; TZ = $Tz; PORT = $c['RSSHUB_PORT']; LISTEN_INADDR_ANY = '0'
                CACHE_TYPE = 'memory'; NO_LOGFILES = 'true'; CHROMIUM_EXECUTABLE_PATH = $Paths.Chrome
                WS_NO_BUFFER_UTIL = '1'; WS_NO_UTF_8_VALIDATE = '1'
            }
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['RSSHUB_PORT'])/"
        }
    }
    return $out
}

function Get-AroomoSAServiceSpecs {
    # 启动顺序：postgres → redis → rustfs → litellm → core → lobe → shell（停止时倒过来）
    # 每个服务只拿到自己需要的环境变量（和 docker-compose.yml 相同的原则）
    [OutputType([object[]])]
    param([Parameter(Mandatory)][hashtable]$Paths, [Parameter(Mandatory)][hashtable]$Config)
    $c = $Config
    $pg = "127.0.0.1:$($c['PG_PORT'])"
    $tz = if ($c['TZ']) { $c['TZ'] } else { 'Asia/Shanghai' }
    $litellmUrl = "http://127.0.0.1:$($c['LITELLM_PORT'])"
    $bucket = if ($c['RUSTFS_LOBE_BUCKET']) { $c['RUSTFS_LOBE_BUCKET'] } else { 'lobe' }
    $lobeDb = if ($c['LOBE_DB_NAME']) { $c['LOBE_DB_NAME'] } else { 'lobechat' }
    $fts = if ($c['FTS_SEARCH_PROVIDER']) { $c['FTS_SEARCH_PROVIDER'] } else { 'pg_like' }
    # 薄定制层里能用官方开关做的部分（D68）；其余（品牌、朗读按钮）由 Aroomo Shell 隐藏
    $flags = if ($c['LOBE_FEATURE_FLAGS']) { $c['LOBE_FEATURE_FLAGS'] } else { '-check_updates,-changelog,-market,-welcome_suggest,-speech_to_text,-voice_dictation,-cloud_promotion' }
    $publicUrl = Get-AroomoSAPublicUrl -Paths $Paths -Config $c
    $sysPath = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    $coreJs = [IO.Path]::Combine($Paths.CoreDir, 'dist', 'index.js')
    $lobeStart = [IO.Path]::Combine($Paths.Runtime, 'lobe-start.cjs')
    $litellmEnv = @{
        PATH = "$($Paths.NodeDir);$($Paths.PythonDir);$sysPath"; PYTHONUTF8 = '1'; PYTHONIOENCODING = 'utf-8'; PYTHONDONTWRITEBYTECODE = '1'; TZ = $tz
        DATABASE_URL = "postgresql://litellm:$($c['LITELLM_DB_PASSWORD'])@$pg/litellm"
        LITELLM_MASTER_KEY = $c['LITELLM_MASTER_KEY']; LITELLM_SALT_KEY = $c['LITELLM_SALT_KEY']
        STORE_MODEL_IN_DB = 'True'; LITELLM_LOG = 'INFO'; LITELLM_PRISMA_MIGRATE_DEPLOY_TIMEOUT = '1800'; LITELLM_PRISMA_COMMAND_TIMEOUT = '300'
        USE_V2_MIGRATION_RESOLVER = 'true'
    }
    foreach ($kv in (Get-AroomoSAPrismaEnv -Paths $Paths).GetEnumerator()) { $litellmEnv[$kv.Key] = $kv.Value }
    $list = @(
        [pscustomobject]@{
            Name = 'postgres'; Label = '数据库（PostgreSQL）'; Kind = 'pgctl'; Port = [int]$c['PG_PORT']; TimeoutSec = 120
            Exe = [IO.Path]::Combine($Paths.PgBin, 'pg_ctl.exe'); Arguments = @(); Env = @{}; Health = 'pg'; HealthUrl = $null
        },
        [pscustomobject]@{
            Name = 'redis'; Label = '缓存（Redis）'; Kind = 'process'; Port = [int]$c['REDIS_PORT']; TimeoutSec = 60
            Exe = $Paths.Redis; Arguments = @((Split-Path -Leaf $Paths.RedisConf)); WorkingDir = (Split-Path -Parent $Paths.RedisConf); Env = @{}; Health = 'tcp'; HealthUrl = $null
        },
        [pscustomobject]@{
            Name = 'rustfs'; Label = '文件存储（RustFS）'; Kind = 'process'; Port = [int]$c['RUSTFS_PORT']; TimeoutSec = 120
            Exe = $Paths.RustFS; Arguments = @('server', $Paths.RustFSData)
            Env = @{ RUSTFS_ADDRESS = "127.0.0.1:$($c['RUSTFS_PORT'])"; RUSTFS_ACCESS_KEY = $c['RUSTFS_ACCESS_KEY']; RUSTFS_SECRET_KEY = $c['RUSTFS_SECRET_KEY']; RUSTFS_CONSOLE_ENABLE = 'false'; RUSTFS_OBS_LOGGER_LEVEL = 'warn' }
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['RUSTFS_PORT'])/health"
        },
        [pscustomobject]@{
            # LiteLLM 本体（与服务器同一版本，D70：不在 Core 里重做路由 / Key / 限额）
            Name = 'litellm'; Label = '模型网关（LiteLLM）'; Kind = 'process'; Port = [int]$c['LITELLM_PORT']; TimeoutSec = 900
            Exe = $Paths.Python
            Arguments = @('-m', 'litellm.proxy.proxy_cli', '--config', ([IO.Path]::Combine($Paths.LiteLLMDir, 'config.yaml')), '--host', '127.0.0.1', '--port', [string]$c['LITELLM_PORT'], '--num_workers', '1')
            Env = $litellmEnv
            Health = 'http'; HealthUrl = "$litellmUrl/health/liveliness"
        },
        [pscustomobject]@{
            Name = 'core'; Label = 'Aroomo Core'; Kind = 'process'; Port = [int]$c['CORE_PORT']; TimeoutSec = 90
            Exe = $Paths.Node; Arguments = @($coreJs)
            Env = @{
                NODE_ENV = 'production'; NODE_OPTIONS = ''; TZ = $tz
                CORE_HOST = '127.0.0.1'; CORE_PORT = $c['CORE_PORT']; CORE_LOG_LEVEL = $(if ($c['CORE_LOG_LEVEL']) { $c['CORE_LOG_LEVEL'] } else { 'info' }); CORE_TIMEZONE = $tz
                LITELLM_BASE_URL = $litellmUrl; LITELLM_MASTER_KEY = $c['LITELLM_MASTER_KEY']
                CORE_DATABASE_URL = "postgresql://aroomo_core:$($c['CORE_DB_PASSWORD'])@$pg/aroomo_core"
                CORE_OWNER_TOKEN = $c['CORE_OWNER_TOKEN']; CORE_TOKEN_SECRET = $c['CORE_TOKEN_SECRET']
                CORE_ACCESS_REAUTH = 'off'
            }
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['CORE_PORT'])/healthz"
        },
        [pscustomobject]@{
            Name = 'lobe'; Label = '对话界面（LobeHub）'; Kind = 'process'; Port = [int]$c['LOBE_PORT']; TimeoutSec = 900
            Exe = $Paths.Node; Arguments = @($lobeStart)
            Env = @{
                NODE_ENV = 'production'; NODE_OPTIONS = '--dns-result-order=ipv4first'; TZ = $tz
                LOBE_APP_DIR = $Paths.LobeDir; HOSTNAME = '127.0.0.1'; PORT = $c['LOBE_PORT']
                APP_URL = $publicUrl; INTERNAL_APP_URL = "http://127.0.0.1:$($c['LOBE_PORT'])"
                KEY_VAULTS_SECRET = $c['KEY_VAULTS_SECRET']; AUTH_SECRET = $c['AUTH_SECRET']; JWKS_KEY = [string]$c['JWKS_KEY']
                AUTH_ALLOWED_EMAILS = [string]$c['AUTH_ALLOWED_EMAILS']
                DATABASE_DRIVER = 'node'; DATABASE_URL = "postgresql://postgres:$($c['POSTGRES_PASSWORD'])@$pg/$lobeDb"
                FTS_SEARCH_PROVIDER = $fts; FEATURE_FLAGS = $flags
                S3_ENDPOINT = $c['S3_ENDPOINT']; S3_INTERNAL_ENDPOINT = "http://127.0.0.1:$($c['RUSTFS_PORT'])"; S3_BUCKET = $bucket
                S3_ENABLE_PATH_STYLE = '1'; S3_ACCESS_KEY = $c['RUSTFS_ACCESS_KEY']; S3_ACCESS_KEY_ID = $c['RUSTFS_ACCESS_KEY']
                S3_SECRET_ACCESS_KEY = $c['RUSTFS_SECRET_KEY']; S3_SET_ACL = '0'; LLM_VISION_IMAGE_USE_BASE64 = '1'
                REDIS_URL = "redis://:$($c['REDIS_PASSWORD'])@127.0.0.1:$($c['REDIS_PORT'])"; REDIS_PREFIX = 'lobechat'; REDIS_TLS = '0'
                OPENAI_PROXY_URL = "$litellmUrl/v1"; OPENAI_API_KEY = $c['LOBE_LITELLM_VIRTUAL_KEY']
                ENABLE_AGENT_GATEWAY = '0'; AGENT_GATEWAY_URL = 'http://127.0.0.1:8787'
            }
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['LOBE_PORT'])/"
        }
    )
    $list += @(Get-AroomoSAModuleSpecs -Paths $Paths -Config $c -LiteLLMUrl $litellmUrl -Tz $tz -SysPath $sysPath)
    if (Test-AroomoSAShell -Paths $Paths) {
        $list += [pscustomobject]@{
            Name = 'shell'; Label = 'Aroomo 界面层（Shell）'; Kind = 'process'; Port = [int]$c['SHELL_PORT']; TimeoutSec = 60
            Exe = $Paths.Node; Arguments = @(([IO.Path]::Combine($Paths.ShellDir, 'dist', 'index.js')))
            Env = @{
                NODE_ENV = 'production'; NODE_OPTIONS = ''; TZ = $tz
                SHELL_HOST = '127.0.0.1'; SHELL_PORT = $c['SHELL_PORT']
                LOBE_UPSTREAM = "http://127.0.0.1:$($c['LOBE_PORT'])"; CORE_UPSTREAM = "http://127.0.0.1:$($c['CORE_PORT'])"
                CORE_OWNER_TOKEN = $c['CORE_OWNER_TOKEN']; SHELL_DEFAULT_LOCALE = 'zh-CN'
                # D78：单一本机主人、不设本地登录密码——Shell 替浏览器登录 LobeHub（账号密码随机，只在本机配置里）
                SHELL_LOCAL_OWNER_EMAIL = [string]$c['LOCAL_OWNER_EMAIL']; SHELL_LOCAL_OWNER_PASSWORD = [string]$c['LOCAL_OWNER_PASSWORD']
                SHELL_PUBLIC_URL = $publicUrl
            }
            Health = 'http'; HealthUrl = "http://127.0.0.1:$($c['SHELL_PORT'])/"
        }
    }
    return $list
}

function Initialize-AroomoSALiteLLMKey {
    # LobeHub 调用 LiteLLM 用的虚拟 Key（只能调用模型）：不存在就用管理密钥建一个（值来自 aroomo.env，不打印）
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Context)
    $c = $Context.Config
    $base = "http://127.0.0.1:$($c['LITELLM_PORT'])"
    $h = @{ Authorization = "Bearer $($c['LITELLM_MASTER_KEY'])" }
    try {
        $null = Invoke-RestMethod -Method Get -Uri "$base/key/info?key=$([uri]::EscapeDataString($c['LOBE_LITELLM_VIRTUAL_KEY']))" -Headers $h -TimeoutSec 15 -UseBasicParsing
        return $true
    } catch { Write-Verbose '虚拟 Key 还不存在' }
    try {
        $body = @{ key = $c['LOBE_LITELLM_VIRTUAL_KEY']; key_alias = 'aroomo-lobehub'; metadata = @{ purpose = 'LobeHub 调用模型（独立版）' } } | ConvertTo-Json
        $null = Invoke-RestMethod -Method Post -Uri "$base/key/generate" -Headers $h -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

function Get-AroomoSAInitSql {
    # 第一次初始化：Core 和网关各用独立的库和账号（与 deploy/postgres/20-aroomo-dbs.sh 相同的做法）；LobeHub 用 postgres 账号
    # 只在 psql 的标准输入里传，不出现在命令行（其他程序看不到）
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Config)
    foreach ($k in @('CORE_DB_PASSWORD', 'LITELLM_DB_PASSWORD')) {
        if ($Config[$k] -notmatch '^[A-Za-z0-9]+$') { throw "$k 只能是字母和数字" }
    }
    $lobeDb = if ($Config['LOBE_DB_NAME']) { $Config['LOBE_DB_NAME'] } else { 'lobechat' }
    if ($lobeDb -notmatch '^[a-z_][a-z0-9_]*$') { throw 'LOBE_DB_NAME 不合法' }
    return @"
\set ON_ERROR_STOP on
SELECT 'CREATE DATABASE $lobeDb' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$lobeDb')\gexec
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'aroomo_core') THEN CREATE ROLE aroomo_core LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'litellm') THEN CREATE ROLE litellm LOGIN; END IF;
END `$`$;
ALTER ROLE aroomo_core PASSWORD '$($Config['CORE_DB_PASSWORD'])';
ALTER ROLE litellm PASSWORD '$($Config['LITELLM_DB_PASSWORD'])';
SELECT 'CREATE DATABASE aroomo_core OWNER aroomo_core' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aroomo_core')\gexec
SELECT 'CREATE DATABASE litellm OWNER litellm' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\gexec
\c $lobeDb
CREATE EXTENSION IF NOT EXISTS vector;
"@
}

function Get-AroomoSAPasswordResetSql {
    # 恢复备份后：把各账号的密码改成（恢复回来的）配置里的值
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Config)
    foreach ($k in @('POSTGRES_PASSWORD', 'CORE_DB_PASSWORD', 'LITELLM_DB_PASSWORD')) {
        if ($Config[$k] -notmatch '^[A-Za-z0-9]+$') { throw "$k 只能是字母和数字" }
    }
    return @"
\set ON_ERROR_STOP on
ALTER ROLE postgres PASSWORD '$($Config['POSTGRES_PASSWORD'])';
ALTER ROLE aroomo_core PASSWORD '$($Config['CORE_DB_PASSWORD'])';
ALTER ROLE litellm PASSWORD '$($Config['LITELLM_DB_PASSWORD'])';
"@
}

# ---------------------------------------------------------------------------
# 备份文件名和保留策略（与 scripts/lib/backup-common.sh 的 retention_keep 相同的规则）
# ---------------------------------------------------------------------------
function Get-AroomoSABackupName {
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$HostTag, [Parameter(Mandatory)][datetime]$Time)
    $tag = ($HostTag.ToLowerInvariant() -replace '[^a-z0-9-]', '-').Trim('-')
    if (-not $tag) { $tag = 'standalone' }
    return ('aroomo-{0}-{1}.tar.zst.age' -f $tag, $Time.ToUniversalTime().ToString('yyyyMMddTHHmmssZ', [Globalization.CultureInfo]::InvariantCulture))
}

function Select-AroomoSABackupsToKeep {
    # 返回要保留的文件名：最近 KeepLast 份 + 每天 / 每周 / 每月各最新一份（各最多 N 个）
    [OutputType([string[]])]
    param(
        [AllowEmptyCollection()][string[]]$Names = @(),
        [int]$KeepLast = 0, [int]$Daily = 0, [int]$Weekly = 0, [int]$Monthly = 0
    )
    $items = @(foreach ($n in $Names) {
            if ($n -match $script:BackupRegex) {
                $s = $Matches['stamp']
                $t = [datetime]::ParseExact($s, 'yyyyMMddTHHmmssZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
                $days = [Math]::Floor(($t - (New-Object DateTime 1970, 1, 1, 0, 0, 0, ([DateTimeKind]::Utc))).TotalDays)
                [pscustomobject]@{ Name = $n; Stamp = $s; Day = $s.Substring(0, 8); Week = [Math]::Floor(($days + 3) / 7); Month = $s.Substring(0, 6) }
            }
        })
    $sorted = @($items | Sort-Object -Property Stamp -Descending)
    $keep = New-Object System.Collections.Generic.HashSet[string]
    for ($i = 0; $i -lt [Math]::Min($KeepLast, $sorted.Count); $i++) { [void]$keep.Add($sorted[$i].Name) }
    foreach ($rule in @(@{ Key = 'Day'; N = $Daily }, @{ Key = 'Week'; N = $Weekly }, @{ Key = 'Month'; N = $Monthly })) {
        if ($rule.N -le 0) { continue }
        $seen = @{}
        foreach ($it in $sorted) {
            if ($seen.Count -ge $rule.N) { break }
            $k = [string]$it.($rule.Key)
            if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; [void]$keep.Add($it.Name) }
        }
    }
    return @($sorted | Where-Object { $keep.Contains($_.Name) } | ForEach-Object { $_.Name })
}

function Get-AroomoSARcloneEnv {
    # 异地存储的 rclone 设置走环境变量（不写配置文件，密钥不落盘）
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable]$Config)
    return @{
        RCLONE_CONFIG_AROOMO_TYPE              = 's3'
        RCLONE_CONFIG_AROOMO_PROVIDER          = 'Other'
        RCLONE_CONFIG_AROOMO_ENDPOINT          = $Config['BACKUP_S3_ENDPOINT']
        RCLONE_CONFIG_AROOMO_ACCESS_KEY_ID     = $Config['BACKUP_S3_ACCESS_KEY_ID']
        RCLONE_CONFIG_AROOMO_SECRET_ACCESS_KEY = $Config['BACKUP_S3_SECRET_ACCESS_KEY']
        RCLONE_CONFIG_AROOMO_REGION            = $(if ($Config['BACKUP_S3_REGION']) { $Config['BACKUP_S3_REGION'] } else { 'auto' })
        RCLONE_CONFIG_AROOMO_NO_CHECK_BUCKET   = 'true'
    }
}

function Test-AroomoSAOffsite {
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Config)
    return [bool]($Config['BACKUP_S3_ENDPOINT'] -and $Config['BACKUP_S3_BUCKET'] -and $Config['BACKUP_S3_ACCESS_KEY_ID'] -and $Config['BACKUP_S3_SECRET_ACCESS_KEY'])
}

# ---------------------------------------------------------------------------
# 进程（本机进程；不需要管理员权限）
# ---------------------------------------------------------------------------
function Format-AroomoSAArg {
    # 给 cmd.exe 用的参数加引号
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Value)
    if ($Value -match '[\s"&|<>^]' -or $Value -eq '') { return '"' + ($Value -replace '"', '""') + '"' }
    return $Value
}

function Get-AroomoSACmdLine {
    # cmd.exe /d /s /c ""程序" 参数 >> "日志" 2>&1"：程序的输出追加到日志文件
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$Exe, [string[]]$Arguments = @(), [Parameter(Mandatory)][string]$LogFile)
    $parts = @('"' + $Exe + '"') + @($Arguments | ForEach-Object { Format-AroomoSAArg $_ })
    return '/d /s /c "' + ($parts -join ' ') + ' >> "' + $LogFile + '" 2>&1"'
}

function Clear-AroomoSAInheritedEnv {
    # 不继承电脑上别的 PostgreSQL / Redis 留下的环境变量（PGUSER、PGPASSWORD、PGDATA…）：
    # 用户电脑或 CI 上装了别的 PostgreSQL 时，这些变量会让我们的工具连错账号或目录（2026-10-28 CI：PGUSER=postgres、PGPASSWORD 导致认证失败日志）
    param([Parameter(Mandatory)][System.Diagnostics.ProcessStartInfo]$Psi)
    $drop = @($Psi.EnvironmentVariables.Keys | Where-Object { $_ -match '^(PG[A-Z]+|REDISCLI_AUTH|NODE_OPTIONS|PYTHONHOME|PYTHONPATH)$' })
    foreach ($k in $drop) { $Psi.EnvironmentVariables.Remove($k) }
}

function Invoke-AroomoSAHidden {
    # 隐藏窗口运行一个程序并等它结束；可以传额外环境变量和标准输入。返回 @{ ExitCode; Output }（输出不会打印）
    [OutputType([hashtable])]
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$Arguments = @(),
        [hashtable]$Env = @{},
        [string]$StdIn = $null,
        [int]$TimeoutSec = 600,
        # 不接管输出：用于会留下常驻子进程的程序（pg_ctl start）。子进程继承了输出管道时，
        # 读输出会一直等到子进程退出（2026-10-28 CI 上卡死的原因）
        [switch]$NoCapture
    )
    if ($NoCapture) {
        $psi0 = New-Object System.Diagnostics.ProcessStartInfo
        $psi0.FileName = $Exe
        $psi0.Arguments = (@($Arguments | ForEach-Object { Format-AroomoSAArg $_ }) -join ' ')
        $psi0.UseShellExecute = $false
        $psi0.CreateNoWindow = $true
        Clear-AroomoSAInheritedEnv -Psi $psi0
        foreach ($k in $Env.Keys) { $psi0.EnvironmentVariables[$k] = [string]$Env[$k] }
        $p0 = [System.Diagnostics.Process]::Start($psi0)
        if (-not $p0.WaitForExit($TimeoutSec * 1000)) {
            try { $p0.Kill() } catch { Write-Verbose '进程已结束' }
            return @{ ExitCode = -1; Output = '超时' }
        }
        return @{ ExitCode = $p0.ExitCode; Output = '' }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = (@($Arguments | ForEach-Object { Format-AroomoSAArg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = ($null -ne $StdIn)
    Clear-AroomoSAInheritedEnv -Psi $psi
    foreach ($k in $Env.Keys) { $psi.EnvironmentVariables[$k] = [string]$Env[$k] }
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($null -ne $StdIn) {
        $p.StandardInput.Write($StdIn)
        $p.StandardInput.Close()
    }
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        try { $p.Kill() } catch { Write-Verbose '进程已结束' }
        return @{ ExitCode = -1; Output = '超时' }
    }
    $p.WaitForExit()
    return @{ ExitCode = $p.ExitCode; Output = ($outTask.Result + $errTask.Result) }
}

function Start-AroomoSAProcess {
    # 隐藏窗口启动常驻服务，输出写进日志；返回进程号（cmd.exe 的进程号，停止时连同子进程一起结束）
    [OutputType([int])]
    param([Parameter(Mandatory)][pscustomobject]$Spec, [Parameter(Mandatory)][hashtable]$Paths)
    New-Item -ItemType Directory -Path $Paths.Logs, $Paths.Run -Force | Out-Null
    $log = [IO.Path]::Combine($Paths.Logs, "$($Spec.Name).log")
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = Get-AroomoSACmdLine -Exe $Spec.Exe -Arguments $Spec.Arguments -LogFile $log
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $wd = if ($Spec.PSObject.Properties['WorkingDir'] -and $Spec.WorkingDir) { $Spec.WorkingDir } else { Split-Path -Parent $Spec.Exe }
    $psi.WorkingDirectory = $wd
    Clear-AroomoSAInheritedEnv -Psi $psi
    foreach ($k in $Spec.Env.Keys) { $psi.EnvironmentVariables[$k] = [string]$Spec.Env[$k] }
    $p = [System.Diagnostics.Process]::Start($psi)
    [IO.File]::WriteAllText([IO.Path]::Combine($Paths.Run, "$($Spec.Name).pid"), [string]$p.Id)
    return $p.Id
}

function Get-AroomoSAHttpStatus {
    # 返回 HTTP 状态码；连不上返回 0
    [OutputType([int])]
    param([Parameter(Mandatory)][string]$Url, [int]$TimeoutMs = 3000)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = 'GET'
        $req.Timeout = $TimeoutMs
        $req.AllowAutoRedirect = $false
        $req.Proxy = $null
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return $code
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Close()
            return $code
        }
        return 0
    } catch {
        return 0
    }
}

function Test-AroomoSATcp {
    [OutputType([bool])]
    param([Parameter(Mandatory)][int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-AroomoSAServiceHealthy {
    [OutputType([bool])]
    param([Parameter(Mandatory)][pscustomobject]$Spec, [Parameter(Mandatory)][hashtable]$Paths)
    switch ($Spec.Health) {
        'pg' {
            $r = Invoke-AroomoSAHidden -Exe ([IO.Path]::Combine($Paths.PgBin, 'pg_isready.exe')) -Arguments @('-h', '127.0.0.1', '-p', [string]$Spec.Port, '-t', '3') -TimeoutSec 10
            return ($r.ExitCode -eq 0)
        }
        'tcp' { return (Test-AroomoSATcp -Port $Spec.Port) }
        'http' {
            $code = Get-AroomoSAHttpStatus -Url $Spec.HealthUrl
            return ($code -ge 200 -and $code -lt 500)
        }
    }
    return $false
}

function Get-AroomoSAPortOwner {
    # 占用端口的进程（只在它属于本程序文件夹时返回，避免误关别的程序）
    [OutputType([int[]])]
    param([Parameter(Mandatory)][int]$Port, [Parameter(Mandatory)][string]$AppDir)
    $ids = @()
    try {
        $ids = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        return @()
    }
    $mine = @()
    foreach ($id in $ids) {
        $p = Get-Process -Id $id -ErrorAction SilentlyContinue
        $path = $null
        if ($p) { try { $path = $p.Path } catch { $path = $null } }
        if ($path -and $path.StartsWith($AppDir, [StringComparison]::OrdinalIgnoreCase)) { $mine += [int]$id }
    }
    return $mine
}

function Stop-AroomoSATree {
    param([Parameter(Mandatory)][int]$ProcessId)
    & taskkill.exe /T /F /PID $ProcessId *> $null
}

# ---------------------------------------------------------------------------
# 打开应用：优先用 Edge 的「应用窗口」（没有地址栏，像一个独立程序）；没有 Edge 就用默认浏览器
# ---------------------------------------------------------------------------
function Get-AroomoSAEdgePath {
    # 「应用窗口」用的浏览器：Edge → 已装的 Chrome → 安装包自带的 Chromium（有的电脑把 Edge 删了，2026-10-28 用户电脑就是）
    [OutputType([string])]
    param([string]$AppDir)
    $candidates = @()
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += [IO.Path]::Combine($base, 'Microsoft', 'Edge', 'Application', 'msedge.exe') }
    }
    foreach ($exe in 'msedge.exe', 'chrome.exe') {
        foreach ($hive in 'HKCU:', 'HKLM:') {
            $v = (Get-ItemProperty "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction SilentlyContinue)
            if ($v -and $v.'(default)') { $candidates += $v.'(default)'.Trim('"') }
        }
    }
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += [IO.Path]::Combine($base, 'Google', 'Chrome', 'Application', 'chrome.exe') }
    }
    if ($AppDir) { $candidates += [IO.Path]::Combine($AppDir, 'chromium', 'chrome.exe') }
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

function Open-AroomoSAApp {
    param([Parameter(Mandatory)][string]$Url)
    $edge = Get-AroomoSAEdgePath
    if ($edge) {
        Start-Process -FilePath $edge -ArgumentList @("--app=$Url")
    } else {
        Start-Process $Url
    }
}

# ---------------------------------------------------------------------------
# 以下是会改动电脑状态的操作（安装器和 aroomo-standalone.ps1 使用）
# ---------------------------------------------------------------------------
function Get-AroomoSAContext {
    # 读出路径、配置和服务定义。找不到配置时 Config 为空表。
    [OutputType([hashtable])]
    param([string]$AppDir, [string]$DataDir)
    $info = Get-AroomoSAInstallInfo
    if (-not $AppDir) { $AppDir = $info.AppDir }
    if (-not $DataDir) { $DataDir = $info.DataDir }
    if (-not $AppDir -or -not $DataDir) { return $null }
    $paths = Get-AroomoSAPaths -AppDir $AppDir -DataDir $DataDir
    $cfg = Read-AroomoEnv -Path $paths.EnvFile
    $specs = if ($cfg.Count -gt 0) { Get-AroomoSAServiceSpecs -Paths $paths -Config $cfg } else { @() }
    return @{ Paths = $paths; Config = $cfg; Specs = $specs }
}

function Get-AroomoSASpec {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$Name)
    return ($Context.Specs | Where-Object { $_.Name -eq $Name } | Select-Object -First 1)
}

function Expand-AroomoSAPackage {
    # 解开随包的程序包（<名字>.tar.gz，第一次安装或升级后）。返回 current（已是这个版本）| unpacked | absent（这个版本没带）
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Paths, [Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Label, [switch]$Optional)
    $dir = [IO.Path]::Combine($Paths.AppDir, $Name)
    $archive = "$dir.tar.gz"
    $shaFile = "$archive.sha256"
    $marker = [IO.Path]::Combine($dir, ".aroomo-$Name-sha256")
    $sha = if (Test-Path -LiteralPath $shaFile) { ([IO.File]::ReadAllText($shaFile)).Trim() } else { '' }
    if ((Test-Path -LiteralPath $marker) -and (-not $sha -or ([IO.File]::ReadAllText($marker)).Trim() -eq $sha)) { return 'current' }
    if (-not $sha -or -not (Test-Path -LiteralPath $archive)) {
        if ($Optional) { return 'absent' }
        throw "找不到$Label的程序包（$Name.tar.gz）。请重新运行 Aroomo 独立版安装包。"
    }
    $unpack = [IO.Path]::Combine($Paths.Runtime, 'unpack-lobe.cjs')
    if (Test-Path -LiteralPath $dir) {
        & $Paths.Node $unpack --remove $dir | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "删除旧版本的$Label没有成功。请先运行「Aroomo 独立版 停止」再试。" }
    }
    & $Paths.Node $unpack $archive $dir $sha | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "解开$Label的程序包没有成功。日志在数据文件夹的 logs 里。" }
    [IO.File]::WriteAllText($marker, $sha)
    # 程序包解开后就不需要了；重新安装时会再带上
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    return 'unpacked'
}

function Expand-AroomoSALobe {
    # 解开 LobeHub（第一次安装或升级后）。返回 current | unpacked
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Paths)
    return (Expand-AroomoSAPackage -Paths $Paths -Name 'lobe' -Label '对话界面')
}

function Expand-AroomoSAModules {
    # 完整档模块（收藏 Karakeep、RSSHub）：这个版本带了就解开
    param([Parameter(Mandatory)][hashtable]$Paths)
    [void](Expand-AroomoSAPackage -Paths $Paths -Name 'karakeep' -Label '收藏（Karakeep）' -Optional)
    [void](Expand-AroomoSAPackage -Paths $Paths -Name 'rsshub' -Label '订阅源（RSSHub）' -Optional)
}

function Test-AroomoSAModule {
    # 完整档模块在不在（已解开，或程序包还没解开）
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Paths, [Parameter(Mandatory)][ValidateSet('karakeep', 'rsshub')][string]$Name)
    $dir = [IO.Path]::Combine($Paths.AppDir, $Name)
    return ((Test-Path -LiteralPath "$dir.tar.gz") -or (Test-Path -LiteralPath ([IO.Path]::Combine($dir, ".aroomo-$Name-sha256"))))
}

function Write-AroomoSARedisConf {
    param([Parameter(Mandatory)][hashtable]$Context)
    New-Item -ItemType Directory -Path $Context.Paths.RedisData -Force | Out-Null
    $text = Get-AroomoSARedisConf -Port ([int]$Context.Config['REDIS_PORT']) -DataDir $Context.Paths.RedisData -Secret $Context.Config['REDIS_PASSWORD']
    Write-AroomoPrivateFile -Path $Context.Paths.RedisConf -Content $text
}

function Invoke-AroomoSAPsql {
    # 用 postgres 账号执行 SQL（SQL 走标准输入）；返回 @{ ExitCode; Output }
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$Sql, [string]$Database = 'postgres', [string[]]$Extra = @())
    $psql = [IO.Path]::Combine($Context.Paths.PgBin, 'psql.exe')
    $psqlArgs = @('-X', '-q', '-h', '127.0.0.1', '-p', $Context.Config['PG_PORT'], '-U', 'postgres', '-d', $Database, '-v', 'ON_ERROR_STOP=1') + $Extra
    return (Invoke-AroomoSAHidden -Exe $psql -Arguments $psqlArgs -Env @{ PGPASSWORD = $Context.Config['POSTGRES_PASSWORD']; PGCLIENTENCODING = 'UTF8' } -StdIn $Sql -TimeoutSec 600)
}

function Start-AroomoSAService {
    # 启动一个服务并等它就绪。返回 $true / $false
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][pscustomobject]$Spec, [switch]$Quiet)
    $paths = $Context.Paths
    if (Test-AroomoSAServiceHealthy -Spec $Spec -Paths $paths) { return $true }
    if (-not (Test-Path -LiteralPath $Spec.Exe)) {
        Write-AroomoSay "找不到 $($Spec.Label) 的程序。请重新运行 Aroomo 独立版安装包。"
        return $false
    }
    if (-not $Quiet) { Write-AroomoSay "正在启动 $($Spec.Label)。" }
    $procId = 0
    if ($Spec.Kind -eq 'pgctl') {
        New-Item -ItemType Directory -Path $paths.Logs -Force | Out-Null
        $r = Invoke-AroomoSAHidden -Exe $Spec.Exe -Arguments @('start', '-D', $paths.PgData, '-l', ([IO.Path]::Combine($paths.Logs, 'postgres.log')), '-w', '-t', '120', '-s') -TimeoutSec 150 -NoCapture
        if ($r.ExitCode -ne 0) {
            Write-AroomoSay "$($Spec.Label) 没能启动。详细原因在数据文件夹的 logs\postgres.log。"
            return $false
        }
    } else {
        if ($Spec.Name -eq 'redis') { Write-AroomoSARedisConf -Context $Context }
        if ($Spec.Name -eq 'rustfs') { New-Item -ItemType Directory -Path $paths.RustFSData -Force | Out-Null }
        if ($Spec.Name -eq 'meilisearch') { New-Item -ItemType Directory -Path $paths.MeiliData -Force | Out-Null }
        if ($Spec.Name -eq 'karakeep') { New-Item -ItemType Directory -Path $paths.KarakeepData -Force | Out-Null }
        $procId = Start-AroomoSAProcess -Spec $Spec -Paths $paths
    }
    $deadline = (Get-Date).AddSeconds($Spec.TimeoutSec)
    $nextNote = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if (Test-AroomoSAServiceHealthy -Spec $Spec -Paths $paths) { return $true }
        if ($procId -and -not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) {
            Write-AroomoSay "$($Spec.Label) 启动后马上退出了。详细原因在数据文件夹的 logs\$($Spec.Name).log。"
            return $false
        }
        if (-not $Quiet -and (Get-Date) -gt $nextNote) {
            $nextNote = (Get-Date).AddSeconds(60)
            $extra = if ($Spec.Name -eq 'lobe') { '第一次启动要准备数据库，可能需要几分钟。' } else { '' }
            Write-AroomoSay "$($Spec.Label) 还在启动。$extra"
        }
        Start-Sleep -Seconds 2
    }
    Write-AroomoSay "$($Spec.Label) 等了 $([int]($Spec.TimeoutSec / 60)) 分钟还没就绪。详细原因在数据文件夹的 logs\$($Spec.Name).log。"
    return $false
}

function Initialize-AroomoSABucket {
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Context)
    $c = $Context.Config
    $s3Env = @{
        LOBE_APP_DIR = $Context.Paths.LobeDir; S3_INTERNAL_ENDPOINT = "http://127.0.0.1:$($c['RUSTFS_PORT'])"
        RUSTFS_ACCESS_KEY = $c['RUSTFS_ACCESS_KEY']; RUSTFS_SECRET_KEY = $c['RUSTFS_SECRET_KEY']
        RUSTFS_LOBE_BUCKET = $(if ($c['RUSTFS_LOBE_BUCKET']) { $c['RUSTFS_LOBE_BUCKET'] } else { 'lobe' }); NODE_OPTIONS = ''
    }
    $r = Invoke-AroomoSAHidden -Exe $Context.Paths.Node -Arguments @(([IO.Path]::Combine($Context.Paths.Runtime, 's3-init.cjs'))) -Env $s3Env -TimeoutSec 120
    if ($r.ExitCode -ne 0) { Write-AroomoSay '文件存储的初始化没有成功（创建存放上传文件的桶）。'; return $false }
    return $true
}

function Start-AroomoSAAll {
    # 按顺序启动全部服务。返回 $true / $false
    [OutputType([bool])]
    param([Parameter(Mandatory)][hashtable]$Context, [string[]]$Only = @(), [switch]$Quiet)
    foreach ($spec in $Context.Specs) {
        if ($Only.Count -gt 0 -and $Only -notcontains $spec.Name) { continue }
        if ($spec.Name -eq 'lobe' -and -not (Initialize-AroomoSABucket -Context $Context)) { return $false }
        if (-not (Start-AroomoSAService -Context $Context -Spec $spec -Quiet:$Quiet)) { return $false }
    }
    return $true
}

function Stop-AroomoSAService {
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][pscustomobject]$Spec)
    $paths = $Context.Paths
    $pidFile = [IO.Path]::Combine($paths.Run, "$($Spec.Name).pid")
    if ($Spec.Kind -eq 'pgctl') {
        if (Test-Path -LiteralPath ([IO.Path]::Combine($paths.PgData, 'postmaster.pid'))) {
            [void](Invoke-AroomoSAHidden -Exe $Spec.Exe -Arguments @('stop', '-D', $paths.PgData, '-m', 'fast', '-w', '-t', '90', '-s') -TimeoutSec 120)
        }
        return
    }
    if ($Spec.Name -eq 'redis' -and (Test-AroomoSATcp -Port $Spec.Port)) {
        [void](Invoke-AroomoSAHidden -Exe $paths.RedisCli -Arguments @('-h', '127.0.0.1', '-p', [string]$Spec.Port, 'shutdown') -Env @{ REDISCLI_AUTH = $Context.Config['REDIS_PASSWORD'] } -TimeoutSec 30)
        Start-Sleep -Seconds 1
    }
    if (Test-Path -LiteralPath $pidFile) {
        $procId = 0
        if ([int]::TryParse(([IO.File]::ReadAllText($pidFile)).Trim(), [ref]$procId) -and (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { Stop-AroomoSATree -ProcessId $procId }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
    foreach ($id in (Get-AroomoSAPortOwner -Port $Spec.Port -AppDir $paths.AppDir)) { Stop-AroomoSATree -ProcessId $id }
}

function Stop-AroomoSAAll {
    param([Parameter(Mandatory)][hashtable]$Context, [string[]]$Only = @())
    $list = @($Context.Specs)
    [array]::Reverse($list)
    foreach ($spec in $list) {
        if ($Only.Count -gt 0 -and $Only -notcontains $spec.Name) { continue }
        Stop-AroomoSAService -Context $Context -Spec $spec
    }
}

function Initialize-AroomoSADatabase {
    # 第一次：initdb → 写配置 → 启动 → 建库和账号。返回 exists | created
    [OutputType([string])]
    param([Parameter(Mandatory)][hashtable]$Context)
    $paths = $Context.Paths
    if (Test-Path -LiteralPath ([IO.Path]::Combine($paths.PgData, 'PG_VERSION'))) {
        # 已有数据库：确认账号和库都在（升级或上次中断时补上）
        if (-not (Start-AroomoSAService -Context $Context -Spec (Get-AroomoSASpec $Context 'postgres') -Quiet)) { throw '数据库没能启动' }
        $r = Invoke-AroomoSAPsql -Context $Context -Sql (Get-AroomoSAInitSql -Config $Context.Config)
        if ($r.ExitCode -ne 0) { throw '检查数据库账号没有成功' }
        return 'exists'
    }
    # 不要预先建 pgdata：initdb 会用「受限令牌」运行（管理员账户下去掉管理员权限），
    # 管理员进程建的目录它改不了权限（2026-10-28 CI 上遇到）。让 initdb 自己建；空目录先删掉。
    if ((Test-Path -LiteralPath $paths.PgData) -and -not (Get-ChildItem -LiteralPath $paths.PgData -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $paths.PgData -Force }
    New-Item -ItemType Directory -Path $paths.Config, $paths.Logs -Force | Out-Null
    $pw = [IO.Path]::Combine($paths.Config, ('pg-init-{0}.tmp' -f [Guid]::NewGuid().ToString('N')))
    try {
        Write-AroomoPrivateFile -Path $pw -Content $Context.Config['POSTGRES_PASSWORD']
        $initdb = [IO.Path]::Combine($paths.PgBin, 'initdb.exe')
        $r = Invoke-AroomoSAHidden -Exe $initdb -Arguments @('-D', $paths.PgData, '-U', 'postgres', '-A', 'scram-sha-256', "--pwfile=$pw", '-E', 'UTF8', '--locale=C', '--locale-provider=builtin', '--builtin-locale=C.UTF-8') -TimeoutSec 300
        if ($r.ExitCode -ne 0) {
            [IO.File]::WriteAllText([IO.Path]::Combine($paths.Logs, 'initdb.log'), $r.Output)
            throw '初始化数据库（initdb）没有成功。详细原因在数据文件夹的 logs\initdb.log。'
        }
    } finally {
        Remove-Item -LiteralPath $pw -Force -ErrorAction SilentlyContinue
    }
    $conf = [IO.Path]::Combine($paths.PgData, 'postgresql.conf')
    [IO.File]::AppendAllText($conf, (Get-AroomoSAPgConf -Port ([int]$Context.Config['PG_PORT'])))
    if (-not (Start-AroomoSAService -Context $Context -Spec (Get-AroomoSASpec $Context 'postgres') -Quiet)) { throw '数据库没能启动' }
    $r = Invoke-AroomoSAPsql -Context $Context -Sql (Get-AroomoSAInitSql -Config $Context.Config)
    if ($r.ExitCode -ne 0) {
        [IO.File]::WriteAllText([IO.Path]::Combine($paths.Logs, 'db-init.log'), $r.Output)
        throw '创建数据库和账号没有成功。详细原因在数据文件夹的 logs\db-init.log。'
    }
    return 'created'
}

# ---------------------------------------------------------------------------
# 备份（D64、D65）：pg_dump 每个库 + 对象存储 + 配置 → tar.gz → 用主密钥的公钥（age）加密
# ---------------------------------------------------------------------------
function Get-AroomoSATar {
    [OutputType([string])]
    param()
    $t = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $t) { return $t }
    return 'tar'
}

function Invoke-AroomoSABackup {
    # 返回 [pscustomobject]@{ Ok; Step; File; LocalCount; Offsite; DurationS }
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][hashtable]$Context)
    $started = Get-Date
    $paths = $Context.Paths
    $c = $Context.Config
    $res = [pscustomobject]@{ Ok = $false; Step = ''; File = $null; LocalCount = 0; Offsite = $false; DurationS = 0 }
    $fail = { param($step) $res.Step = $step; $res.DurationS = [int]((Get-Date) - $started).TotalSeconds; return $res }
    if (-not (Test-AroomoAgeRecipient $c['BACKUP_AGE_RECIPIENT'])) { return (& $fail '还没有主密钥（配置里没有 BACKUP_AGE_RECIPIENT），备份不能加密') }
    $raw = [IO.File]::ReadAllText($paths.EnvFile)
    # 只认真正的私钥（AGE-SECRET-KEY-1 + bech32 字符），配置模板的注释里也写着这个前缀（2026-10-28 CI 误报）
    if ($raw -cmatch 'AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{50,}') { return (& $fail '配置文件里出现了主密钥，拒绝备份。请从配置里删除它') }
    if ($env:AROOMO_BACKUP_IDENTITY) { return (& $fail '环境里出现了主密钥（AROOMO_BACKUP_IDENTITY），拒绝备份') }
    if (-not (Test-Path -LiteralPath $paths.Age)) { return (& $fail '找不到 age.exe，请重新运行安装包') }

    $pgSpec = Get-AroomoSASpec $Context 'postgres'
    $pgWasRunning = Test-AroomoSAServiceHealthy -Spec $pgSpec -Paths $paths
    if (-not $pgWasRunning -and -not (Start-AroomoSAService -Context $Context -Spec $pgSpec -Quiet)) { return (& $fail '数据库没能启动') }
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('aroomo-backup-{0}' -f [Guid]::NewGuid().ToString('N'))
    $tarFile = "$stage.tar.zst"
    $plainTar = "$stage.tar"
    $name = Get-AroomoSABackupName -HostTag $(if ($c['BACKUP_HOST_TAG']) { $c['BACKUP_HOST_TAG'] } else { 'standalone' }) -Time (Get-Date)
    New-Item -ItemType Directory -Path $paths.Backups -Force | Out-Null
    $out = [IO.Path]::Combine($paths.Backups, $name)
    $partial = "$out.partial"
    $pgEnv = @{ PGPASSWORD = $c['POSTGRES_PASSWORD']; PGCLIENTENCODING = 'UTF8' }
    $conn = @('-h', '127.0.0.1', '-p', $c['PG_PORT'], '-U', 'postgres')
    try {
        # 目录结构和服务器 scripts/backup.sh 相同：backup-stage/（清单、角色、每库一个 dump）、data/secrets/aroomo.env、data/rustfs
        New-Item -ItemType Directory -Path ([IO.Path]::Combine($stage, 'backup-stage', 'db')), ([IO.Path]::Combine($stage, 'data', 'secrets')) -Force | Out-Null
        $r = Invoke-AroomoSAHidden -Exe ([IO.Path]::Combine($paths.PgBin, 'pg_dumpall.exe')) -Arguments ($conn + @('--globals-only', '--no-role-passwords', '-f', [IO.Path]::Combine($stage, 'backup-stage', 'globals.sql'))) -Env $pgEnv
        if ($r.ExitCode -ne 0) { return (& $fail '导出数据库账号') }
        $r = Invoke-AroomoSAPsql -Context $Context -Sql "select datname from pg_database where not datistemplate and datallowconn and datname <> 'postgres' order by 1;" -Extra @('-At')
        if ($r.ExitCode -ne 0) { return (& $fail '列出数据库') }
        $dbs = @($r.Output -split "`r?`n" | Where-Object { $_ -match '^[a-z_][a-z0-9_]*$' })
        if ($dbs.Count -eq 0) { return (& $fail '没有找到要备份的数据库') }
        foreach ($db in $dbs) {
            $r = Invoke-AroomoSAHidden -Exe ([IO.Path]::Combine($paths.PgBin, 'pg_dump.exe')) -Arguments ($conn + @('-Fc', '-d', $db, '-f', [IO.Path]::Combine($stage, 'backup-stage', 'db', "$db.dump"))) -Env $pgEnv -TimeoutSec 3600
            if ($r.ExitCode -ne 0) { return (& $fail "导出数据库 $db") }
        }
        $manifest = [ordered]@{ format = $script:BackupFormat; created_at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); host_tag = $c['BACKUP_HOST_TAG']; edition = 'standalone'; databases = $dbs }
        [IO.File]::WriteAllText([IO.Path]::Combine($stage, 'backup-stage', 'manifest.json'), ($manifest | ConvertTo-Json -Compress))
        Copy-Item -LiteralPath $paths.EnvFile -Destination ([IO.Path]::Combine($stage, 'data', 'secrets', 'aroomo.env'))

        # 打包：先在运行中直接读对象存储；读不了（文件被占用）就暂停对象存储几秒再读
        $tar = Get-AroomoSATar
        # 对象存储和收藏资料在压缩包里放到 data/ 下（-s 改名，不复制）
        $tarArgs = @('-s', ',^rustfs,data/rustfs,', '-s', ',^karakeep,data/karakeep,', '-cf', $plainTar, '-C', $stage, 'backup-stage', 'data')
        if (Test-Path -LiteralPath $paths.RustFSData) { $tarArgs += @('-C', $paths.DataDir, 'rustfs') }
        # 收藏（Karakeep）：SQLite 用在线备份接口拷一份一致的副本放进备份；正在用的库文件不直接打包
        $kdb = [IO.Path]::Combine($paths.KarakeepData, 'db.db')
        if (Test-Path -LiteralPath $kdb) {
            $kdst = [IO.Path]::Combine($stage, 'backup-stage', 'karakeep-db.db')
            $r = Invoke-AroomoSAHidden -Exe $paths.Node -Arguments @(([IO.Path]::Combine($paths.Runtime, 'karakeep-start.cjs')), 'backup', $kdb, $kdst) -Env @{ KARAKEEP_DIR = $paths.KarakeepDir } -TimeoutSec 1800
            if ($r.ExitCode -ne 0) { return (& $fail '导出收藏数据库') }
        }
        # 收藏的上传 / 抓取资料（assets）；队列库等运行中的 SQLite 文件不打包（被锁着读不了，也不需要）
        if (Test-Path -LiteralPath ([IO.Path]::Combine($paths.KarakeepData, 'assets'))) { $tarArgs += @('-C', $paths.DataDir, 'karakeep/assets') }
        $r = Invoke-AroomoSAHidden -Exe $tar -Arguments $tarArgs -TimeoutSec 3600
        if ($r.ExitCode -ne 0) {
            $rs = Get-AroomoSASpec $Context 'rustfs'
            $wasUp = Test-AroomoSAServiceHealthy -Spec $rs -Paths $paths
            if ($wasUp) { Stop-AroomoSAService -Context $Context -Spec $rs }
            Remove-Item -LiteralPath $plainTar -Force -ErrorAction SilentlyContinue
            $r = Invoke-AroomoSAHidden -Exe $tar -Arguments $tarArgs -TimeoutSec 3600
            if ($wasUp) { [void](Start-AroomoSAService -Context $Context -Spec $rs -Quiet) }
            if ($r.ExitCode -ne 0) {
                [IO.File]::WriteAllText([IO.Path]::Combine($paths.Logs, 'backup-tar.log'), [string]$r.Output)
                return (& $fail '打包（详细原因在 logs\backup-tar.log）')
            }
        }
        if (-not (Test-Path -LiteralPath $paths.Zstd)) { return (& $fail '找不到 zstd.exe，请重新运行安装包') }
        $r = Invoke-AroomoSAHidden -Exe $paths.Zstd -Arguments @('-q', '-f', '-T0', '-3', '--rm', $plainTar, '-o', $tarFile) -TimeoutSec 3600
        if ($r.ExitCode -ne 0) { return (& $fail '压缩（zstd）') }
        $r = Invoke-AroomoSAHidden -Exe $paths.Age -Arguments @('-r', $c['BACKUP_AGE_RECIPIENT'], '-o', $partial, $tarFile) -TimeoutSec 3600
        if ($r.ExitCode -ne 0) { return (& $fail '用主密钥的公钥加密') }
        $head = New-Object byte[] 21
        $fs = [IO.File]::OpenRead($partial)
        try { [void]$fs.Read($head, 0, 21) } finally { $fs.Close() }
        if ([Text.Encoding]::ASCII.GetString($head) -ne 'age-encryption.org/v1') { return (& $fail '加密结果不是 age 格式') }
        Move-Item -LiteralPath $partial -Destination $out -Force
        $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $out).Hash.ToLowerInvariant()
        $meta = [ordered]@{
            format = $script:BackupFormat; file = $name; created_at = $started.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); stamp_utc = ($name -replace '^.*-(\d{8}T\d{6}Z)\.tar\.zst\.age$', '$1'); host_tag = $c['BACKUP_HOST_TAG']
            encryption = 'age-x25519'; cipher = 'X25519 + ChaCha20-Poly1305 (age v1)'; kdf = 'none (public-key)'
            recipient = $c['BACKUP_AGE_RECIPIENT']; compression = 'zstd'; sha256 = $sha; size_bytes = (Get-Item -LiteralPath $out).Length
            env_included = $true; databases = $dbs.Count
        }
        $metaPath = $out -replace '\.tar\.(zst|gz)\.age$', '.meta.json'
        [IO.File]::WriteAllText($metaPath, ($meta | ConvertTo-Json -Compress))
        $res.File = $out

        # 本机只留最近 N 份（D65：3 份）
        $keepN = 3
        if ($c['BACKUP_LOCAL_KEEP'] -match '^\d+$' -and [int]$c['BACKUP_LOCAL_KEEP'] -ge 1) { $keepN = [int]$c['BACKUP_LOCAL_KEEP'] }
        $local = @(Get-ChildItem -LiteralPath $paths.Backups -Filter 'aroomo-*.age' | Where-Object { $_.Name -match $script:BackupRegex } | Sort-Object Name -Descending)
        foreach ($old in ($local | Select-Object -Skip $keepN)) {
            Remove-Item -LiteralPath $old.FullName -Force
            Remove-Item -LiteralPath ($old.FullName -replace '\.tar\.(zst|gz)\.age$', '.meta.json') -Force -ErrorAction SilentlyContinue
        }
        $res.LocalCount = [Math]::Min($local.Count, $keepN)

        # 异地（和服务器同一个桶，独立目录 pc/<电脑名>/）
        if (Test-AroomoSAOffsite -Config $c) {
            $renv = Get-AroomoSARcloneEnv -Config $c
            $prefix = if ($c['BACKUP_S3_PREFIX']) { $c['BACKUP_S3_PREFIX'].Trim('/') } else { Get-AroomoPcBackupPrefix }
            $remote = "aroomo:$($c['BACKUP_S3_BUCKET'])/$prefix"
            foreach ($f in @($out, $metaPath)) {
                $r = Invoke-AroomoSAHidden -Exe $paths.Rclone -Arguments @('copyto', $f, "$remote/$([IO.Path]::GetFileName($f))") -Env $renv -TimeoutSec 7200
                if ($r.ExitCode -ne 0) { return (& $fail '上传到异地存储（检查网络、存储地址、桶名和访问密钥）') }
            }
            $r = Invoke-AroomoSAHidden -Exe $paths.Rclone -Arguments @('lsf', '--files-only', $remote) -Env $renv -TimeoutSec 300
            if ($r.ExitCode -eq 0) {
                $names = @($r.Output -split "`r?`n" | Where-Object { $_ -match $script:BackupRegex })
                $keep = Select-AroomoSABackupsToKeep -Names $names -KeepLast ([int]$c['RETENTION_KEEP_LAST']) -Daily ([int]$c['RETENTION_KEEP_DAILY']) -Weekly ([int]$c['RETENTION_KEEP_WEEKLY']) -Monthly ([int]$c['RETENTION_KEEP_MONTHLY'])
                foreach ($n in $names) {
                    if ($keep -contains $n -or $n -eq $name) { continue }
                    [void](Invoke-AroomoSAHidden -Exe $paths.Rclone -Arguments @('deletefile', "$remote/$n") -Env $renv -TimeoutSec 300)
                    [void](Invoke-AroomoSAHidden -Exe $paths.Rclone -Arguments @('deletefile', "$remote/$($n -replace '\.tar\.(zst|gz)\.age$', '.meta.json')") -Env $renv -TimeoutSec 300)
                }
            }
            $res.Offsite = $true
        }
        $res.Ok = $true
        $res.DurationS = [int]((Get-Date) - $started).TotalSeconds
        return $res
    } finally {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tarFile, $plainTar, $partial -Force -ErrorAction SilentlyContinue
        $lobe = Get-AroomoSASpec $Context 'lobe'
        if (-not $pgWasRunning -and -not (Test-AroomoSAServiceHealthy -Spec $lobe -Paths $paths)) { Stop-AroomoSAService -Context $Context -Spec $pgSpec }
    }
}

function Restore-AroomoSABackup {
    # 从一份备份恢复（会覆盖现在的数据；调用方负责先征得同意）。主密钥只在内存里，临时写成只有当前用户能读的文件给 age 用，用完立刻删除。
    # 返回 [pscustomobject]@{ Ok; Step; Kept }（Kept = 恢复前的数据另存在哪里）
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][hashtable]$Context, [Parameter(Mandatory)][string]$File, [Parameter(Mandatory)][string]$Identity)
    $paths = $Context.Paths
    $res = [pscustomobject]@{ Ok = $false; Step = ''; Kept = $null }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $stage = Join-Path ([IO.Path]::GetTempPath()) ('aroomo-restore-{0}' -f [Guid]::NewGuid().ToString('N'))
    $idFile = [IO.Path]::Combine($paths.Config, ('restore-{0}.tmp' -f [Guid]::NewGuid().ToString('N')))
    $tarFile = "$stage.tar.packed"
    $plainTar = "$stage.tar"
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Write-AroomoPrivateFile -Path $idFile -Content ($Identity.Trim() + "`n")
        $r = Invoke-AroomoSAHidden -Exe $paths.Age -Arguments @('-d', '-i', $idFile, '-o', $tarFile, $File) -TimeoutSec 3600
        Remove-Item -LiteralPath $idFile -Force -ErrorAction SilentlyContinue
        if ($r.ExitCode -ne 0) { $res.Step = '解密（主密钥不对，或备份文件损坏）'; return $res }
        if ($File -match '\.tar\.zst\.age$') {
            # format 2（服务器和本机相同）：zstd
            $r = Invoke-AroomoSAHidden -Exe $paths.Zstd -Arguments @('-q', '-d', '-f', $tarFile, '-o', $plainTar) -TimeoutSec 3600
            if ($r.ExitCode -ne 0) { $res.Step = '解压备份（zstd）'; return $res }
            $r = Invoke-AroomoSAHidden -Exe (Get-AroomoSATar) -Arguments @('-xf', $plainTar, '-C', $stage) -TimeoutSec 3600
        } else {
            $r = Invoke-AroomoSAHidden -Exe (Get-AroomoSATar) -Arguments @('-xzf', $tarFile, '-C', $stage) -TimeoutSec 3600
        }
        if ($r.ExitCode -ne 0) { $res.Step = '解开备份'; return $res }
        $manifestPath = [IO.Path]::Combine($stage, 'backup-stage', 'manifest.json')
        if (-not (Test-Path -LiteralPath $manifestPath)) { $res.Step = '备份里没有清单'; return $res }
        $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
        $fmt = [string]$manifest.format
        if ($fmt -ne 'standalone-1' -and $fmt -ne [string]$script:BackupFormat) { $res.Step = "备份格式 $fmt 不认识"; return $res }
        # 服务器的备份（D79：服务器为主、本机热备，单向恢复）：没有 edition 字段
        $fromServer = ($fmt -ne 'standalone-1') -and (-not ($manifest.PSObject.Properties['edition']) -or $manifest.edition -ne 'standalone')
        $dataRoot = if ($fmt -eq 'standalone-1') { $stage } else { [IO.Path]::Combine($stage, 'data') }

        # 停掉除数据库以外的服务
        Stop-AroomoSAAll -Context $Context -Only @('shell', 'rsshub', 'karakeep-workers', 'karakeep', 'browser', 'meilisearch', 'lobe', 'core', 'litellm', 'rustfs', 'redis')
        # 配置：密钥用备份里的（数据库里的加密数据要靠它们打开）；端口、地址、备份设置保留这台电脑现在的
        $restoredEnv = [IO.Path]::Combine($dataRoot, 'secrets', 'aroomo.env')
        $current = $Context.Config
        $keepLocal = @{}
        if ($fromServer) {
            # 服务器的配置是 Docker 版的：只取「打开数据要用的密钥」，其余（端口、数据库密码、本机主人等）都用这台电脑现在的
            $dataKeys = @('KEY_VAULTS_SECRET', 'AUTH_SECRET', 'JWKS_KEY', 'LITELLM_SALT_KEY', 'LITELLM_MASTER_KEY', 'CORE_TOKEN_SECRET', 'CORE_OWNER_TOKEN', 'LOBE_LITELLM_VIRTUAL_KEY')
            $srv = if (Test-Path -LiteralPath $restoredEnv) { Read-AroomoEnv -Path $restoredEnv } else { @{} }
            foreach ($k in @($current.Keys)) { if ($dataKeys -notcontains $k -or -not $srv[$k]) { $keepLocal[$k] = $current[$k] } }
            foreach ($k in $dataKeys) { if ($srv[$k]) { $keepLocal[$k] = $srv[$k] } }
        } else {
            foreach ($k in @($current.Keys)) {
                if ($k -match '_PORT$' -or $k -in @('APP_URL', 'S3_ENDPOINT', 'BACKUP_AGE_RECIPIENT', 'BACKUP_HOST_TAG', 'BACKUP_LOCAL_KEEP') -or $k -like 'BACKUP_S3_*' -or $k -like 'RETENTION_*') { $keepLocal[$k] = $current[$k] }
            }
        }
        Copy-Item -LiteralPath $paths.EnvFile -Destination "$($paths.EnvFile).before-restore-$stamp"
        & icacls.exe "$($paths.EnvFile).before-restore-$stamp" /inheritance:r /grant:r "$env:USERDOMAIN\${env:USERNAME}:(F)" /grant:r 'SYSTEM:(F)' | Out-Null
        if ($fromServer) {
            Write-AroomoPrivateFile -Path $paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($paths.EnvFile)) -Values $keepLocal)
        } elseif (Test-Path -LiteralPath $restoredEnv) {
            Write-AroomoPrivateFile -Path $paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($restoredEnv)) -Values $keepLocal)
        }
        $newCfg = Read-AroomoEnv -Path $paths.EnvFile
        $problems = Get-AroomoSAEnvProblems -Config $newCfg
        if ($problems.Count -gt 0) {
            Copy-Item -LiteralPath "$($paths.EnvFile).before-restore-$stamp" -Destination $paths.EnvFile -Force
            $res.Step = "备份里的配置不完整（$($problems -join '；')）"
            return $res
        }
        # 数据库：用现在的 postgres 密码连接，逐个库删掉重建再导入
        if (-not (Start-AroomoSAService -Context $Context -Spec (Get-AroomoSASpec $Context 'postgres') -Quiet)) { $res.Step = '数据库没能启动'; return $res }
        $owners = @{ aroomo_core = 'aroomo_core'; litellm = 'litellm' }
        $r = Invoke-AroomoSAPsql -Context $Context -Sql (Get-AroomoSAInitSql -Config $Context.Config)
        if ($r.ExitCode -ne 0) { $res.Step = '准备数据库账号'; return $res }
        $pgEnv = @{ PGPASSWORD = $Context.Config['POSTGRES_PASSWORD']; PGCLIENTENCODING = 'UTF8' }
        $conn = @('-h', '127.0.0.1', '-p', $Context.Config['PG_PORT'], '-U', 'postgres')
        foreach ($db in @($manifest.databases)) {
            if ($db -notmatch '^[a-z_][a-z0-9_]*$') { continue }
            $dump = [IO.Path]::Combine($stage, 'backup-stage', 'db', "$db.dump")
            if (-not (Test-Path -LiteralPath $dump)) { $res.Step = "备份里缺少数据库 $db"; return $res }
            $owner = if ($owners.ContainsKey($db)) { $owners[$db] } else { 'postgres' }
            $r = Invoke-AroomoSAPsql -Context $Context -Sql "DROP DATABASE IF EXISTS $db WITH (FORCE);`nCREATE DATABASE $db OWNER $owner;"
            if ($r.ExitCode -ne 0) { $res.Step = "重建数据库 $db"; return $res }
            $restoreArgs = $conn + @('-d', $db, '--no-owner', '--exit-on-error')
            if ($owner -ne 'postgres') { $restoreArgs += @("--role=$owner") }
            # 服务器用 ParadeDB（pg_search、pg_cron），Windows 版 PostgreSQL 没有：从目录里去掉这些扩展和 bm25 索引（LobeHub 改用 pg_like，结果相同）
            $r = Invoke-AroomoSAHidden -Exe ([IO.Path]::Combine($paths.PgBin, 'pg_restore.exe')) -Arguments @('-l', $dump) -TimeoutSec 600
            if ($r.ExitCode -ne 0) { $res.Step = "读取数据库 $db 的目录"; return $res }
            $toc = @($r.Output -split "`r?`n" | Where-Object { $_ -notmatch '(?i)\b(pg_search|pg_cron|pg_stat_statements|bm25|paradedb)\b' })
            $listFile = [IO.Path]::Combine($stage, "$db.list")
            [IO.File]::WriteAllLines($listFile, $toc)
            $restoreArgs += @('-L', $listFile)
            $r = Invoke-AroomoSAHidden -Exe ([IO.Path]::Combine($paths.PgBin, 'pg_restore.exe')) -Arguments ($restoreArgs + @($dump)) -Env $pgEnv -TimeoutSec 7200
            if ($r.ExitCode -ne 0) {
                [IO.File]::WriteAllText([IO.Path]::Combine($paths.Logs, "restore-$db.log"), $r.Output)
                $res.Step = "导入数据库 $db（详细原因在 logs\restore-$db.log）"
                return $res
            }
        }
        $r = Invoke-AroomoSAPsql -Context $Context -Sql (Get-AroomoSAPasswordResetSql -Config $newCfg)
        if ($r.ExitCode -ne 0) { $res.Step = '更新数据库账号密码'; return $res }
        # 对象存储：现在的另存一份，再换成备份里的
        $restoredFiles = [IO.Path]::Combine($dataRoot, 'rustfs')
        if (Test-Path -LiteralPath $restoredFiles) {
            if (Test-Path -LiteralPath $paths.RustFSData) {
                $res.Kept = "$($paths.RustFSData).before-restore-$stamp"
                Move-Item -LiteralPath $paths.RustFSData -Destination $res.Kept
            }
            Move-Item -LiteralPath $restoredFiles -Destination $paths.RustFSData
        }
        # 收藏（Karakeep）：资料文件夹 + 一致的数据库副本；搜索索引（Meilisearch）不备份，清掉后由收藏重新建立
        $restoredK = [IO.Path]::Combine($dataRoot, 'karakeep')
        $restoredKdb = [IO.Path]::Combine($stage, 'backup-stage', 'karakeep-db.db')
        if ((Test-Path -LiteralPath $restoredK) -or (Test-Path -LiteralPath $restoredKdb)) {
            if (Test-Path -LiteralPath $paths.KarakeepData) { Move-Item -LiteralPath $paths.KarakeepData -Destination "$($paths.KarakeepData).before-restore-$stamp" }
            if (Test-Path -LiteralPath $restoredK) { Move-Item -LiteralPath $restoredK -Destination $paths.KarakeepData } else { New-Item -ItemType Directory -Path $paths.KarakeepData -Force | Out-Null }
            if (Test-Path -LiteralPath $restoredKdb) { Copy-Item -LiteralPath $restoredKdb -Destination ([IO.Path]::Combine($paths.KarakeepData, 'db.db')) -Force }
            if (Test-Path -LiteralPath $paths.MeiliData) { Move-Item -LiteralPath $paths.MeiliData -Destination "$($paths.MeiliData).before-restore-$stamp" }
        }
        $res.Ok = $true
        return $res
    } finally {
        Remove-Item -LiteralPath $idFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $tarFile, $plainTar -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 快捷方式（名称都带「独立版」，和 Docker 版的快捷方式不冲突）
# ---------------------------------------------------------------------------
function Get-AroomoSAShortcutSpecs {
    [OutputType([object[]])]
    param()
    return @(
        [pscustomobject]@{ Name = 'Aroomo 独立版'; Command = 'start'; Desktop = $true; Description = '启动 Aroomo 独立版并打开' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 停止'; Command = 'stop'; Desktop = $true; Description = '先备份，再停止（关机前请用它）' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 备份'; Command = 'backup'; Desktop = $false; Description = '立即备份（本机留 3 份；设置了异地备份时同时上传）' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 状态'; Command = 'status'; Desktop = $false; Description = '查看是否在运行' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 设置异地备份'; Command = 'offsite'; Desktop = $false; Description = '填写异地备份存储（与服务器同一个桶，独立目录）' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 恢复备份'; Command = 'restore'; Desktop = $false; Description = '用主密钥从备份恢复（会覆盖现在的数据）' },
        [pscustomobject]@{ Name = 'Aroomo 独立版 重新生成主密钥'; Command = 'masterkey'; Desktop = $false; Description = '更换主密钥（旧备份仍需旧主密钥打开）' }
    )
}

function Get-AroomoSAStartMenuDir {
    return (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aroomo 独立版')
}

function New-AroomoSAShortcuts {
    param([Parameter(Mandatory)][string]$AppDir)
    $script = [IO.Path]::Combine($AppDir, 'installer', 'standalone', 'aroomo-standalone.ps1')
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startMenu = Get-AroomoSAStartMenuDir
    $desktop = [Environment]::GetFolderPath('Desktop')
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    foreach ($s in (Get-AroomoSAShortcutSpecs)) {
        $targets = @(Join-Path $startMenu "$($s.Name).lnk")
        if ($s.Desktop) { $targets += (Join-Path $desktop "$($s.Name).lnk") }
        foreach ($t in $targets) {
            $lnk = $shell.CreateShortcut($t)
            $lnk.TargetPath = $psExe
            $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" $($s.Command)"
            $lnk.WorkingDirectory = $AppDir
            $lnk.Description = $s.Description
            $icon = [IO.Path]::Combine($AppDir, 'installer', 'standalone', 'aroomo.ico')
            if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon }
            $lnk.Save()
        }
    }
}

function Remove-AroomoSAShortcuts {
    param()
    $desktop = [Environment]::GetFolderPath('Desktop')
    foreach ($s in (Get-AroomoSAShortcutSpecs)) {
        $p = Join-Path $desktop "$($s.Name).lnk"
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    $sm = Get-AroomoSAStartMenuDir
    if (Test-Path -LiteralPath $sm) { Remove-Item -LiteralPath $sm -Recurse -Force }
}

$script:BootTaskName = 'Aroomo 独立版 开机备份'
$script:BootTaskPath = '\Aroomo\'

function Register-AroomoSABootBackup {
    # D65：每次登录 Windows 后约 2 分钟备份一次。返回 task | startup
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$AppDir)
    $script = [IO.Path]::Combine($AppDir, 'installer', 'standalone', 'aroomo-standalone.ps1')
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`" boot-backup -NoPause"
    try {
        $user = "$env:USERDOMAIN\$env:USERNAME"
        $action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $AppDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $trigger.Delay = 'PT2M'
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
        Register-ScheduledTask -TaskName $script:BootTaskName -TaskPath $script:BootTaskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'D65：每次登录 Windows 后备份一次 Aroomo 独立版' -Force -ErrorAction Stop | Out-Null
        return 'task'
    } catch {
        Write-Verbose "无法创建计划任务，改用启动文件夹：$($_.Exception.Message)"
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) "$($script:BootTaskName).lnk"))
        $lnk.TargetPath = $psExe
        $lnk.Arguments = $arguments
        $lnk.WorkingDirectory = $AppDir
        $lnk.WindowStyle = 7
        $lnk.Save()
        return 'startup'
    }
}

function Unregister-AroomoSABootBackup {
    param()
    try { Unregister-ScheduledTask -TaskName $script:BootTaskName -TaskPath $script:BootTaskPath -Confirm:$false -ErrorAction Stop } catch { Write-Verbose '没有计划任务' }
    $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$($script:BootTaskName).lnk"
    if (Test-Path -LiteralPath $lnk) { Remove-Item -LiteralPath $lnk -Force }
}

Export-ModuleMember -Function *-AroomoSA*
