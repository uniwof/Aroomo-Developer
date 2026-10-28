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
        [pscustomobject]@{ Name = 'Aroomo 停止'; Command = 'stop'; Desktop = $true; Description = '先备份，再停止 Aroomo（关机前请用它）' },
        [pscustomobject]@{ Name = 'Aroomo 更新'; Command = 'update'; Desktop = $true; Description = '先备份，再更新 Aroomo' },
        [pscustomobject]@{ Name = 'Aroomo 备份'; Command = 'backup'; Desktop = $true; Description = '立即备份（本机留 3 份；设置了异地备份时同时上传）' },
        [pscustomobject]@{ Name = 'Aroomo 设置异地备份'; Command = 'offsite'; Desktop = $false; Description = '填写异地备份存储（与服务器同一个桶，独立目录）' },
        [pscustomobject]@{ Name = 'Aroomo 重新生成主密钥'; Command = 'masterkey'; Desktop = $false; Description = '更换主密钥（旧备份仍需旧主密钥打开）' },
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

# ---------------------------------------------------------------------------
# 主密钥（DECISIONS D64）：在本机离线生成 age X25519 密钥对；私钥只显示一次给用户保存，只把公钥写进配置。
# ---------------------------------------------------------------------------
$script:AgeRecipientPattern = '^age1[02-9ac-hj-np-z]{58}$'
$script:AgeIdentityPattern = '^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$'

function Test-AroomoAgeRecipient {
    [OutputType([bool])]
    param([string]$Value)
    return ([bool]$Value -and ($Value -cmatch $script:AgeRecipientPattern))
}

function ConvertFrom-AroomoAgeKeygenOutput {
    # 解析 age-keygen 的标准输出（"# created: …" / "# public key: age1…" / "AGE-SECRET-KEY-1…"）
    [CmdletBinding()]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    $identity = $null; $public = $null
    foreach ($line in ($Text -split "`r?`n")) {
        $t = $line.Trim()
        if ($t -cmatch $script:AgeIdentityPattern) { $identity = $t }
        elseif ($t -match '^#\s*public key:\s*(age1\S+)$') { $public = $Matches[1] }
    }
    if (-not $identity -or -not (Test-AroomoAgeRecipient $public)) { throw 'age-keygen 的输出不完整，无法生成主密钥' }
    return [pscustomobject]@{ Identity = $identity; PublicKey = $public }
}

function Format-AroomoKeyGroups {
    # 把主密钥分组，方便抄写和逐组朗读：AGE-SECRET-KEY-1 之后每 4 个字符一组
    [OutputType([string[]])]
    param([Parameter(Mandatory)][string]$Key, [int]$Size = 4, [int]$PerLine = 6)
    $prefix = 'AGE-SECRET-KEY-1'
    $body = if ($Key.StartsWith($prefix)) { $Key.Substring($prefix.Length) } else { $Key }
    $groups = for ($i = 0; $i -lt $body.Length; $i += $Size) { $body.Substring($i, [Math]::Min($Size, $body.Length - $i)) }
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add($prefix)
    for ($i = 0; $i -lt @($groups).Count; $i += $PerLine) {
        $lines.Add((@($groups)[$i..([Math]::Min($i + $PerLine, @($groups).Count) - 1)] -join ' '))
    }
    return $lines.ToArray()
}

function Get-AroomoAgeKeygenPath {
    param([Parameter(Mandatory)][string]$AppDir)
    return (Join-Path $AppDir 'installer\windows\bin\age-keygen.exe')
}

function New-AroomoMasterKey {
    # 运行随安装包附带的官方 age-keygen（不联网）。私钥只在内存里，不写盘、不进日志。
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([pscustomobject])]
    param([Parameter(Mandatory)][string]$AgeKeygenPath)
    if (-not (Test-Path -LiteralPath $AgeKeygenPath)) { throw "找不到 $AgeKeygenPath" }
    if (-not $PSCmdlet.ShouldProcess($AgeKeygenPath, '生成主密钥')) { return $null }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $AgeKeygenPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $out = $p.StandardOutput.ReadToEnd()
    [void]$p.StandardError.ReadToEnd()
    $p.WaitForExit()
    if ($p.ExitCode -ne 0) { throw "age-keygen 退出码 $($p.ExitCode)" }
    return (ConvertFrom-AroomoAgeKeygenOutput -Text $out)
}

function Set-AroomoEnvValues {
    # 在已有 .env 内容里设置 / 追加键值，并删除指定的键（返回新内容；不打印）
    [CmdletBinding()]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][AllowEmptyString()][string]$Content,
        [hashtable]$Values = @{},
        [string[]]$Remove = @()
    )
    $seen = @{}
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Content -split "`r?`n")) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=') {
            $key = $Matches[1]
            if ($Remove -contains $key) { continue }
            if ($Values.ContainsKey($key)) {
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $out.Add("$key=$(Format-AroomoEnvValue ([string]$Values[$key]))")
                continue
            }
        }
        $out.Add($line)
    }
    $extra = @($Values.Keys | Where-Object { -not $seen.ContainsKey($_) } | Sort-Object)
    foreach ($k in $extra) { $out.Add("$k=$(Format-AroomoEnvValue ([string]$Values[$k]))") }
    return (($out -join "`n").TrimEnd() + "`n")
}

function Get-AroomoPcBackupPrefix {
    # D65：电脑版在异地存储里用独立目录 pc/<电脑名>（小写，只留字母数字和连字符）
    [OutputType([string])]
    param([string]$HostName = $env:COMPUTERNAME)
    $n = ([string]$HostName).ToLowerInvariant() -replace '[^a-z0-9-]', '-'
    $n = ($n -replace '-+', '-').Trim('-')
    if (-not $n) { $n = 'pc' }
    return "pc/$n"
}

function Get-AroomoLocalEnvDefaults {
    # Windows 本地版在 .env 里固定的值（D63 本地没有 Cloudflare Access；D65 备份触发方式）
    [OutputType([hashtable])]
    param([string]$HostName = $env:COMPUTERNAME)
    return @{
        # 不常驻备份进程：备份只在开机（登录）后、停止 / 更新前由 aroomo.ps1 触发（D65）
        COMPOSE_PROFILES   = ''
        BACKUP_S3_PREFIX   = (Get-AroomoPcBackupPrefix -HostName $HostName)
        BACKUP_LOCAL_KEEP  = '3'
        # 异地除了每天 / 周 / 月各一份，再保留最近 3 份（电脑一天可能备份好几次）
        RETENTION_KEEP_LAST = '3'
        CORE_ACCESS_REAUTH = 'off'
    }
}

# 旧版（restic）留下、现在不再使用的键
$script:ObsoleteEnvKeys = @('RESTIC_REPOSITORY', 'RESTIC_PASSWORD', 'BACKUP_CRON')
function Get-AroomoObsoleteEnvKeys { return $script:ObsoleteEnvKeys }

function Show-AroomoMasterKeyWindow {
    # 一次性显示主密钥：大字号、读屏软件能读；「复制主密钥」「打印」「已保存」。点「已保存」并确认后返回 $true；
    # 不保存就关闭窗口返回 $false（调用方不会写入公钥，下次重新生成）。
    [CmdletBinding()]
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)][string]$Identity,
        [Parameter(Mandatory)][string]$PublicKey
    )
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $ui = New-Object System.Drawing.Font('Microsoft YaHei UI', 15)
    $mono = New-Object System.Drawing.Font('Consolas', 22, [System.Drawing.FontStyle]::Bold)
    $groups = Format-AroomoKeyGroups -Key $Identity
    $state = @{ Saved = $false }

    $form = New-Object System.Windows.Forms.Form
    $form.Text = '保存你的 Aroomo 主密钥'
    $form.AccessibleName = '保存你的 Aroomo 主密钥'
    $form.StartPosition = 'CenterScreen'
    $form.Size = New-Object System.Drawing.Size(1100, 860)
    $form.MinimumSize = New-Object System.Drawing.Size(900, 700)
    $form.Font = $ui
    $form.TopMost = $true
    $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
    $form.KeyPreview = $true

    $layout = New-Object System.Windows.Forms.TableLayoutPanel
    $layout.Dock = 'Fill'
    $layout.Padding = New-Object System.Windows.Forms.Padding(24)
    $layout.ColumnCount = 1
    $layout.RowCount = 6
    $form.Controls.Add($layout)

    $intro = New-Object System.Windows.Forms.Label
    $intro.AutoSize = $true
    $intro.MaximumSize = New-Object System.Drawing.Size(1020, 0)
    $intro.Text = "这是你的主密钥，只显示这一次。`r`n打开 Aroomo 的备份必须用它。丢了它，备份就再也打不开。`r`n请做两件事：`r`n1. 点「复制主密钥」，粘贴到密码管理器里保存。`r`n2. 点「打印」，打印一份纸质副本，放在安全的地方。`r`n不要发给任何人，也不要发到任何聊天里。做完后点「已保存」。"
    $intro.TabIndex = 0
    $layout.Controls.Add($intro)

    $box = New-Object System.Windows.Forms.TextBox
    $box.ReadOnly = $true
    $box.Multiline = $true
    $box.WordWrap = $true
    $box.Font = $mono
    $box.Height = 150
    $box.Dock = 'Fill'
    $box.Text = $Identity
    $box.AccessibleName = '主密钥'
    $box.AccessibleDescription = '主密钥，只显示这一次。可以用方向键逐个字符朗读。'
    $box.TabIndex = 1
    $layout.Controls.Add($box)

    $grouped = New-Object System.Windows.Forms.Label
    $grouped.AutoSize = $true
    $grouped.Font = New-Object System.Drawing.Font('Consolas', 16)
    $grouped.Text = "分组显示（方便抄写；密钥里没有字母 B、I、O，除了开头的 KEY-1 也没有数字 1）：`r`n" + ($groups -join "`r`n")
    $grouped.TabIndex = 2
    $layout.Controls.Add($grouped)

    $pubLabel = New-Object System.Windows.Forms.Label
    $pubLabel.AutoSize = $true
    $pubLabel.MaximumSize = New-Object System.Drawing.Size(1020, 0)
    $pubLabel.Text = "对应的公钥（不是秘密，安装后会写进配置，也要发给主程序员用于服务器）：`r`n$PublicKey"
    $layout.Controls.Add($pubLabel)

    $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
    $buttons.AutoSize = $true
    $buttons.FlowDirection = 'LeftToRight'
    $buttons.Padding = New-Object System.Windows.Forms.Padding(0, 16, 0, 0)
    $layout.Controls.Add($buttons)

    $status = New-Object System.Windows.Forms.Label
    $status.AutoSize = $true
    $status.AccessibleRole = [System.Windows.Forms.AccessibleRole]::StatusBar
    $layout.Controls.Add($status)

    function New-Btn([string]$text, [int]$tab) {
        $b = New-Object System.Windows.Forms.Button
        $b.Text = $text
        $b.AccessibleName = $text
        $b.AutoSize = $true
        $b.Padding = New-Object System.Windows.Forms.Padding(16, 8, 16, 8)
        $b.Margin = New-Object System.Windows.Forms.Padding(0, 0, 40, 0)
        $b.TabIndex = $tab
        return $b
    }
    $copy = New-Btn -text '复制主密钥' -tab 3
    $print = New-Btn -text '打印' -tab 4
    $saved = New-Btn -text '已保存' -tab 5
    $buttons.Controls.AddRange(@($copy, $print, $saved))

    $copy.Add_Click({
            [System.Windows.Forms.Clipboard]::SetText($Identity)
            $status.Text = '已复制。请粘贴到密码管理器里保存。'
            $status.AccessibilityNotifyClients([System.Windows.Forms.AccessibleEvents]::NameChange, -1)
        })

    $print.Add_Click({
            $doc = New-Object System.Drawing.Printing.PrintDocument
            $doc.DocumentName = 'Aroomo 主密钥'
            $doc.Add_PrintPage({
                    param($s, $e)
                    $null = $s
                    $g = $e.Graphics
                    $x = $e.MarginBounds.Left; $y = $e.MarginBounds.Top
                    $h1 = New-Object System.Drawing.Font('Microsoft YaHei UI', 18, [System.Drawing.FontStyle]::Bold)
                    $body = New-Object System.Drawing.Font('Microsoft YaHei UI', 11)
                    $big = New-Object System.Drawing.Font('Consolas', 20, [System.Drawing.FontStyle]::Bold)
                    $small = New-Object System.Drawing.Font('Consolas', 9)
                    $g.DrawString('Aroomo 主密钥（请妥善保管，不要拍照发给任何人）', $h1, [System.Drawing.Brushes]::Black, $x, $y); $y += 50
                    $g.DrawString(('生成时间：{0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm')), $body, [System.Drawing.Brushes]::Black, $x, $y); $y += 40
                    foreach ($l in $groups) { $g.DrawString($l, $big, [System.Drawing.Brushes]::Black, $x, $y); $y += 42 }
                    $y += 16
                    $g.DrawString('完整一行（与上面相同）：', $body, [System.Drawing.Brushes]::Black, $x, $y); $y += 28
                    $g.DrawString($Identity, $small, [System.Drawing.Brushes]::Black, $x, $y); $y += 40
                    $g.DrawString('对应的公钥（不是秘密，用于服务器和电脑加密备份）：', $body, [System.Drawing.Brushes]::Black, $x, $y); $y += 28
                    $g.DrawString($PublicKey, $small, [System.Drawing.Brushes]::Black, $x, $y); $y += 40
                    $g.DrawString("恢复备份时需要输入主密钥。密钥里没有字母 B、I、O，除了开头的 KEY-1 也没有数字 1。", $body, [System.Drawing.Brushes]::Black, $x, $y)
                    $e.HasMorePages = $false
                })
            $dlg = New-Object System.Windows.Forms.PrintDialog
            $dlg.Document = $doc
            $dlg.UseEXDialog = $true
            if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
                try { $doc.Print(); $status.Text = '已发送到打印机。请确认打印出来的内容清楚完整。' }
                catch { $status.Text = '打印没有成功。可以换一台打印机，或者把分组显示的内容抄在纸上。' }
                $status.AccessibilityNotifyClients([System.Windows.Forms.AccessibleEvents]::NameChange, -1)
            }
        })

    $saved.Add_Click({
            $q = "请确认：`r`n1. 主密钥已经存进密码管理器；`r`n2. 有一份纸质副本。`r`n确认后窗口会关闭，主密钥不会再显示。"
            $r = [System.Windows.Forms.MessageBox]::Show($form, $q, '确认已保存', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            if ($r -eq [System.Windows.Forms.DialogResult]::Yes) {
                $state.Saved = $true
                $form.Close()
            }
        })

    $form.Add_FormClosing({
            param($s, $e)
            $null = $s
            if ($state.Saved) { return }
            $q = "主密钥还没有保存。`r`n现在关闭的话，这个主密钥作废，安装会停在这一步；下次运行安装会重新生成一个新的。`r`n确定要关闭吗？"
            $r = [System.Windows.Forms.MessageBox]::Show($form, $q, '还没保存', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
            if ($r -ne [System.Windows.Forms.DialogResult]::Yes) { $e.Cancel = $true }
        })

    $form.Add_Shown({ $form.Activate(); $box.Focus(); $box.Select(0, 0) })
    [void]$form.ShowDialog()
    # 剪贴板里如果还是主密钥，清掉
    try { if ([System.Windows.Forms.Clipboard]::GetText() -eq $Identity) { [System.Windows.Forms.Clipboard]::Clear() } } catch { Write-Verbose '无法清理剪贴板' }
    $box.Text = ''
    $form.Dispose()
    return [bool]$state.Saved
}

function Invoke-AroomoMasterKeySetup {
    # 生成主密钥 → 窗口里给用户保存 → 用户点「已保存」后，只把公钥写进配置。
    # 返回：created（新生成并已保存）| exists（已有公钥，未改动）| cancelled（用户没保存）| unavailable（缺 age-keygen / 无人值守）
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param(
        [Parameter(Mandatory)][string]$AppDir,
        [Parameter(Mandatory)][string[]]$EnvPaths,
        [string]$DataDir,
        [switch]$Force,
        [switch]$Unattended
    )
    $cfg = Read-AroomoEnv -Path $EnvPaths[0]
    if (-not $Force -and $cfg.ContainsKey('BACKUP_AGE_RECIPIENT') -and (Test-AroomoAgeRecipient $cfg['BACKUP_AGE_RECIPIENT'])) { return 'exists' }
    if ($Unattended) { return 'unavailable' }
    $exe = Get-AroomoAgeKeygenPath -AppDir $AppDir
    if (-not (Test-Path -LiteralPath $exe)) { return 'unavailable' }
    if (-not $PSCmdlet.ShouldProcess(($EnvPaths -join ', '), '生成主密钥并写入公钥')) { return 'cancelled' }
    $k = New-AroomoMasterKey -AgeKeygenPath $exe
    $ok = Show-AroomoMasterKeyWindow -Identity $k.Identity -PublicKey $k.PublicKey
    $pub = $k.PublicKey
    Remove-Variable -Name k
    if (-not $ok) { return 'cancelled' }
    foreach ($p in $EnvPaths) {
        $content = if (Test-Path -LiteralPath $p) { [IO.File]::ReadAllText($p) } else { '' }
        Write-AroomoPrivateFile -Path $p -Content (Set-AroomoEnvValues -Content $content -Values @{ BACKUP_AGE_RECIPIENT = $pub })
    }
    if ($DataDir) {
        $note = "Aroomo 主密钥的公钥（不是秘密）：`r`n$pub`r`n`r`n服务器和这台电脑用同一个主密钥（D65）。请把上面这行公钥发给主程序员，填进服务器的 BACKUP_AGE_RECIPIENT。`r`n主密钥本身（AGE-SECRET-KEY-1 开头）只在你的密码管理器和纸质副本里，不要发给任何人。`r`n"
        [IO.File]::WriteAllText((Join-Path $DataDir 'config\master-key-public.txt'), $note, (New-Object System.Text.UTF8Encoding $true))
    }
    return 'created'
}

# ---------------------------------------------------------------------------
# 开机（登录）后备份（D65）：计划任务「登录时」运行 aroomo.ps1 boot-backup；不能建计划任务时退回「启动」文件夹快捷方式
# ---------------------------------------------------------------------------
$script:BootTaskName = 'Aroomo 开机备份'
$script:BootTaskPath = '\Aroomo\'

function Get-AroomoBootBackupShortcutPath {
    return (Join-Path ([Environment]::GetFolderPath('Startup')) "$($script:BootTaskName).lnk")
}

function Register-AroomoBootBackup {
    # 返回 task（计划任务）| startup（启动文件夹快捷方式）
    [CmdletBinding(SupportsShouldProcess)]
    [OutputType([string])]
    param([Parameter(Mandatory)][string]$AppDir)
    $script = Join-Path $AppDir 'installer\windows\aroomo.ps1'
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$script`" boot-backup -NoPause"
    if (-not $PSCmdlet.ShouldProcess($script:BootTaskName, '登录后自动备份')) { return 'none' }
    try {
        $user = "$env:USERDOMAIN\$env:USERNAME"
        $action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $AppDir
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
        $trigger.Delay = 'PT2M'
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2)
        Register-ScheduledTask -TaskName $script:BootTaskName -TaskPath $script:BootTaskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'D65：每次登录 Windows 后备份一次 Aroomo' -Force -ErrorAction Stop | Out-Null
        $lnkPath = Get-AroomoBootBackupShortcutPath
        if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }
        return 'task'
    } catch {
        Write-Verbose "无法创建计划任务，改用启动文件夹：$($_.Exception.Message)"
        $shell = New-Object -ComObject WScript.Shell
        $lnk = $shell.CreateShortcut((Get-AroomoBootBackupShortcutPath))
        $lnk.TargetPath = $psExe
        $lnk.Arguments = $arguments
        $lnk.WorkingDirectory = $AppDir
        $lnk.WindowStyle = 7
        $lnk.Description = '每次登录 Windows 后备份一次 Aroomo'
        $lnk.Save()
        return 'startup'
    }
}

function Unregister-AroomoBootBackup {
    [CmdletBinding(SupportsShouldProcess)]
    param()
    if (-not $PSCmdlet.ShouldProcess($script:BootTaskName, '取消登录后自动备份')) { return }
    try { Unregister-ScheduledTask -TaskName $script:BootTaskName -TaskPath $script:BootTaskPath -Confirm:$false -ErrorAction Stop } catch { Write-Verbose '没有计划任务' }
    $lnkPath = Get-AroomoBootBackupShortcutPath
    if (Test-Path -LiteralPath $lnkPath) { Remove-Item -LiteralPath $lnkPath -Force }
}

Export-ModuleMember -Function *-Aroomo*
