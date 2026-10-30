<#
.SYNOPSIS
  Aroomo 本机执行员 Windows 安装脚本（不需要管理员）。

.DESCRIPTION
  1. 检查 Node.js 22+；
  2. 在 executor 目录 npm ci + 构建；
  3. 生成配置 %APPDATA%\Aroomo\executor\config.json（白名单为空，保守默认）；
  4. 保存设备令牌：从环境变量 AROOMO_EXECUTOR_TOKEN 读取，或让你在本机安全输入（不显示、不进历史），
     写到 device-token 并收紧权限为只有当前用户可读；
  5. 注册「登录后自动运行」计划任务（-NoAutostart 跳过）。
  不停止、不卸载任何 Docker / WSL；不修改系统设置。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File executor\scripts\install-windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$NoAutostart,
  [switch]$SkipToken,
  [string]$TaskName = 'Aroomo Executor'
)

$ErrorActionPreference = 'Stop'
$executorDir = Split-Path -Parent $PSScriptRoot

function Write-Step([string]$Text) { Write-Output "==> $Text" }

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '没有找到 Node.js。请先安装 Node.js 22 LTS（https://nodejs.org/）后重新运行。' }
# 不用 node -p "...": Windows PowerShell 5.1 调原生程序时会吞掉参数里的双引号
$major = [int](((& node --version) -replace '[^0-9.]', '').Split('.')[0])
if ($major -lt 22) { throw "Node.js 版本过低（$major），需要 22 或更高。" }
Write-Step "Node.js $major 已就绪"

# 2. 构建
Push-Location $executorDir
try {
  Write-Step '安装依赖并构建'
  & npm ci --no-audit --no-fund | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
  & npm run build | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '构建失败' }
} finally { Pop-Location }
$cli = Join-Path $executorDir 'dist\cli.js'

# 3. 配置
Write-Step '生成配置'
& node $cli init
if ($LASTEXITCODE -ne 0) { throw '生成配置失败' }
$configDir = if ($env:AROOMO_EXECUTOR_CONFIG) { Split-Path -Parent $env:AROOMO_EXECUTOR_CONFIG } else { Join-Path $env:APPDATA 'Aroomo\executor' }
$tokenFile = Join-Path $configDir 'device-token'

# 4. 设备令牌
if (-not $SkipToken) {
  $plain = $env:AROOMO_EXECUTOR_TOKEN
  if (-not $plain) {
    $secure = Read-Host -AsSecureString '请粘贴控制台「本机执行员」页生成的令牌（输入时不显示）'
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if ($plain) {
    [IO.File]::WriteAllText($tokenFile, $plain.Trim(), (New-Object Text.UTF8Encoding $false))
    $plain = $null
    & icacls $tokenFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Write-Step '令牌已保存（只有当前用户可读）'
  } else {
    Write-Step '没有输入令牌，稍后可重新运行本脚本'
  }
}

# 5. 开机（登录后）自启
if (-not $NoAutostart) {
  Write-Step "注册计划任务「$TaskName」"
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$cli`" run" -WorkingDirectory $executorDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Aroomo 本机执行员' -Force | Out-Null
}

Write-Step '检查'
& node $cli check
Write-Output ''
Write-Output "下一步：编辑 $configDir\config.json，在 allowlist.sites 里加允许操作的网站，然后重新登录 Windows（或运行：Start-ScheduledTask -TaskName '$TaskName'）。"
