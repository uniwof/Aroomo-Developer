# Aroomo Windows 本地版：安装器与启停脚本共用的函数（PRODUCT §7.1、§7.3、§16 P0；DECISIONS v4.3 P0-f）。
# 目标运行环境：Windows PowerShell 5.1（Windows 10 22H2 / 11 自带）。也能在 PowerShell 7 上跑（测试用）。
# 注意：本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会把中文读成乱码。
# 原则：任何函数都不在屏幕或日志里输出密钥。

Set-StrictMode -Version 2.0

# 与 scripts/select-tier.sh 保持一致（暂定阈值，见 DECISIONS v4.3）
$script:TierDemoMaxMB = 3500
$script:TierStandardMaxMB = 7000
# Docker Desktop 的系统要求：Windows 10 22H2（内部版本 19045）或更高；Windows 11 从 22000 开始
$script:MinWindowsBuild = 19045
$script:AroomoSpeak = $false

# ---------------------------------------------------------------------------
# 读屏友好的输出：每条消息前后空行、编号清楚、不靠颜色传达信息。
# ---------------------------------------------------------------------------
function Set-AroomoSpeech {
    param([bool]$Enabled)
    $script:AroomoSpeak = $Enabled
}

function Write-AroomoSay {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Text,
        [int]$Step = 0,
        [int]$Total = 0
    )
    Write-Host ''
    if ($Step -gt 0) {
        $head = if ($Total -gt 0) { "==== 第 $Step 步，共 $Total 步 ====" } else { "==== 第 $Step 步 ====" }
        Write-Host $head
    }
    foreach ($line in ($Text -split "`n")) { Write-Host $line }
    if ($script:AroomoSpeak) {
        try {
            $voice = New-Object -ComObject SAPI.SpVoice
            [void]$voice.Speak($Text, 1)
        } catch {
            Write-Verbose '语音朗读不可用'
        }
    }
}

# ---------------------------------------------------------------------------
# 档位与内存
# ---------------------------------------------------------------------------
function Get-AroomoTier {
    [CmdletBinding()]
    param([Parameter(Mandatory)][ValidateRange(1, [int]::MaxValue)][int]$MemoryMB)
    if ($MemoryMB -lt $script:TierDemoMaxMB) { return 'demo-2g' }
    if ($MemoryMB -lt $script:TierStandardMaxMB) { return 'standard' }
    return 'full'
}

function ConvertFrom-AroomoSize {
    # 把 .wslconfig 里的 "8GB" / "6144MB" / "8G" 换算成 MB；认不出返回 $null
    param([string]$Text)
    if ($Text -match '^\s*(\d+(?:\.\d+)?)\s*(GB|G|MB|M|TB|T)?\s*$') {
        $n = [double]$Matches[1]
        $unit = if ($Matches[2]) { $Matches[2].ToUpperInvariant() } else { 'B' }
        switch ($unit) {
            { $_ -in 'TB', 'T' } { return [int]($n * 1024 * 1024) }
            { $_ -in 'GB', 'G' } { return [int]($n * 1024) }
            { $_ -in 'MB', 'M' } { return [int]$n }
            default { return [int]($n / 1MB) }
        }
    }
    return $null
}

function Get-AroomoEffectiveMemoryMB {
    # Docker Desktop（WSL2 后端）能用的内存 = WSL2 虚拟机上限：
    # .wslconfig 的 [wsl2] memory= 有设置就用它（不超过主机内存），否则 WSL 默认是主机内存的一半。
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][int]$HostMemoryMB,
        [string]$WslConfigText = ''
    )
    $inWsl2 = $false
    foreach ($raw in ($WslConfigText -split "`r?`n")) {
        $line = $raw.Trim()
        if ($line -match '^\[(.+)\]$') { $inWsl2 = ($Matches[1].Trim().ToLowerInvariant() -eq 'wsl2'); continue }
        if ($inWsl2 -and $line -match '^memory\s*=\s*(.+)$') {
            $mb = ConvertFrom-AroomoSize $Matches[1]
            if ($mb -and $mb -gt 0) { return [Math]::Min($mb, $HostMemoryMB) }
        }
    }
    return [int][Math]::Floor($HostMemoryMB / 2)
}

function Get-AroomoHostMemoryMB {
    $cs = Get-CimInstance -ClassName Win32_ComputerSystem
    return [int]([double]$cs.TotalPhysicalMemory / 1MB)
}

# ---------------------------------------------------------------------------
# 系统检查
# ---------------------------------------------------------------------------
function Test-AroomoWindowsBuild {
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][int]$Build)
    if ($Build -ge 22000) {
        return [pscustomobject]@{ Ok = $true; Message = "Windows 11（内部版本 $Build），可以安装。" }
    }
    if ($Build -ge $script:MinWindowsBuild) {
        return [pscustomobject]@{ Ok = $true; Message = "Windows 10（内部版本 $Build），可以安装。" }
    }
    return [pscustomobject]@{
        Ok      = $false
        Message = "这台电脑的 Windows 版本太旧（内部版本 $Build）。需要 Windows 10 22H2（19045）或更新。请先在「设置 → Windows 更新」里更新系统，再重新运行安装。"
    }
}

function Get-AroomoVirtualizationState {
    # 已经有虚拟机监控程序在运行（WSL2 / Hyper-V 已启用）时，VirtualizationFirmwareEnabled 会报 False，
    # 所以先看 HypervisorPresent。
    [CmdletBinding()]
    param(
        [Nullable[bool]]$HypervisorPresent = $null,
        [Nullable[bool]]$FirmwareEnabled = $null
    )
    if ($null -eq $HypervisorPresent) {
        $HypervisorPresent = [bool](Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent
    }
    if ($HypervisorPresent) { return 'ok' }
    if ($null -eq $FirmwareEnabled) {
        $FirmwareEnabled = [bool]((Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).VirtualizationFirmwareEnabled)
    }
    if ($FirmwareEnabled) { return 'ok' }
    return 'disabled'
}

# ---------------------------------------------------------------------------
# 密钥与 .env（只在本机生成，不打印）
# ---------------------------------------------------------------------------
function New-AroomoSecret {
    [CmdletBinding()]
    [OutputType([string])]
    param([ValidateRange(16, 128)][int]$Bytes = 32)
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')
}

function ConvertTo-AroomoBase64Url {
    param([byte[]]$Bytes)
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-AroomoJwks {
    # LobeHub 的 JWKS_KEY：含 RS256 私钥的 JWK Set（JSON 一行）
    [CmdletBinding()]
    [OutputType([string])]
    param()
    $rsa = $null
    try {
        $rsa = New-Object System.Security.Cryptography.RSACryptoServiceProvider 2048
        $p = $rsa.ExportParameters($true)
    } finally {
        if ($rsa) { $rsa.Dispose() }
    }
    $jwk = [ordered]@{
        kty = 'RSA'; use = 'sig'; alg = 'RS256'; kid = (New-AroomoSecret -Bytes 16)
        n = ConvertTo-AroomoBase64Url $p.Modulus; e = ConvertTo-AroomoBase64Url $p.Exponent
        d = ConvertTo-AroomoBase64Url $p.D; p = ConvertTo-AroomoBase64Url $p.P; q = ConvertTo-AroomoBase64Url $p.Q
        dp = ConvertTo-AroomoBase64Url $p.DP; dq = ConvertTo-AroomoBase64Url $p.DQ; qi = ConvertTo-AroomoBase64Url $p.InverseQ
    }
    return (@{ keys = @($jwk) } | ConvertTo-Json -Depth 5 -Compress)
}

function Format-AroomoEnvValue {
    param([string]$Value)
    # 含空格、引号、花括号、#、$ 的值用单引号包起来（Compose 的 .env 单引号内按字面处理）
    if ($Value -match '[\s"''{}#$\\]') {
        if ($Value.Contains("'")) { throw '.env 的值里不能有单引号' }
        return "'$Value'"
    }
    return $Value
}

function ConvertTo-AroomoEnv {
    # 以 deploy/.env.example 为模板生成 .env 内容：
    #   - $Values 里给的键：用给定值（模板里没有的键追加到末尾）
    #   - 值为 CHANGE_ME 的键：随机 32 字节十六进制；sk-CHANGE_ME：sk- 加随机值
    #   - 其余保持模板默认
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$Template,
        [hashtable]$Values = @{}
    )
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Template -split "`r?`n")) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
            $key = $Matches[1]; $val = $Matches[2]
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            if ($Values.ContainsKey($key)) {
                $val = [string]$Values[$key]
            } elseif ($val -eq 'CHANGE_ME') {
                $val = New-AroomoSecret
            } elseif ($val -eq 'sk-CHANGE_ME') {
                $val = 'sk-' + (New-AroomoSecret)
            }
            $out.Add("$key=$(Format-AroomoEnvValue $val)")
        } else {
            $out.Add($line)
        }
    }
    $extra = @($Values.Keys | Where-Object { -not $seen.ContainsKey($_) } | Sort-Object)
    if ($extra.Count -gt 0) {
        $out.Add('')
        $out.Add('# ---- Windows 本地版（安装器生成）----')
        foreach ($k in $extra) { $out.Add("$k=$(Format-AroomoEnvValue ([string]$Values[$k]))") }
    }
    return (($out -join "`n").TrimEnd() + "`n")
}

function Read-AroomoEnv {
    # 读取 .env 为哈希表（只给脚本内部用，不打印）
    [CmdletBinding()]
    [OutputType([hashtable])]
    param([Parameter(Mandatory)][string]$Path)
    $h = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $h }
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
            $v = $Matches[2]
            if ($v.Length -ge 2 -and $v.StartsWith("'") -and $v.EndsWith("'")) { $v = $v.Substring(1, $v.Length - 2) }
            $h[$Matches[1]] = $v
        }
    }
    return $h
}

function Write-AroomoPrivateFile {
    # 写成 UTF-8 无 BOM（Compose 读 .env 不认 BOM），并在 Windows 上只给当前用户访问权限
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding $false))
    if ($env:OS -eq 'Windows_NT') {
        $who = "$env:USERDOMAIN\$env:USERNAME"
        & icacls.exe $Path /inheritance:r /grant:r "${who}:(F)" /grant:r 'SYSTEM:(F)' | Out-Null
    }
}

# ---------------------------------------------------------------------------
# 路径、端口、数据文件夹
# ---------------------------------------------------------------------------
function ConvertTo-AroomoDockerPath {
    # D:\AroomoData\backups → D:/AroomoData/backups（Docker Desktop 认这种写法）
    param([Parameter(Mandatory)][string]$Path)
    return ($Path.TrimEnd('\', '/') -replace '\\', '/')
}

function Get-AroomoDefaultDataDir {
    # 优先选：非系统盘、剩余空间最大且 ≥ 50 GB 的固定磁盘；否则用户目录
    [CmdletBinding()]
    param(
        [object[]]$Drives = $null,   # 测试用：@{ Name='D:'; FreeGB=300; IsSystem=$false }
        [string]$UserProfile = $env:USERPROFILE
    )
    if ($null -eq $Drives) {
        $sys = $env:SystemDrive
        $Drives = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
                [pscustomobject]@{ Name = $_.DeviceID; FreeGB = [int]($_.FreeSpace / 1GB); IsSystem = ($_.DeviceID -eq $sys) }
            })
    }
    $best = $Drives | Where-Object { -not $_.IsSystem -and $_.FreeGB -ge 50 } | Sort-Object -Property FreeGB -Descending | Select-Object -First 1
    if ($best) { return "$($best.Name)\AroomoData" }
    return [IO.Path]::Combine($UserProfile, 'AroomoData')
}

function Test-AroomoPortFree {
    param([int]$Port)
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Find-AroomoFreePort {
    [CmdletBinding()]
    [OutputType([int])]
    param(
        [Parameter(Mandatory)][int]$Preferred,
        [int[]]$Exclude = @(),
        [scriptblock]$IsFree = { param($p) Test-AroomoPortFree -Port $p },
        [int]$MaxTries = 50
    )
    for ($p = $Preferred; $p -lt $Preferred + $MaxTries; $p++) {
        if ($Exclude -contains $p) { continue }
        if (& $IsFree $p) { return $p }
    }
    throw "从 $Preferred 开始找不到空闲端口"
}

# ---------------------------------------------------------------------------
# Compose：与 scripts/compose.sh 相同的文件组合（AROOMO_LOCAL=1），再加本机备份目录
# ---------------------------------------------------------------------------
function Get-AroomoComposeFiles {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][string]$DeployDir,
        [Parameter(Mandatory)][ValidateSet('demo-2g', 'standard', 'full')][string]$Tier
    )
    return @(
        [IO.Path]::Combine($DeployDir, 'docker-compose.yml'),
        [IO.Path]::Combine($DeployDir, 'tiers', "$Tier.yml"),
        [IO.Path]::Combine($DeployDir, 'local.yml'),
        [IO.Path]::Combine($DeployDir, 'local-backup.yml')
    )
}

function Get-AroomoComposeArgs {
    [CmdletBinding()]
    [OutputType([string[]])]
    param(
        [Parameter(Mandatory)][string]$DeployDir,
        [Parameter(Mandatory)][string]$Tier
    )
    $a = New-Object System.Collections.Generic.List[string]
    $a.Add('compose'); $a.Add('--project-directory'); $a.Add($DeployDir)
    foreach ($f in (Get-AroomoComposeFiles -DeployDir $DeployDir -Tier $Tier)) { $a.Add('-f'); $a.Add($f) }
    return $a.ToArray()
}

# ---------------------------------------------------------------------------
# 安装信息（注册表 HKCU:\Software\Aroomo）
# ---------------------------------------------------------------------------
$script:RegPath = 'HKCU:\Software\Aroomo'

function Get-AroomoInstallInfo {
    $info = @{ AppDir = $null; DataDir = $null }
    if (Test-Path $script:RegPath) {
        $p = Get-ItemProperty -Path $script:RegPath
        foreach ($k in @('AppDir', 'DataDir')) {
            if ($p.PSObject.Properties.Name -contains $k) { $info[$k] = $p.$k }
        }
    }
    return $info
}

function Set-AroomoInstallInfo {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$AppDir, [string]$DataDir)
    if (-not $PSCmdlet.ShouldProcess($script:RegPath, '保存安装信息')) { return }
    if (-not (Test-Path $script:RegPath)) { New-Item -Path $script:RegPath -Force | Out-Null }
    if ($AppDir) { Set-ItemProperty -Path $script:RegPath -Name AppDir -Value $AppDir }
    if ($DataDir) { Set-ItemProperty -Path $script:RegPath -Name DataDir -Value $DataDir }
}

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
function Get-AroomoDockerDesktopExe {
    return (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe')
}

function Test-AroomoDockerInstalled {
    return ([bool](Get-Command docker -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath (Get-AroomoDockerDesktopExe)))
}

function Test-AroomoDockerReady {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    & docker info --format '{{.ServerVersion}}' *> $null
    return ($LASTEXITCODE -eq 0)
}

function Start-AroomoDocker {
    # 确保 Docker Desktop 在运行；最多等 $TimeoutSec 秒，每 30 秒报一次进度
    [CmdletBinding()]
    [OutputType([bool])]
    param([int]$TimeoutSec = 300)
    if (Test-AroomoDockerReady) { return $true }
    $exe = Get-AroomoDockerDesktopExe
    if (Test-Path -LiteralPath $exe) {
        Write-AroomoSay '正在打开 Docker Desktop。第一次打开可能要一两分钟，请稍等。'
        Start-Process -FilePath $exe | Out-Null
    }
    $t0 = Get-Date
    $next = 30
    while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
        Start-Sleep -Seconds 5
        if (Test-AroomoDockerReady) { return $true }
        $elapsed = [int]((Get-Date) - $t0).TotalSeconds
        if ($elapsed -ge $next) { Write-Host "还在等 Docker Desktop 启动，已经等了 $elapsed 秒。"; $next += 30 }
    }
    return $false
}

function Invoke-AroomoCompose {
    # 运行 docker compose；返回退出码。输出直接显示（compose 不会打印 .env 里的值）
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$DeployDir,
        [Parameter(Mandatory)][string]$Tier,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $base = Get-AroomoComposeArgs -DeployDir $DeployDir -Tier $Tier
    & docker @base @Arguments | Out-Host
    return $LASTEXITCODE
}

function Wait-AroomoReady {
    # 等界面能打开（HTTP 状态 < 500）
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Url,
        [int]$TimeoutSec = 1800
    )
    $t0 = Get-Date
    $next = 60
    while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop
            if ([int]$r.StatusCode -lt 500) { return $true }
        } catch {
            $resp = $null
            if ($_.Exception.PSObject.Properties.Name -contains 'Response') { $resp = $_.Exception.Response }
            if ($resp -and [int]$resp.StatusCode -gt 0 -and [int]$resp.StatusCode -lt 500) { return $true }
        }
        Start-Sleep -Seconds 5
        $elapsed = [int]((Get-Date) - $t0).TotalSeconds
        if ($elapsed -ge $next) {
            Write-Host "Aroomo 还在启动，已经等了 $([int]($elapsed / 60)) 分钟。第一次要下载程序，会比较久。"
            $next += 60
        }
    }
    return $false
}

# ---------------------------------------------------------------------------
# 快捷方式
# ---------------------------------------------------------------------------
function Get-AroomoShortcutSpecs {
    # 返回要创建的快捷方式（名称 → aroomo.ps1 子命令）
    [OutputType([object[]])]
    param()
    return @(
        [pscustomobject]@{ Name = 'Aroomo 启动'; Command = 'start'; Desktop = $true; Description = '启动 Aroomo 并打开浏览器' },
        [pscustomobject]@{ Name = 'Aroomo 停止'; Command = 'stop'; Desktop = $true; Description = '停止 Aroomo（数据保留）' },
        [pscustomobject]@{ Name = 'Aroomo 更新'; Command = 'update'; Desktop = $true; Description = '先备份，再更新 Aroomo' },
        [pscustomobject]@{ Name = 'Aroomo 备份'; Command = 'backup'; Desktop = $true; Description = '立即备份到数据文件夹' },
        [pscustomobject]@{ Name = 'Aroomo 打开'; Command = 'open'; Desktop = $false; Description = '在浏览器里打开 Aroomo' },
        [pscustomobject]@{ Name = 'Aroomo 状态'; Command = 'status'; Desktop = $false; Description = '查看 Aroomo 是否在运行' }
    )
}

function New-AroomoShortcuts {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$AppDir)
    $script = Join-Path $AppDir 'installer\windows\aroomo.ps1'
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aroomo'
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $PSCmdlet.ShouldProcess($startMenu, '创建快捷方式')) { return }
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    foreach ($s in (Get-AroomoShortcutSpecs)) {
        $targets = @(Join-Path $startMenu "$($s.Name).lnk")
        if ($s.Desktop) { $targets += (Join-Path $desktop "$($s.Name).lnk") }
        foreach ($t in $targets) {
            $lnk = $shell.CreateShortcut($t)
            $lnk.TargetPath = $psExe
            $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" $($s.Command)"
            $lnk.WorkingDirectory = $AppDir
            $lnk.Description = $s.Description
            $lnk.Save()
        }
    }
}

function Remove-AroomoShortcuts {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aroomo'
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $PSCmdlet.ShouldProcess($startMenu, '删除快捷方式')) { return }
    foreach ($s in (Get-AroomoShortcutSpecs)) {
        $p = Join-Path $desktop "$($s.Name).lnk"
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    if (Test-Path -LiteralPath $startMenu) { Remove-Item -LiteralPath $startMenu -Recurse -Force }
}

# ---------------------------------------------------------------------------
# 重启后继续（HKCU RunOnce）
# ---------------------------------------------------------------------------
$script:RunOncePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'

function Register-AroomoResume {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)][string]$InstallScript, [string]$ExtraArgs = '')
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $cmd = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -File `"$InstallScript`" -Resume $ExtraArgs".Trim()
    if ($PSCmdlet.ShouldProcess($script:RunOncePath, '登录后继续安装')) {
        Set-ItemProperty -Path $script:RunOncePath -Name 'AroomoSetup' -Value $cmd
    }
}

function Unregister-AroomoResume {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    if ((Test-Path $script:RunOncePath) -and $PSCmdlet.ShouldProcess($script:RunOncePath, '取消继续安装')) {
        Remove-ItemProperty -Path $script:RunOncePath -Name 'AroomoSetup' -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 对话框（标准 Windows 对话框，读屏软件能正常朗读）
# ---------------------------------------------------------------------------
function Show-AroomoQuestion {
    # 返回 $true = 是，$false = 否。无人值守时返回 $Default。
    param([Parameter(Mandatory)][string]$Text, [bool]$Default = $true, [switch]$Unattended)
    Write-AroomoSay $Text
    if ($Unattended) { return $Default }
    Add-Type -AssemblyName System.Windows.Forms
    $btn = if ($Default) { [System.Windows.Forms.MessageBoxDefaultButton]::Button1 } else { [System.Windows.Forms.MessageBoxDefaultButton]::Button2 }
    $r = [System.Windows.Forms.MessageBox]::Show($Text, 'Aroomo 安装', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, $btn)
    return ($r -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Show-AroomoMessage {
    param([Parameter(Mandatory)][string]$Text, [switch]$Unattended)
    Write-AroomoSay $Text
    if ($Unattended) { return }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Aroomo', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
}

function Select-AroomoFolder {
    param([string]$Initial)
    Add-Type -AssemblyName System.Windows.Forms
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '请选择存放 Aroomo 数据的文件夹（建议剩余空间 50 GB 以上）'
    $dlg.ShowNewFolderButton = $true
    if ($Initial) { $dlg.SelectedPath = $Initial }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.SelectedPath }
    return $null
}

Export-ModuleMember -Function *-Aroomo*
