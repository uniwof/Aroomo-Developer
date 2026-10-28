<#
.SYNOPSIS
  Aroomo Windows 本地版一键安装（Windows 10 22H2+ / 11）。

.DESCRIPTION
  依次：检查 Windows 版本 → 检查内存和磁盘 → 检查虚拟化 → 启用 WSL2（需要时重启，重启后自动继续）
  → 安装并启动 Docker Desktop → 选择数据文件夹 → 按内存选档位 → 在本机生成 .env（随机密钥，不显示）
  → 离线生成主密钥（D64：一次性显示，用户点「已保存」后才继续；只把公钥写进配置）
  → 创建快捷方式和「登录后备份」（D65）→ 第一次启动并打开浏览器。
  和服务器使用同一套 Compose 文件（另加 deploy/local.yml、deploy/local-backup.yml）。
  文件必须保存为 UTF-8 带 BOM。

.PARAMETER AppDir      程序所在文件夹（默认：本脚本上两级，即仓库根目录或安装目录）。
.PARAMETER DataDir     数据文件夹（不填则询问；默认选剩余空间最大的非系统盘）。
.PARAMETER Unattended  无人值守：不弹对话框，全部用默认答案（不会自动重启）。
.PARAMETER Speak       用 Windows 语音朗读每一步（已使用读屏软件时不需要）。
.PARAMETER NoBrowser   完成后不打开浏览器。
.PARAMETER NoStart     只安装，不启动。
.PARAMETER NewMasterKey 重新生成主密钥（已有主密钥时默认不动）。
.PARAMETER Resume      重启或重新登录后由系统自动传入。
.PARAMETER ElevatedTask 内部使用：以管理员身份执行单个步骤（InstallWsl / InstallDocker）。
#>
[CmdletBinding()]
param(
    [string]$AppDir,
    [string]$DataDir,
    [switch]$Unattended,
    [switch]$Speak,
    [switch]$NoBrowser,
    [switch]$NoStart,
    [switch]$NewMasterKey,
    [switch]$Resume,
    [ValidateSet('', 'InstallWsl', 'InstallDocker')][string]$ElevatedTask = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { Write-Verbose '无法设置控制台编码' }
Import-Module (Join-Path $PSScriptRoot 'Aroomo.psm1') -Force
Set-AroomoSpeech -Enabled $Speak.IsPresent

if (-not $AppDir) { $AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$deploy = Join-Path $AppDir 'deploy'
$self = $MyInvocation.MyCommand.Path
$total = 10
$dockerInstallerUrl = 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe'

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Elevated {
    # 以管理员身份运行本脚本的某一步，返回退出码。会弹出 Windows 的「是否允许」确认框。
    param([string]$Task)
    if (Test-IsAdmin) {
        & $self -ElevatedTask $Task -AppDir $AppDir
        return $LASTEXITCODE
    }
    Write-AroomoSay '接下来 Windows 会弹出「是否允许此应用对你的设备进行更改」，请选「是」。'
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $p = Start-Process -FilePath $psExe -Verb RunAs -Wait -PassThru `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"", '-ElevatedTask', $Task, '-AppDir', "`"$AppDir`"")
    return $p.ExitCode
}

function Stop-WithMessage {
    param([string]$Text, [int]$Code = 1)
    Show-AroomoMessage -Text $Text -Unattended:$Unattended
    exit $Code
}

# ---------------------------------------------------------------------------
# 以管理员身份执行的单个步骤（退出码：0 成功；3010 需要重启；其他 失败）
# ---------------------------------------------------------------------------
if ($ElevatedTask -eq 'InstallWsl') {
    Write-AroomoSay '正在启用 WSL2（Windows 的 Linux 子系统）。需要几分钟。'
    & wsl.exe --install --no-distribution
    if ($LASTEXITCODE -ne 0) {
        Write-AroomoSay '新方式没成功，改用 Windows 功能开关启用。'
        & dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
        & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
    }
    try { & wsl.exe --update *> $null } catch { Write-Verbose 'wsl --update 未执行' }
    exit 3010
}
if ($ElevatedTask -eq 'InstallDocker') {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($winget) {
        Write-AroomoSay '正在用 winget 安装 Docker Desktop。需要下载大约 600 MB，请耐心等待。'
        & winget.exe install -e --id Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0 -and (Test-AroomoDockerInstalled)) { exit 0 }
    }
    Write-AroomoSay '正在从 Docker 官网下载 Docker Desktop 安装程序。'
    $tmp = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $dockerInstallerUrl -OutFile $tmp -UseBasicParsing
    $p = Start-Process -FilePath $tmp -ArgumentList @('install', '--quiet', '--accept-license', '--backend=wsl-2') -Wait -PassThru
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    exit $p.ExitCode
}

# ---------------------------------------------------------------------------
# 正常安装流程（以当前用户身份运行）
# ---------------------------------------------------------------------------
$logDir = Join-Path $env:LOCALAPPDATA 'Aroomo\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
try { Start-Transcript -Path (Join-Path $logDir ("install-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))) | Out-Null } catch { Write-Verbose '无法记录日志' }

if ($Resume) {
    Unregister-AroomoResume
    Write-AroomoSay '欢迎回来。Aroomo 安装继续进行。'
} else {
    Write-AroomoSay "开始安装 Aroomo 本地版（测试版）。`n整个过程大约 10 步。每一步开始时都会说明正在做什么。`n需要你操作时，会弹出对话框。"
}

# 1. Windows 版本
Write-AroomoSay -Step 1 -Total $total -Text '正在检查 Windows 版本。'
$build = [Environment]::OSVersion.Version.Build
$check = Test-AroomoWindowsBuild -Build $build
if (-not $check.Ok) { Stop-WithMessage $check.Message }
Write-AroomoSay $check.Message

# 2. 内存
Write-AroomoSay -Step 2 -Total $total -Text '正在检查内存。'
$hostMB = Get-AroomoHostMemoryMB
$wslCfgPath = Join-Path $env:USERPROFILE '.wslconfig'
$wslCfg = if (Test-Path -LiteralPath $wslCfgPath) { [IO.File]::ReadAllText($wslCfgPath) } else { '' }
$effMB = Get-AroomoEffectiveMemoryMB -HostMemoryMB $hostMB -WslConfigText $wslCfg
$tier = Get-AroomoTier -MemoryMB $effMB
$tierName = @{ 'demo-2g' = '对话演示版'; 'standard' = '标准版'; 'full' = '完整版' }[$tier]
Write-AroomoSay ("电脑内存约 {0} GB，Docker 可以用约 {1} GB。将使用「{2}」。" -f [Math]::Round($hostMB / 1024), [Math]::Round($effMB / 1024), $tierName)

# 3. 虚拟化
Write-AroomoSay -Step 3 -Total $total -Text '正在检查电脑是否开启了虚拟化。'
if ((Get-AroomoVirtualizationState) -ne 'ok') {
    Stop-WithMessage "这台电脑没有开启虚拟化，Docker 无法运行。`n需要在开机时进入 BIOS 设置，打开 Intel VT-x 或 AMD-V（也可能叫 SVM、Virtualization Technology）。`n这一步需要请身边的人帮忙。开启后重新运行安装即可。" 2
}
Write-AroomoSay '虚拟化已开启。'

# 4. WSL2
Write-AroomoSay -Step 4 -Total $total -Text '正在检查 WSL2。'
$wslOk = $false
if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    & wsl.exe --status *> $null
    $wslOk = ($LASTEXITCODE -eq 0)
}
if (-not $wslOk) {
    $code = Invoke-Elevated 'InstallWsl'
    if ($code -ne 0 -and $code -ne 3010) { Stop-WithMessage '启用 WSL2 没有成功。请把日志文件夹发给主程序员：%LOCALAPPDATA%\Aroomo\logs' }
    Register-AroomoResume -InstallScript $self -ExtraArgs ("-AppDir `"$AppDir`"" + $(if ($DataDir) { " -DataDir `"$DataDir`"" } else { '' }))
    if (Show-AroomoQuestion -Text "WSL2 已启用，需要重启电脑。`n重启并登录后，安装会自动继续。`n现在重启吗？选「否」可以稍后自己重启。" -Default $false -Unattended:$Unattended) {
        Restart-Computer -Force
    }
    Stop-WithMessage '请在方便的时候重启电脑。重启并登录后安装会自动继续。' 0
}
Write-AroomoSay 'WSL2 已就绪。'

# 5. Docker Desktop
Write-AroomoSay -Step 5 -Total $total -Text '正在检查 Docker Desktop。'
if (-not (Test-AroomoDockerInstalled)) {
    Write-AroomoSay "没有找到 Docker Desktop，现在自动安装。`nDocker Desktop 对个人使用免费。"
    $code = Invoke-Elevated 'InstallDocker'
    if ($code -eq 3010 -or $code -eq 1641) {
        Register-AroomoResume -InstallScript $self -ExtraArgs "-AppDir `"$AppDir`""
        Stop-WithMessage 'Docker Desktop 已安装，需要重启电脑。重启并登录后安装会自动继续。' 0
    }
    if ($code -ne 0 -or -not (Test-AroomoDockerInstalled)) {
        Stop-WithMessage "Docker Desktop 安装没有成功。`n可以请人帮忙从 docker.com 下载安装 Docker Desktop，然后重新运行 Aroomo 安装。"
    }
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Start-AroomoDocker -TimeoutSec 600)) {
    Register-AroomoResume -InstallScript $self -ExtraArgs "-AppDir `"$AppDir`""
    Stop-WithMessage "Docker Desktop 没能启动。`n如果是刚安装完，请注销并重新登录 Windows（让账户加入 docker-users 组），之后安装会自动继续。`n如果 Docker Desktop 弹出了窗口要求同意条款或登录，可以选「跳过」或「接受」。"
}
Write-AroomoSay 'Docker Desktop 已在运行。'

# 6. 数据文件夹
Write-AroomoSay -Step 6 -Total $total -Text '选择数据文件夹。'
$info = Get-AroomoInstallInfo
if (-not $DataDir -and $info.DataDir) { $DataDir = $info.DataDir; Write-AroomoSay "继续使用之前的数据文件夹：$DataDir" }
if (-not $DataDir) {
    $suggest = Get-AroomoDefaultDataDir
    if (Show-AroomoQuestion -Text "Aroomo 的备份和配置会放在：`n$suggest`n使用这个文件夹吗？选「否」可以自己选。" -Default $true -Unattended:$Unattended) {
        $DataDir = $suggest
    } else {
        $DataDir = Select-AroomoFolder -Initial $suggest
        if (-not $DataDir) { Stop-WithMessage '没有选择文件夹，安装已停止。重新运行安装即可继续。' }
    }
}
foreach ($sub in @('backups', 'config', 'logs')) { New-Item -ItemType Directory -Path (Join-Path $DataDir $sub) -Force | Out-Null }
Set-AroomoInstallInfo -AppDir $AppDir -DataDir $DataDir
$drive = (Split-Path -Qualifier $DataDir)
$free = (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$drive'").FreeSpace / 1GB
if ($free -lt 40) { Write-AroomoSay ("提醒：{0} 盘只剩约 {1} GB。建议至少留 40 GB。" -f $drive, [int]$free) }

# 7. 生成配置（.env：随机密钥只写入文件，不显示）
Write-AroomoSay -Step 7 -Total $total -Text '正在生成配置文件。密码和密钥只写进文件，不会显示在屏幕上。'
$canonical = Join-Path $DataDir 'config\aroomo.env'
$envPath = Join-Path $deploy '.env'
if (Test-Path -LiteralPath $canonical) {
    Write-AroomoSay '找到了之前的配置，继续使用（密钥保持不变，数据才能打开）。'
    # 升级旧配置：去掉 restic 的键，补上本地版固定值（D63、D65）；已填的异地存储和主密钥公钥保持不变
    $content = Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($canonical)) -Values (Get-AroomoLocalEnvDefaults) -Remove (Get-AroomoObsoleteEnvKeys)
    Write-AroomoPrivateFile -Path $canonical -Content $content
} else {
    $lobePort = Find-AroomoFreePort -Preferred 3210
    $s3Port = Find-AroomoFreePort -Preferred 9000 -Exclude @($lobePort)
    $values = @{
        TZ                = 'Asia/Shanghai'
        APP_URL           = "http://localhost:$lobePort"
        S3_ENDPOINT       = "http://localhost:$s3Port"
        LOBE_PORT         = "$lobePort"
        RUSTFS_PORT       = "$s3Port"
        AROOMO_TIER       = $tier
        JWKS_KEY          = (New-AroomoJwks)
        LOCAL_BACKUP_DIR  = (ConvertTo-AroomoDockerPath (Join-Path $DataDir 'backups'))
    }
    foreach ($kv in (Get-AroomoLocalEnvDefaults).GetEnumerator()) { $values[$kv.Key] = $kv.Value }
    $template = [IO.File]::ReadAllText((Join-Path $deploy '.env.example'))
    $content = Set-AroomoEnvValues -Content (ConvertTo-AroomoEnv -Template $template -Values $values) -Remove (Get-AroomoObsoleteEnvKeys)
    Write-AroomoPrivateFile -Path $canonical -Content $content
}
Write-AroomoPrivateFile -Path $envPath -Content $content
Write-AroomoSay "配置文件在：$canonical"

# 8. 主密钥（D64）：离线生成，窗口里一次性显示；用户点「已保存」后只把公钥写进配置
Write-AroomoSay -Step 8 -Total $total -Text '主密钥。'
$mk = Invoke-AroomoMasterKeySetup -AppDir $AppDir -EnvPaths @($canonical, $envPath) -DataDir $DataDir -Force:$NewMasterKey -Unattended:$Unattended
switch ($mk) {
    'exists' { Write-AroomoSay '已经有主密钥了，保持不变。（要更换，请从开始菜单运行「Aroomo 重新生成主密钥」。）' }
    'created' {
        Write-AroomoSay "主密钥已保存。公钥已写进配置。`n公钥也存在：$(Join-Path $DataDir 'config\master-key-public.txt')`n服务器和这台电脑用同一个主密钥：请把这个文件里的公钥发给主程序员。公钥不是秘密，可以发。"
    }
    'cancelled' {
        Stop-WithMessage "主密钥还没有保存，安装停在这一步。`n没有主密钥，备份就没法加密，Aroomo 不会在没有备份的情况下继续安装。`n重新运行安装即可继续，会生成一个新的主密钥。" 5
    }
    default {
        Write-AroomoSay "这次没有生成主密钥（无人值守安装，或找不到 age-keygen.exe）。`n在生成主密钥之前，备份不会运行。可以稍后从开始菜单运行「Aroomo 重新生成主密钥」。"
    }
}

# 9. 快捷方式和登录后备份（D65）
Write-AroomoSay -Step 9 -Total $total -Text '正在创建快捷方式和自动备份。'
New-AroomoShortcuts -AppDir $AppDir
Write-AroomoSay "桌面上已经有：Aroomo 启动、Aroomo 停止、Aroomo 更新、Aroomo 备份。`n开始菜单的 Aroomo 文件夹里还有：Aroomo 打开、Aroomo 状态、Aroomo 设置异地备份、Aroomo 重新生成主密钥。"
$boot = Register-AroomoBootBackup -AppDir $AppDir
$bootText = if ($boot -eq 'task') { '已设置：每次登录 Windows 后约 2 分钟，自动备份一次。' } else { '已设置：每次登录 Windows 后自动备份一次（放在「启动」文件夹里）。' }
Write-AroomoSay "$bootText`n关机前请用桌面上的「Aroomo 停止」：它会先备份再停止。直接关机时来不及备份，下次登录后会补一份。`n本机只保留最近 3 份备份。"
$cfgNow = Read-AroomoEnv -Path $envPath
if (-not ($cfgNow['BACKUP_S3_ENDPOINT'] -and $cfgNow['BACKUP_S3_BUCKET'])) {
    Write-AroomoSay "注意：还没有设置异地备份。现在备份只存在这台电脑上，硬盘坏了会一起丢。`n拿到异地存储的信息后，从开始菜单运行「Aroomo 设置异地备份」。"
}

# 10. 第一次启动
if ($NoStart) {
    Write-AroomoSay -Step 10 -Total $total -Text '已按要求跳过启动。以后双击桌面上的「Aroomo 启动」即可。'
} else {
    Write-AroomoSay -Step 10 -Total $total -Text "第一次启动。需要下载几 GB 的程序，通常 10 到 30 分钟。`n期间每分钟会报告一次进度。完成后会自动打开浏览器。"
    $startArgs = @('start', '-NoPause')
    if ($NoBrowser) { $startArgs += '-NoBrowser' }
    & (Join-Path $PSScriptRoot 'aroomo.ps1') @startArgs
    if ($LASTEXITCODE -ne 0) { Stop-WithMessage "Aroomo 第一次启动没有成功。`n可以稍后双击桌面上的「Aroomo 启动」再试。日志在 %LOCALAPPDATA%\Aroomo\logs。" }
}

Show-AroomoMessage -Text "安装完成。`n以后双击桌面上的「Aroomo 启动」就能打开 Aroomo。" -Unattended:$Unattended
try { Stop-Transcript | Out-Null } catch { Write-Verbose '日志未开启' }
exit 0
