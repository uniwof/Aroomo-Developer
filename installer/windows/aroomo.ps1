<#
.SYNOPSIS
  Aroomo Windows 本地版的启动 / 停止 / 更新 / 备份 / 状态 / 打开。桌面快捷方式调用的就是它。

.DESCRIPTION
  使用与服务器相同的 Compose 文件（等同 scripts/compose.sh 的 AROOMO_LOCAL=1），再叠加 deploy/local-backup.yml。
    aroomo.ps1 start    启动并打开浏览器
    aroomo.ps1 stop     停止（数据保留）
    aroomo.ps1 update   先备份；备份成功才拉取新镜像并重启（PRODUCT §10.2 O1）
    aroomo.ps1 backup   立即备份到数据文件夹的 backups 子文件夹
    aroomo.ps1 status   查看运行状态
    aroomo.ps1 open     在浏览器里打开
  文件必须保存为 UTF-8 带 BOM。
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'NoBrowser', Justification = '在内部函数里使用')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', 'NoPause', Justification = '在内部函数里使用')]
[CmdletBinding()]
param(
    [Parameter(Position = 0)][ValidateSet('start', 'stop', 'update', 'backup', 'status', 'open')][string]$Command = 'start',
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

function Exit-Aroomo {
    param([int]$Code)
    if (-not $NoPause -and [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost') {
        Write-Host ''
        Read-Host '按回车键关闭这个窗口' | Out-Null
    }
    exit $Code
}

if (-not (Test-Path -LiteralPath $envPath)) {
    Write-AroomoSay '还没有安装完成：找不到配置文件。请先运行 Aroomo 安装程序。'
    Exit-Aroomo 2
}
$cfg = Read-AroomoEnv -Path $envPath
$tier = if ($cfg.ContainsKey('AROOMO_TIER') -and $cfg['AROOMO_TIER']) { $cfg['AROOMO_TIER'] } else { 'standard' }
$port = if ($cfg.ContainsKey('LOBE_PORT') -and $cfg['LOBE_PORT']) { $cfg['LOBE_PORT'] } else { '3210' }
$url = "http://localhost:$port"

function Invoke-DC {
    param([string[]]$Arguments)
    return (Invoke-AroomoCompose -DeployDir $deploy -Tier $tier -Arguments $Arguments)
}

function Assert-Docker {
    if (-not (Start-AroomoDocker -TimeoutSec 300)) {
        Write-AroomoSay "Docker Desktop 没有运行，也没能自动打开。`n请从开始菜单打开 Docker Desktop，等它显示已运行后再试一次。"
        Exit-Aroomo 3
    }
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
    Assert-Docker
    Write-AroomoSay '正在备份。数据库和上传的文件会备份到数据文件夹的 backups 子文件夹。'
    $base = Get-AroomoComposeArgs -DeployDir $deploy -Tier $tier
    $lines = & docker @base --profile backup run --rm -T backup now
    $code = $LASTEXITCODE
    $last = @($lines | Where-Object { $_ -match '^\{' } | Select-Object -Last 1)
    $result = $null
    if ($last.Count -gt 0) { try { $result = $last[0] | ConvertFrom-Json } catch { $result = $null } }
    if ($code -eq 0 -and $result -and $result.status -eq 'ok') {
        Write-AroomoSay ("备份完成，用时 {0} 秒。" -f $result.duration_s)
        return $true
    }
    $why = if ($result -and $result.step) { $result.step } else { '原因见上面的输出' }
    Write-AroomoSay "备份失败：$why"
    return $false
}

$ok = $true
switch ($Command) {
    'start' { $ok = Start-AroomoApp }
    'stop' {
        Assert-Docker
        Write-AroomoSay '正在停止 Aroomo。数据会保留。'
        $ok = ((Invoke-DC @('stop')) -eq 0)
        if ($ok) { Write-AroomoSay 'Aroomo 已停止。' }
    }
    'backup' { $ok = Invoke-AroomoBackup }
    'update' {
        Write-AroomoSay '更新前先备份。备份不成功就不会更新。'
        if (-not (Invoke-AroomoBackup)) {
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
    }
    'open' { Start-Process $url; Write-AroomoSay "已在浏览器打开 $url" }
}

if ($ok) { Exit-Aroomo 0 } else { Exit-Aroomo 1 }
