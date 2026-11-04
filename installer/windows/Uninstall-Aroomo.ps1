<#
.SYNOPSIS
  卸载 Aroomo 本地版。默认保留全部数据（数据库、上传的文件、备份、配置）。

.DESCRIPTION
  默认：停止并移除 Aroomo 的容器、删除快捷方式；Docker 数据卷、数据文件夹和配置都保留，重新安装后接着用。
  -RemoveData：同时删除 Docker 数据卷和数据文件夹（不可恢复，会再确认一次）。
  Docker Desktop 和 WSL2 不会被卸载。
  文件必须保存为 UTF-8 带 BOM。
#>
[CmdletBinding()]
param(
    [string]$AppDir,
    [switch]$RemoveData,
    [switch]$Confirmed,
    [switch]$Unattended
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose '无法设置控制台编码' }
Import-Module (Join-Path $PSScriptRoot 'Aroomo.psm1') -Force

if (-not $AppDir) { $AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$deploy = Join-Path $AppDir 'deploy'
$envPath = Join-Path $deploy '.env'
$info = Get-AroomoInstallInfo

if ($RemoveData -and -not $Confirmed) {
    $msg = "确定要删除 Aroomo 的全部数据吗？`n包括对话、成员、上传的文件和本机备份。删除后无法恢复。"
    if (-not (Show-AroomoQuestion -Text $msg -Default $false -Unattended:$Unattended)) {
        Write-AroomoSay '已取消删除数据，只卸载程序。'
        $RemoveData = $false
    }
}

if ((Test-Path -LiteralPath $envPath) -and (Test-AroomoDockerReady)) {
    $cfg = Read-AroomoEnv -Path $envPath
    $tier = if ($cfg.ContainsKey('AROOMO_TIER') -and $cfg['AROOMO_TIER']) { $cfg['AROOMO_TIER'] } else { 'standard' }
    $downArgs = @('--profile', 'backup', '--profile', 'restore', 'down', '--remove-orphans')
    if ($RemoveData) { $downArgs += '-v' }
    Write-AroomoSay '正在停止并移除 Aroomo 的容器。'
    [void](Invoke-AroomoCompose -DeployDir $deploy -Tier $tier -Arguments $downArgs)
} else {
    Write-AroomoSay 'Docker 没有运行，跳过容器清理。数据卷保持不变。'
}

Remove-AroomoShortcuts
Unregister-AroomoResume
Unregister-AroomoBootBackup

if ($RemoveData) {
    if ($info.DataDir -and (Test-Path -LiteralPath $info.DataDir)) {
        Remove-Item -LiteralPath $info.DataDir -Recurse -Force
    }
    if (Test-Path 'HKCU:\Software\Aroomo') { Remove-Item -Path 'HKCU:\Software\Aroomo' -Recurse -Force }
    Write-AroomoSay 'Aroomo 和它的全部数据已删除。Docker Desktop 没有卸载。'
} else {
    $where = if ($info.DataDir) { $info.DataDir } else { '数据文件夹' }
    Write-AroomoSay "Aroomo 已卸载。数据都保留着：配置和备份在 $where，数据库在 Docker 里。`n重新安装后会自动接着用。"
}
exit 0
