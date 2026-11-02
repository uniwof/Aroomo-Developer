<#
.SYNOPSIS
  Aroomo 本机执行员：简化版自动更新（拉取最新代码，有变化才重建并重启）。
.DESCRIPTION
  只做四件事：git pull --ff-only；有新提交才 npm ci + build；检查配置；重启计划任务。
  不碰配置和令牌，不改任何 Windows 设置。失败时保留旧版本继续运行。
  日常由安装脚本注册的「Aroomo Executor Update」计划任务每天自动运行，也可手动运行：
  powershell -ExecutionPolicy Bypass -File executor\scripts\update-windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$NoRestart,
  [string]$TaskName = 'Aroomo Executor'
)

$ErrorActionPreference = 'Stop'
$executorDir = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Output "==> $Text" }

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { Write-Step '没有 git，跳过更新'; exit 0 }

Push-Location $executorDir
try {
  & git symbolic-ref -q HEAD | Out-Null
  if ($LASTEXITCODE -ne 0) { Write-Step '不在分支上（可能是下载的压缩包），跳过更新'; exit 0 }
  $before = (& git rev-parse HEAD).Trim()
  & git pull --ff-only --quiet
  if ($LASTEXITCODE -ne 0) { Write-Step '拉取失败（网络或本地有改动），继续使用旧版本'; exit 0 }
  $after = (& git rev-parse HEAD).Trim()
  if ($before -eq $after) { Write-Step '已经是最新'; exit 0 }

  Write-Step '有新版本，重新构建'
  & npm ci --no-audit --no-fund | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
  & npm run build | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '构建失败' }
  & node (Join-Path $executorDir 'dist\cli.js') check
  if ($LASTEXITCODE -ne 0) { throw '更新后检查没通过' }
} catch {
  # 构建失败时回到原提交，旧版 dist 不受影响（tsc 失败不会清空 dist）
  if ($before) { & git reset --hard $before | Out-Null }
  Write-Output "更新失败，已回到旧版本：$($_.Exception.Message)"
  exit 1
} finally { Pop-Location }

if (-not $NoRestart) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Write-Step '重启本机执行员'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $TaskName
  }
}
Write-Step '更新完成'
