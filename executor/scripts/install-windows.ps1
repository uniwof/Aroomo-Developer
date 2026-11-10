<#
.SYNOPSIS
  Aroomo 本机执行员 Windows 安装脚本（不需要管理员）。

.DESCRIPTION
  1. 检查 Node.js 22+；
  2. 在 executor 目录 npm ci + 构建；
  3. 生成配置 %APPDATA%\Aroomo\executor\config.json（白名单为空，保守默认）；
  4. 保存设备令牌：从环境变量 AROOMO_EXECUTOR_TOKEN 读取，或让你在本机安全输入（不显示、不进历史），
     写到 device-token 并收紧权限为只有当前用户可读；
  5. 经公网连 Core 时（#365）：凭据文件（-BootstrapFile）或环境变量 AROOMO_CF_ACCESS_CLIENT_ID / AROOMO_CF_ACCESS_CLIENT_SECRET 给了 Service Token，
     把 Cloudflare Access Service Token 存好（Secret 用 Windows DPAPI 加密，只写 Client ID 进配置；Secret 走标准输入，不进命令行）；
  6. 注册「登录后自动运行」计划任务（-NoAutostart 跳过），运行身份为当前用户（不是系统账户）。
  远程安装：-BootstrapFile <JSON 文件>（deviceToken / cfClientId / cfClientSecret），读完即删；不要在交互式 PowerShell 里敲 $env:...= 秘密（会进 PSReadLine 历史）。
  不停止、不卸载任何 Docker / WSL；不修改系统设置。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File executor\scripts\install-windows.ps1
#>
[CmdletBinding()]
param(
  [switch]$NoAutostart,
  [switch]$NoAutoUpdate,
  [switch]$SkipToken,
  [string]$TaskName = 'Aroomo Executor',
  # 远程安装（#376 M7）：凭据放在一个 JSON 文件里传过来（远程通道拷文件，不在交互式 PowerShell 里敲），读完即覆盖并删除。
  # 字段：deviceToken、cfClientId、cfClientSecret（都可省）。命令行里只有文件路径，没有任何秘密。
  [string]$BootstrapFile
)

$ErrorActionPreference = 'Stop'
# 读屏友好：控制台改 UTF-8，node 输出的中文才不会乱码（Windows PowerShell 5.1 默认是 GBK/OEM 代码页）
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { Write-Verbose "无法设置控制台编码：$($_.Exception.Message)" }
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

# 凭据文件（远程非交互安装）：读完立刻覆盖为零并删除，内容不留在磁盘上
$cred = $null
if ($BootstrapFile) {
  if (-not (Test-Path -LiteralPath $BootstrapFile)) { throw '凭据文件不存在' }
  try {
    $cred = Get-Content -LiteralPath $BootstrapFile -Raw -Encoding UTF8 | ConvertFrom-Json
  } finally {
    $len = (Get-Item -LiteralPath $BootstrapFile).Length
    [IO.File]::WriteAllBytes($BootstrapFile, (New-Object byte[] $len))
    Remove-Item -LiteralPath $BootstrapFile -Force
  }
}

# 4. 设备令牌（凭据文件 > 环境变量 > 本机安全输入；给了凭据文件就不再弹输入）
if (-not $SkipToken) {
  $plain = if ($cred -and $cred.deviceToken) { [string]$cred.deviceToken } else { $env:AROOMO_EXECUTOR_TOKEN }
  if (-not $plain -and -not $BootstrapFile) {
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

# 5. Cloudflare Access Service Token（#365：经公网连 Core 才需要；远程安装用凭据文件传入，所有者不用粘贴）
$cfId = if ($cred -and $cred.cfClientId) { [string]$cred.cfClientId } else { $env:AROOMO_CF_ACCESS_CLIENT_ID }
$cfSecret = if ($cred -and $cred.cfClientSecret) { [string]$cred.cfClientSecret } else { $env:AROOMO_CF_ACCESS_CLIENT_SECRET }
$cred = $null
if ($cfId -and $cfSecret) {
  $cfSecret | & node $cli cf-access $cfId
  $cfSecret = $null
  if ($LASTEXITCODE -ne 0) { throw '保存 Cloudflare Access 凭据失败' }
  Remove-Item Env:\AROOMO_CF_ACCESS_CLIENT_SECRET -ErrorAction SilentlyContinue
  Write-Step 'Cloudflare Access 凭据已保存（密钥已加密，只有当前用户能解开）'
} elseif ($cfId) {
  Write-Step '只设了 Client ID，没有密钥：跳过 Cloudflare Access（稍后可重新运行本脚本）'
}

# 6. 开机（登录后）自启
if (-not $NoAutostart) {
  Write-Step "注册计划任务「$TaskName」"
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$cli`" run" -WorkingDirectory $executorDir
  # 登录时启动；另加每 5 分钟一次的触发器：进程崩了/被结束后自动拉起（已在运行时忽略新实例，不会重复）
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $keepAlive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  # 运行身份 = 当前用户、仅登录时（#376 M5）：DPAPI 按「当前用户」加密，换成系统账户运行就解不开 Secret
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $keepAlive) -Settings $settings -Principal $principal -Description 'Aroomo 本机执行员' -Force | Out-Null

  if (-not $NoAutoUpdate) {
    # 简化版自动更新：每天 04:00（错过则开机后补跑）拉取最新代码，有变化才重建并重启
    Write-Step '注册每日自动更新'
    $updScript = Join-Path $PSScriptRoot 'update-windows.ps1'
    $updAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$updScript`" -TaskName `"$TaskName`""
    $updTrigger = New-ScheduledTaskTrigger -Daily -At '04:00'
    $updSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "$TaskName Update" -Action $updAction -Trigger $updTrigger -Settings $updSettings -Principal $principal -Description 'Aroomo 本机执行员自动更新' -Force | Out-Null
  }
}

Write-Step '检查'
& node $cli check
Write-Output ''
Write-Output "下一步：编辑 $configDir\config.json，在 allowlist.sites 里加允许操作的网站，然后重新登录 Windows（或运行：Start-ScheduledTask -TaskName '$TaskName'）。"
