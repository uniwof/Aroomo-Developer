<#
.SYNOPSIS
  Aroomo 独立版（不需要 Docker / WSL）的启动器。安装包、桌面快捷方式和托盘都调用它。
  设计：docs/architecture/STANDALONE.md（D76–D79）。本文件保存为 UTF-8 带 BOM，目标 Windows PowerShell 5.1。

.PARAMETER Action
  firstrun   安装后自动运行：生成配置、解开对话界面、初始化数据库、首次启动、登录自启、快捷方式，然后打开窗口
  init       只生成配置和安装信息（没有窗口；CI 冒烟测试用）
  open       立刻打开窗口（后台没准备好时先显示「正在准备」），并确保托盘和后台在运行（桌面快捷方式用）
  start      启动后台服务：主界面（Shell、LobeHub、Core、LiteLLM 及其依赖）并行启动并等到就绪；
             完整档模块（收藏、RSSHub、Chromium、Meilisearch）随后启动、不等（加 -WaitAll 时也等它们就绪）
  stop       先备份，再停止全部后台服务
  backup     立即备份（主密钥公钥加密；本机留 3 份；配置了异地存储时同时上传）
  repair     修复：停止 → 检查 → 修复 → 启动，并生成去掉密钥的诊断包
  status     各服务是否在运行（文字，读屏可读）
  masterkey  粘贴 / 生成主密钥（D78：只需一次，之后用 Windows 账户保护保存）
  uninstall  卸载时由安装包调用：停止服务、取消自启（数据保留）
  tray       托盘图标（登录 30 秒后由自启项运行，D77-4）
#>
[CmdletBinding()]
param(
    [ValidateSet('firstrun', 'init', 'open', 'bookmarks', 'start', 'stop', 'backup', 'repair', 'status', 'masterkey', 'uninstall', 'tray')]
    [string]$Action = 'open',
    [int]$Delay = 0,
    [switch]$WaitAll,
    [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$DataDir
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $AppDir 'installer\windows\Aroomo.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $AppDir 'installer\standalone\AroomoStandalone.psm1') -Force -DisableNameChecking
Set-AroomoSpeech $false   # D78：不用语音提示，用标准控件让「放大镜 / 讲述人」能读

$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunName = 'AroomoStandalone'
$Launcher = Join-Path $AppDir 'installer\standalone\aroomo-launch.vbs'

function Get-DataDirResolved {
    if ($DataDir) { return $DataDir }
    $info = Get-AroomoSAInstallInfo
    if ($info.DataDir) { return $info.DataDir }
    return (Get-AroomoSADefaultDataDir)
}

function Write-Log([string]$Text) {
    try {
        $d = Get-DataDirResolved
        $dir = Join-Path $d 'logs'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Add-Content -LiteralPath (Join-Path $dir 'launcher.log') -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $Text) -Encoding UTF8
    } catch { Write-Verbose '写日志失败' }
}

function Show-Message([string]$Text, [string]$Title = 'Aroomo') {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, 'OK', 'Information')
}

# ---------------------------------------------------------------------------
# 配置：第一次运行时生成（随机密钥；只有当前 Windows 用户能读）
# ---------------------------------------------------------------------------
function Initialize-Config([string]$Data) {
    $paths = Get-AroomoSAPaths -AppDir $AppDir -DataDir $Data
    New-Item -ItemType Directory -Path $paths.Config, $paths.Logs, $paths.Backups -Force | Out-Null
    if (Test-Path -LiteralPath $paths.EnvFile) {
        $cfg = Read-AroomoEnv -Path $paths.EnvFile
        # 旧版本没有的键补上（不改已有的值）
        $add = @{}
        foreach ($kv in (Get-AroomoSAPortDefaults).GetEnumerator()) { if (-not $cfg[$kv.Key]) { $add[$kv.Key] = [string]$kv.Value } }
        foreach ($k in 'LITELLM_DB_PASSWORD', 'LOCAL_OWNER_PASSWORD', 'MEILI_MASTER_KEY', 'KARAKEEP_NEXTAUTH_SECRET') { if (-not $cfg[$k]) { $add[$k] = New-AroomoSecret } }
        if (-not $cfg['LOCAL_OWNER_EMAIL']) { $add['LOCAL_OWNER_EMAIL'] = 'owner@aroomo.local' }
        # 早期测试版把 KEY_VAULTS_SECRET 生成成了十六进制（LobeHub 不接受，用它什么也加密不了），换成合法值
        if ($cfg['KEY_VAULTS_SECRET'] -match '^[0-9a-f]{64}$') { $add['KEY_VAULTS_SECRET'] = New-AroomoSABase64Secret }
        if ($add.Count -gt 0) { Write-AroomoPrivateFile -Path $paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($paths.EnvFile)) -Values $add) }
        return
    }
    $ports = @{}
    $used = @()
    foreach ($kv in (Get-AroomoSAPortDefaults).GetEnumerator()) {
        $p = Find-AroomoFreePort -Preferred $kv.Value -Exclude $used
        $ports[$kv.Key] = $p; $used += $p
    }
    $vals = Get-AroomoSAInitialValues -Ports $ports -Jwks (New-AroomoJwks)
    $tpl = [IO.File]::ReadAllText((Join-Path $AppDir 'installer\standalone\standalone.env.example'))
    Write-AroomoPrivateFile -Path $paths.EnvFile -Content (ConvertTo-AroomoEnv -Template $tpl -Values $vals)
}

function Resolve-BusyPorts([hashtable]$Ctx) {
    # D78 自动修复：端口被别的程序占了就换一个空闲端口（不动本程序自己的进程）
    $c = $Ctx.Config; $change = @{}; $used = @()
    foreach ($k in (Get-AroomoSAPortDefaults).Keys) { $used += [int]$c[$k] }
    foreach ($spec in $Ctx.Specs) {
        if (Test-AroomoSAServiceHealthy -Spec $spec -Paths $Ctx.Paths) { continue }
        if (Test-AroomoPortFree -Port $spec.Port) { continue }
        if (@(Get-AroomoSAPortOwner -Port $spec.Port -AppDir $AppDir).Count -gt 0) { continue }
        $key = ((Get-AroomoSAPortDefaults).Keys | Where-Object { [int]$c[$_] -eq $spec.Port } | Select-Object -First 1)
        if (-not $key) { continue }
        $np = Find-AroomoFreePort -Preferred ($spec.Port + 1) -Exclude $used
        $change[$key] = [string]$np; $used += $np
        Write-Log "端口 $($spec.Port)（$key）被别的程序占用，改用 $np"
    }
    if ($change.Count -gt 0) {
        if ($change.ContainsKey('RUSTFS_PORT')) { $change['S3_ENDPOINT'] = "http://localhost:$($change['RUSTFS_PORT'])" }
        if ($change.ContainsKey('PG_PORT')) {
            $conf = Join-Path $Ctx.Paths.PgData 'postgresql.conf'
            if (Test-Path $conf) { [IO.File]::AppendAllText($conf, "`nport = $($change['PG_PORT'])`n") }
        }
        Write-AroomoPrivateFile -Path $Ctx.Paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($Ctx.Paths.EnvFile)) -Values $change)
        return $true
    }
    return $false
}

function Get-Ctx {
    $d = Get-DataDirResolved
    return (Get-AroomoSAContext -AppDir $AppDir -DataDir $d)
}

function Start-Backend {
    # D77-3：按依赖并行启动（Start-AroomoSAParallel）；每个服务的开始 / 就绪秒数写进 logs\startup-timing.json
    param([switch]$All)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $ctx = Get-Ctx
    if (-not $ctx -or $ctx.Config.Count -eq 0) { throw '还没有完成安装。请重新运行 Aroomo 安装包。' }
    if (Resolve-BusyPorts $ctx) { $ctx = Get-Ctx }
    [void](Expand-AroomoSALobe -Paths $ctx.Paths)
    Expand-AroomoSAModules -Paths $ctx.Paths
    # 第一次：initdb + 建库和账号（已有数据库时，账号检查在数据库就绪后由 -EnsureDbAccounts 做）
    if (-not (Test-Path -LiteralPath (Join-Path $ctx.Paths.PgData 'PG_VERSION'))) { [void](Initialize-AroomoSADatabase -Context $ctx) }
    $prep = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $timing = [ordered]@{}
    $ok = Start-AroomoSAParallel -Context $ctx -EnsureDbAccounts -WaitAll:$All -Quiet -Timing $timing
    $total = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $failed = @($timing.Keys | Where-Object { $timing[$_].Contains('failed') })
    $line = ($timing.Keys | ForEach-Object { '{0}={1}' -f $_, $(if ($timing[$_].Contains('ready')) { $timing[$_]['ready'] } elseif ($timing[$_].Contains('failed')) { '失败' } else { '已启动' }) }) -join ' '
    Write-Log "启动计时（秒，从并行启动开始算）：准备 $prep，合计 $total；$line"
    if ($failed.Count -gt 0) { Write-Log "没能启动：$($failed -join '、')" }
    try {
        $obj = [ordered]@{ ok = $ok; wait_all = [bool]$All; prepare_s = $prep; total_s = $total; services = $timing }
        New-Item -ItemType Directory -Path $ctx.Paths.Logs -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $ctx.Paths.Logs 'startup-timing.json'), ($obj | ConvertTo-Json -Depth 4))
    } catch { Write-Verbose '写启动计时失败' }
    return $ok
}

# ---------------------------------------------------------------------------
# 窗口：立刻出现（D77-4）。后台没就绪时先显示本地的「正在准备」页，就绪后自动跳转
# ---------------------------------------------------------------------------
function Open-Window([string]$Url) {
    $ctx = Get-Ctx
    $url = if ($Url) { $Url } elseif ($ctx) { Get-AroomoSAPublicUrl -Paths $ctx.Paths -Config $ctx.Config } else { 'http://localhost:3280' }
    $target = $url
    $ready = $ctx -and (Get-AroomoSAHttpStatus -Url "$url/" -TimeoutMs 800) -gt 0
    if (-not $ready) {
        $splash = Join-Path $AppDir 'installer\standalone\runtime\preparing.html'
        $target = ([Uri]$splash).AbsoluteUri + '?to=' + [Uri]::EscapeDataString($url)
    }
    $edge = Get-AroomoSAEdgePath -AppDir $AppDir
    if ($edge) {
        $profile = Join-Path (Get-DataDirResolved) 'window-profile'
        Start-Process -FilePath $edge -ArgumentList @("--app=$target", "--user-data-dir=$profile", '--no-first-run', '--disable-features=Translate', '--window-size=1280,860')
    } else {
        Start-Process $target
    }
}

function Test-TrayRunning {
    $created = $false
    $m = New-Object System.Threading.Mutex($false, 'Local\AroomoStandaloneTray', [ref]$created)
    $running = -not $m.WaitOne(0)
    if (-not $running) { $m.ReleaseMutex() }
    $m.Dispose()
    return $running
}

function Start-TrayDetached {
    if (Test-TrayRunning) { return }
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList @("`"$Launcher`"", 'tray')
}

# ---------------------------------------------------------------------------
# 主密钥（D78：第一次运行时粘贴一次，之后用 Windows DPAPI 保存在本机；也可以生成新的）
# ---------------------------------------------------------------------------
function Get-MasterKeyFile { return (Join-Path (Get-DataDirResolved) 'config\master-key.dpapi') }

function Save-MasterKey([string]$Identity) {
    Add-Type -AssemblyName System.Security
    $bytes = [Text.Encoding]::UTF8.GetBytes($Identity.Trim())
    $enc = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
    $f = Get-MasterKeyFile
    [IO.File]::WriteAllBytes($f, $enc)
    & icacls.exe $f /inheritance:r /grant:r "$env:USERDOMAIN\${env:USERNAME}:(F)" | Out-Null
    # 公钥写进配置（备份用它加密）
    $kg = Get-AroomoAgeKeygenPath -AppDir $AppDir
    $r = Invoke-AroomoSAHidden -Exe $kg -Arguments @('-y') -StdIn ($Identity.Trim() + "`n") -TimeoutSec 30
    $pub = ($r.Output -split "`r?`n" | Where-Object { $_ -match '^age1' } | Select-Object -First 1)
    if ($r.ExitCode -ne 0 -or -not (Test-AroomoAgeRecipient $pub)) { throw '这不是有效的主密钥（应以 AGE-SECRET-KEY-1 开头）。' }
    $paths = Get-AroomoSAPaths -AppDir $AppDir -DataDir (Get-DataDirResolved)
    Write-AroomoPrivateFile -Path $paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($paths.EnvFile)) -Values @{ BACKUP_AGE_RECIPIENT = $pub.Trim() })
}

function Show-MasterKeyDialog {
    # 返回 saved | generated | later。标准控件、大字号，读屏可读；只有一个必填动作：粘贴
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
    $font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14)
    $f = New-Object System.Windows.Forms.Form
    $f.Text = 'Aroomo：主密钥'; $f.Font = $font; $f.StartPosition = 'CenterScreen'; $f.AutoScaleMode = 'Dpi'
    $f.ClientSize = New-Object System.Drawing.Size(760, 360); $f.TopMost = $true
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = "请把主密钥粘贴到下面（以 AGE-SECRET-KEY-1 开头），然后按「保存」。`r`n只需要这一次，之后这台电脑会用你的 Windows 账户保护它。"
    $lbl.SetBounds(20, 15, 720, 90); $lbl.AccessibleName = '说明'
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.SetBounds(20, 110, 720, 40); $tb.AccessibleName = '主密钥'; $tb.UseSystemPasswordChar = $true
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = '保存'; $ok.SetBounds(20, 180, 220, 60); $ok.AccessibleName = '保存主密钥'
    $gen = New-Object System.Windows.Forms.Button
    $gen.Text = '我还没有，生成新的'; $gen.SetBounds(260, 180, 300, 60)
    $later = New-Object System.Windows.Forms.Button
    $later.Text = '以后再说'; $later.SetBounds(580, 180, 160, 60)
    $err = New-Object System.Windows.Forms.Label
    $err.SetBounds(20, 260, 720, 80); $err.ForeColor = [System.Drawing.Color]::DarkRed; $err.AccessibleName = '提示'
    $f.Controls.AddRange(@($lbl, $tb, $ok, $gen, $later, $err))
    $f.AcceptButton = $ok
    $script:mkResult = 'later'
    $ok.Add_Click({
            try { Save-MasterKey $tb.Text; $script:mkResult = 'saved'; $f.Close() }
            catch { $err.Text = $_.Exception.Message }
        })
    $gen.Add_Click({ $script:mkResult = 'generate'; $f.Close() })
    $later.Add_Click({ $script:mkResult = 'later'; $f.Close() })
    [void]$f.ShowDialog()
    $tb.Text = ''
    if ($script:mkResult -eq 'generate') {
        $k = New-AroomoMasterKey -AgeKeygenPath (Get-AroomoAgeKeygenPath -AppDir $AppDir)
        if (Show-AroomoMasterKeyWindow -Identity $k.Identity -PublicKey $k.PublicKey) { Save-MasterKey $k.Identity; Remove-Variable k; return 'generated' }
        Remove-Variable k
        return 'later'
    }
    return $script:mkResult
}

function Invoke-MasterKeyIfMissing {
    if (Test-Path -LiteralPath (Get-MasterKeyFile)) { return }
    $cfg = Read-AroomoEnv -Path (Join-Path (Get-DataDirResolved) 'config\aroomo.env')
    if ($cfg['BACKUP_AGE_RECIPIENT'] -and $Action -ne 'masterkey') { return }
    [void](Show-MasterKeyDialog)
}

# ---------------------------------------------------------------------------
# 自启（D77-4：登录 30 秒后静默启动托盘和后台）
# ---------------------------------------------------------------------------
function Register-Autostart {
    if (-not (Test-Path $RunKey)) { New-Item -Path $RunKey -Force | Out-Null }
    $cmd = '"{0}" "{1}" tray 30' -f (Join-Path $env:SystemRoot 'System32\wscript.exe'), $Launcher
    Set-ItemProperty -Path $RunKey -Name $RunName -Value $cmd
}

function New-Shortcuts {
    $shell = New-Object -ComObject WScript.Shell
    $ico = Join-Path $AppDir 'aroomo.ico'
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $startDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'Aroomo'
    New-Item -ItemType Directory -Path $startDir -Force | Out-Null
    $items = @(
        @{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aroomo.lnk'); Arg = 'open'; Desc = '打开 Aroomo' },
        @{ Path = (Join-Path $startDir 'Aroomo.lnk'); Arg = 'open'; Desc = '打开 Aroomo' },
        @{ Path = (Join-Path $startDir 'Aroomo 收藏.lnk'); Arg = 'bookmarks'; Desc = '打开 Aroomo 收藏（Karakeep）' },
        @{ Path = (Join-Path $startDir 'Aroomo 修复.lnk'); Arg = 'repair'; Desc = '停止、检查、修复并重新启动 Aroomo' },
        @{ Path = (Join-Path $startDir 'Aroomo 立即备份.lnk'); Arg = 'backup'; Desc = '立即备份 Aroomo' },
        @{ Path = (Join-Path $startDir 'Aroomo 主密钥.lnk'); Arg = 'masterkey'; Desc = '粘贴或生成主密钥' }
    )
    foreach ($i in $items) {
        $l = $shell.CreateShortcut($i.Path)
        $l.TargetPath = $wscript
        $l.Arguments = "`"$Launcher`" $($i.Arg)"
        $l.WorkingDirectory = $AppDir
        $l.Description = $i.Desc
        if (Test-Path $ico) { $l.IconLocation = "$ico,0" }
        $l.Save()
    }
}

function Remove-Shortcuts {
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Aroomo.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Aroomo') -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 修复与诊断包（D78）：诊断包里的日志去掉所有配置里的密钥值
# ---------------------------------------------------------------------------
function New-DiagnosticBundle([hashtable]$Ctx) {
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $outDir = Join-Path $Ctx.Paths.DataDir 'diagnostics'
    $work = Join-Path $outDir "diag-$stamp"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $secrets = @($Ctx.Config.GetEnumerator() | Where-Object { $_.Key -match 'PASSWORD|SECRET|KEY|TOKEN|JWKS' -and $_.Value -and ([string]$_.Value).Length -ge 8 } | ForEach-Object { [string]$_.Value })
    foreach ($log in Get-ChildItem -LiteralPath $Ctx.Paths.Logs -File -ErrorAction SilentlyContinue) {
        $lines = Get-Content -LiteralPath $log.FullName -Tail 2000 -ErrorAction SilentlyContinue
        $text = ($lines -join "`r`n")
        foreach ($s in $secrets) { $text = $text.Replace($s, '[已隐藏]') }
        $text = $text -replace 'AGE-SECRET-KEY-1[0-9A-Z]+', '[已隐藏]' -replace 'sk-[A-Za-z0-9_-]{8,}', 'sk-[已隐藏]'
        Set-Content -LiteralPath (Join-Path $work $log.Name) -Value $text -Encoding UTF8
    }
    $status = foreach ($s in $Ctx.Specs) { '{0}：{1}（端口 {2}）' -f $s.Label, $(if (Test-AroomoSAServiceHealthy -Spec $s -Paths $Ctx.Paths) { '正常' } else { '没有运行' }), $s.Port }
    $info = @("Aroomo 独立版诊断 $stamp", "Windows：$([Environment]::OSVersion.VersionString)", "内存：$([int]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)) MB") + $status
    Set-Content -LiteralPath (Join-Path $work 'status.txt') -Value $info -Encoding UTF8
    Copy-Item -LiteralPath (Join-Path $AppDir 'aroomo-components.json') -Destination $work -ErrorAction SilentlyContinue
    $zip = Join-Path $outDir "aroomo-diagnostics-$stamp.zip"
    Compress-Archive -Path (Join-Path $work '*') -DestinationPath $zip -Force
    Remove-Item -LiteralPath $work -Recurse -Force
    return $zip
}

function Invoke-Repair {
    $ctx = Get-Ctx
    if (-not $ctx) { throw '还没有完成安装。' }
    Stop-AroomoSAAll -Context $ctx
    # 端口上残留的本程序进程
    foreach ($s in $ctx.Specs) { foreach ($id in (Get-AroomoSAPortOwner -Port $s.Port -AppDir $AppDir)) { Stop-AroomoSATree -ProcessId $id } }
    # 数据库异常退出留下的锁文件（对应进程已经不在了才删）
    $pidFile = Join-Path $ctx.Paths.PgData 'postmaster.pid'
    if (Test-Path -LiteralPath $pidFile) {
        $first = (Get-Content -LiteralPath $pidFile -TotalCount 1)
        $n = 0
        if (-not ([int]::TryParse($first, [ref]$n)) -or -not (Get-Process -Id $n -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $pidFile -Force }
    }
    [void](Resolve-BusyPorts $ctx)
    $ok = Start-Backend -All
    $zip = New-DiagnosticBundle (Get-Ctx)
    return [pscustomobject]@{ Ok = $ok; Diagnostics = $zip }
}

# ---------------------------------------------------------------------------
function Initialize-Install {
    $d = Get-DataDirResolved
    if (Test-AroomoSANonAscii $d) { $d = Join-Path $env:SystemDrive 'AroomoStandalone' }
    Set-AroomoSAInstallInfo -AppDir $AppDir -DataDir $d
    $script:DataDir = $d
    Initialize-Config $d
    return $d
}

switch ($Action) {
    'init' {
        $d = Initialize-Install
        Write-Host "已生成配置：$d"
    }
    'firstrun' {
        if ($env:AROOMO_CI_NO_FIRSTRUN -eq '1') { return }   # CI 静默安装后由冒烟测试接手
        $d = Initialize-Install
        New-Shortcuts
        Register-Autostart
        # 窗口先出来（显示「正在准备」），后台在托盘里启动
        Open-Window
        Start-TrayDetached
        Invoke-MasterKeyIfMissing
        Write-Log "firstrun 完成：程序 $AppDir，数据 $d"
    }
    'open' {
        Open-Window
        Start-TrayDetached
    }
    'bookmarks' {
        # 收藏（Karakeep）在自己的窗口里打开
        $ctx = Get-Ctx
        $kp = if ($ctx -and $ctx.Config['KARAKEEP_PORT']) { $ctx.Config['KARAKEEP_PORT'] } else { '3283' }
        Open-Window "http://localhost:$kp"
        Start-TrayDetached
    }
    'start' {
        if (-not (Start-Backend -All:$WaitAll)) { Write-Host '有服务没能启动。请运行「Aroomo 修复」。'; exit 1 }
        Write-Host 'Aroomo 已启动。'
    }
    'stop' {
        $ctx = Get-Ctx
        if ($ctx -and $ctx.Config['BACKUP_AGE_RECIPIENT']) { [void](Invoke-AroomoSABackup -Context $ctx) }
        if ($ctx) { Stop-AroomoSAAll -Context $ctx }
        Write-Host 'Aroomo 已停止。'
    }
    'backup' {
        $r = Invoke-AroomoSABackup -Context (Get-Ctx)
        $msg = if ($r.Ok) { "备份完成。本机现在有 $($r.LocalCount) 份。" } else { "备份没有完成：$($r.Step)" }
        Write-Log $msg
        if ([Environment]::UserInteractive -and -not $env:CI) { Show-Message $msg }
    }
    'repair' {
        $r = Invoke-Repair
        $msg = if ($r.Ok) { "修复完成，Aroomo 已重新启动。诊断包：$($r.Diagnostics)" } else { "修复后仍有服务没能启动。请把诊断包发给主程序员：$($r.Diagnostics)" }
        Write-Log $msg
        if (-not $env:CI) { Show-Message $msg }
    }
    'status' {
        $ctx = Get-Ctx
        if (-not $ctx) { Write-Host '还没有安装。'; exit 1 }
        $bad = 0
        foreach ($s in $ctx.Specs) {
            $h = Test-AroomoSAServiceHealthy -Spec $s -Paths $ctx.Paths
            if (-not $h) { $bad++ }
            Write-Host ('{0}：{1}' -f $s.Label, $(if ($h) { '正常' } else { '没有运行' }))
        }
        exit $bad
    }
    'masterkey' { [void](Show-MasterKeyDialog) }
    'uninstall' {
        try { Remove-ItemProperty -Path $RunKey -Name $RunName -ErrorAction SilentlyContinue } catch { Write-Verbose '无自启项' }
        Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -like '*aroomo-tray.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        $ctx = Get-Ctx
        if ($ctx) {
            Stop-AroomoSAAll -Context $ctx
            # 对话界面是安装后解开的（有目录联接），安装包自己删不干净
            foreach ($d in $ctx.Paths.LobeDir, $ctx.Paths.KarakeepDir, $ctx.Paths.RsshubDir) {
                if (Test-Path $d) { & $ctx.Paths.Node (Join-Path $ctx.Paths.Runtime 'unpack-lobe.cjs') --remove $d | Out-Null }
            }
        }
        Remove-Shortcuts
        # 数据文件夹保留（D78：卸载默认保留数据）
    }
    'tray' {
        & (Join-Path $AppDir 'installer\standalone\aroomo-tray.ps1') -AppDir $AppDir -Delay $Delay
    }
}
