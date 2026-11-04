<#
.SYNOPSIS
  Aroomo Windows 本地版的启动 / 停止 / 更新 / 备份 / 状态 / 打开。桌面快捷方式调用的就是它。

.DESCRIPTION
  使用与服务器相同的 Compose 文件（等同 scripts/compose.sh 的 AROOMO_LOCAL=1），再叠加 deploy/local-backup.yml。
    aroomo.ps1 start        启动并打开浏览器
    aroomo.ps1 stop         先备份，再停止（数据保留）。关机前请用它（DECISIONS D65）
    aroomo.ps1 update       先备份；备份成功才拉取新镜像并重启（PRODUCT §10.2 O1、D65）
    aroomo.ps1 backup       立即备份：本机数据文件夹的 backups 留最近 3 份；设置了异地存储时同时上传到 pc/<电脑名>/
    aroomo.ps1 boot-backup  登录 Windows 后由计划任务自动运行（D65「开机后备份一次」）
    aroomo.ps1 offsite      设置异地备份存储（与服务器同一个桶）
    aroomo.ps1 masterkey    重新生成主密钥（D64）
    aroomo.ps1 status       查看运行状态
    aroomo.ps1 open         在浏览器里打开
  文件必须保存为 UTF-8 带 BOM。
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'NoBrowser', Justification = '在内部函数里使用')]
[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('start', 'stop', 'update', 'backup', 'boot-backup', 'offsite', 'masterkey', 'status', 'open')][string]$Command = 'start',
    [string]$AppDir,
    [switch]$NoBrowser,
    [switch]$NoPause,
    [switch]$Speak
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose '无法设置控制台编码' }
Import-Module (Join-Path $PSScriptRoot 'Aroomo.psm1') -Force
Set-AroomoSpeech -Enabled $Speak.IsPresent

if (-not $AppDir) { $AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$deploy = Join-Path $AppDir 'deploy'
$envPath = Join-Path $deploy '.env'
if ($Command -eq 'boot-backup') { $NoPause = $true }

function Exit-Aroomo {
    param([int]$Code)
    if (-not $NoPause -and [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost') {
        Write-Host ''
        Read-Host '按回车键关闭这个窗口' | Out-Null
    }
    exit $Code
}

if ($Command -eq 'boot-backup') {
    $logDir = Join-Path $env:LOCALAPPDATA 'Aroomo\logs'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    try { Start-Transcript -Path (Join-Path $logDir ("boot-backup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) | Out-Null } catch { Write-Verbose '无法记录日志' }
}

if (-not (Test-Path -LiteralPath $envPath)) {
    Write-AroomoSay '还没有安装完成：找不到配置文件。请先运行 Aroomo 安装程序。'
    Exit-Aroomo 2
}
$cfg = Read-AroomoEnv -Path $envPath
$tier = if ($cfg.ContainsKey('AROOMO_TIER') -and $cfg['AROOMO_TIER']) { $cfg['AROOMO_TIER'] } else { 'standard' }
$port = if ($cfg.ContainsKey('LOBE_PORT') -and $cfg['LOBE_PORT']) { $cfg['LOBE_PORT'] } else { '3210' }
$url = "http://localhost:$port"
$info = Get-AroomoInstallInfo
$canonical = if ($info.DataDir) { Join-Path $info.DataDir 'config\aroomo.env' } else { $null }

function Invoke-DC {
    param([string[]]$Arguments)
    return (Invoke-AroomoCompose -DeployDir $deploy -Tier $tier -Arguments $Arguments)
}

function Assert-Docker {
    param([int]$TimeoutSec = 300)
    if (-not (Start-AroomoDocker -TimeoutSec $TimeoutSec)) {
        Write-AroomoSay "Docker Desktop 没有运行，也没能自动打开。`n请从开始菜单打开 Docker Desktop，等它显示已运行后再试一次。"
        Exit-Aroomo 3
    }
}

function Test-ServiceRunning {
    param([string]$Service)
    $base = Get-AroomoComposeArgs -DeployDir $deploy -Tier $tier
    $id = & docker @base ps --status running -q $Service 2>$null
    return [bool]($id)
}

function Start-AroomoApp {
    Assert-Docker
    Write-AroomoSay '正在启动 Aroomo。'
    if ((Invoke-DC @('up', '-d', '--remove-orphans')) -ne 0) {
        Write-AroomoSay '启动失败。上面几行是出错信息。可以稍后再试，或把日志发给主程序员。'
        return $false
    }
    Write-AroomoSay '程序已启动，正在等待界面就绪。'
    if (-not (Wait-AroomoReady -Url $url -TimeoutSec 1800)) {
        Write-AroomoSay "等了 30 分钟界面还没就绪。可以过一会儿运行「Aroomo 打开」再看看。"
        return $false
    }
    Write-AroomoSay "Aroomo 已就绪：$url"
    if (-not $NoBrowser) { Start-Process $url }
    return $true
}

function Invoke-AroomoBackup {
    # 返回 $true = 备份成功。备份会自动启动数据库（如果没在运行），完成后恢复原状。
    param([string]$Reason = '')
    Assert-Docker -TimeoutSec 600
    if (-not (Test-AroomoAgeRecipient $cfg['BACKUP_AGE_RECIPIENT'])) {
        Write-AroomoSay "还没有主密钥，备份不能加密，所以没有备份。`n请从开始菜单运行「Aroomo 重新生成主密钥」，保存好主密钥后再备份。"
        return $false
    }
    $hasOffsite = [bool]($cfg['BACKUP_S3_ENDPOINT'] -and $cfg['BACKUP_S3_BUCKET'])
    $where = if ($hasOffsite) { '数据文件夹的 backups（留最近 3 份），并上传到异地存储' } else { '数据文件夹的 backups（留最近 3 份）' }
    Write-AroomoSay "正在备份$Reason。会加密后保存到$where。"
    $pgWasRunning = Test-ServiceRunning 'postgres'
    $base = Get-AroomoComposeArgs -DeployDir $deploy -Tier $tier
    $lines = & docker @base --profile backup run --rm -T backup now
    $code = $LASTEXITCODE
    if (-not $pgWasRunning -and -not (Test-ServiceRunning 'lobe')) { & docker @base stop postgres *> $null }
    $last = @($lines | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
    $result = $null
    if ($last.Count -gt 0) { try { $result = $last[0] | ConvertFrom-Json } catch { $result = $null } }
    if ($code -eq 0 -and $result -and $result.status -eq 'ok') {
        Write-AroomoSay ("备份完成，用时 {0} 秒。本机现在有 {1} 份备份。" -f $result.duration_s, $result.local_count)
        if ($result.offsite) {
            Write-AroomoSay '已上传到异地存储。'
        } else {
            Write-AroomoSay "注意：还没有设置异地备份。这份备份只在这台电脑上，硬盘坏了会一起丢。`n可以从开始菜单运行「Aroomo 设置异地备份」。"
        }
        return $true
    }
    $why = if ($result -and $result.step) { $result.step } else { '原因见上面的输出' }
    Write-AroomoSay "备份失败：$why"
    return $false
}

function Set-AroomoOffsite {
    Write-AroomoSay "设置异地备份（D65）。和服务器用同一个异地存储，这台电脑的备份放在单独的目录：$(Get-AroomoPcBackupPrefix)。`n需要四样东西：存储地址、桶名、访问密钥 ID、访问密钥。可以请主程序员提供（用 Hark 的安全表单，不要发在聊天里）。`n直接按回车可以取消。"
    $endpoint = (Read-Host '存储地址（例如 https://xxxx.r2.cloudflarestorage.com）').Trim()
    if (-not $endpoint) { Write-AroomoSay '已取消。'; return $true }
    if ($endpoint -notmatch '^https?://[^\s''"]+$') { Write-AroomoSay '地址格式不对，应以 https:// 开头。没有保存。'; return $false }
    $bucket = (Read-Host '桶名').Trim()
    if ($bucket -notmatch '^[a-z0-9][a-z0-9.-]{1,62}$') { Write-AroomoSay '桶名格式不对。没有保存。'; return $false }
    $keyId = (Read-Host '访问密钥 ID').Trim()
    $secure = Read-Host '访问密钥（输入时不显示）' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $region = (Read-Host '区域（Cloudflare R2 直接按回车，即 auto）').Trim()
    if (-not $region) { $region = 'auto' }
    if (-not $keyId -or -not $secret -or $keyId.Contains("'") -or $secret.Contains("'")) { Write-AroomoSay '访问密钥不完整或含有单引号。没有保存。'; return $false }
    $values = @{
        BACKUP_S3_ENDPOINT          = $endpoint
        BACKUP_S3_BUCKET            = $bucket
        BACKUP_S3_ACCESS_KEY_ID     = $keyId
        BACKUP_S3_SECRET_ACCESS_KEY = $secret
        BACKUP_S3_REGION            = $region
        BACKUP_S3_PREFIX            = (Get-AroomoPcBackupPrefix)
    }
    foreach ($p in @($envPath, $canonical)) {
        if (-not $p) { continue }
        $content = if (Test-Path -LiteralPath $p) { [IO.File]::ReadAllText($p) } else { '' }
        Write-AroomoPrivateFile -Path $p -Content (Set-AroomoEnvValues -Content $content -Values $values)
    }
    $secret = $null
    $script:cfg = Read-AroomoEnv -Path $envPath
    Write-AroomoSay '已保存。现在备份一次，检查能不能上传。'
    return (Invoke-AroomoBackup)
}

$ok = $true
switch ($Command) {
    'start' { $ok = Start-AroomoApp }
    'stop' {
        Assert-Docker
        # D65：停止（关机）前先备份；备份失败也照常停止，但明确告诉用户
        $backedUp = $true
        if (Test-ServiceRunning 'postgres') { $backedUp = Invoke-AroomoBackup -Reason '（停止前）' }
        Write-AroomoSay '正在停止 Aroomo。数据会保留。'
        $ok = ((Invoke-DC @('stop')) -eq 0)
        if ($ok) { Write-AroomoSay 'Aroomo 已停止。现在可以关机了。' }
        if (-not $backedUp) { Write-AroomoSay '提醒：这次停止前的备份没有成功，最近的一份备份是之前的。'; $ok = $false }
    }
    'backup' { $ok = Invoke-AroomoBackup }
    'boot-backup' {
        # 登录后自动运行：等 Docker Desktop 起来（最多 10 分钟），备份一次。失败只记日志，不弹窗打扰。
        Write-AroomoSay '登录后自动备份（D65）。'
        if (-not (Start-AroomoDocker -TimeoutSec 600)) { Write-AroomoSay 'Docker Desktop 没有启动，这次跳过开机备份。'; Exit-Aroomo 3 }
        $ok = Invoke-AroomoBackup -Reason '（开机后）'
    }
    'offsite' { $ok = Set-AroomoOffsite }
    'masterkey' {
        Write-AroomoSay "重新生成主密钥。`n旧的备份仍然只能用旧主密钥打开，旧主密钥请继续保留，直到旧备份都被新的替换（本机 3 份，异地按保留策略）。`n新主密钥生成后，记得把新的公钥发给主程序员，换到服务器上。"
        $paths = @($envPath)
        if ($canonical) { $paths = @($canonical, $envPath) }
        $r = Invoke-AroomoMasterKeySetup -AppDir $AppDir -EnvPaths $paths -DataDir $info.DataDir -Force
        switch ($r) {
            'created' { Write-AroomoSay '新主密钥已保存，公钥已写入配置。现在备份一次。'; $script:cfg = Read-AroomoEnv -Path $envPath; $ok = Invoke-AroomoBackup }
            'cancelled' { Write-AroomoSay '没有保存新主密钥，配置没有改动，继续使用原来的主密钥。'; $ok = $false }
            default { Write-AroomoSay '找不到密钥生成程序（age-keygen.exe）。请重新运行 Aroomo 安装包修复。'; $ok = $false }
        }
    }
    'update' {
        Write-AroomoSay '更新前先备份。备份不成功就不会更新。'
        if (-not (Invoke-AroomoBackup -Reason '（更新前）')) {
            Write-AroomoSay '为了安全，这次没有更新。'
            Exit-Aroomo 4
        }
        Write-AroomoSay '正在下载新版本。'
        $ok = ((Invoke-DC @('pull', '--ignore-buildable')) -eq 0)
        if ($ok) { $ok = ((Invoke-DC @('build', '--pull')) -eq 0) }
        if ($ok) { $ok = Start-AroomoApp }
        if (-not $ok) { Write-AroomoSay '更新没有成功。数据已在更新前备份。可以把日志发给主程序员。' }
    }
    'status' {
        Assert-Docker
        Invoke-DC @('ps', '--format', 'table {{.Service}}\t{{.State}}\t{{.Health}}') | Out-Null
        if (Wait-AroomoReady -Url $url -TimeoutSec 5) { Write-AroomoSay "Aroomo 正在运行：$url" } else { Write-AroomoSay 'Aroomo 现在没有运行。双击「Aroomo 启动」可以启动。' }
        $backups = if ($info.DataDir) { @(Get-ChildItem -Path (Join-Path $info.DataDir 'backups') -Filter 'aroomo-*.tar.zst.age' -ErrorAction SilentlyContinue | Sort-Object Name) } else { @() }
        if ($backups.Count -gt 0) { Write-AroomoSay ("本机有 {0} 份备份，最新一份：{1}。" -f $backups.Count, $backups[-1].LastWriteTime.ToString('yyyy-MM-dd HH:mm')) } else { Write-AroomoSay '本机还没有备份。' }
    }
    'open' { Start-Process $url; Write-AroomoSay "已在浏览器打开 $url" }
}

if ($Command -eq 'boot-backup') { try { Stop-Transcript | Out-Null } catch { Write-Verbose '日志未开启' } }
if ($ok) { Exit-Aroomo 0 } else { Exit-Aroomo 1 }
