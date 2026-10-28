<#
.SYNOPSIS
  Aroomo 独立版托盘图标（D77-4、D78）。登录 30 秒后由自启项静默运行；只允许一个。
  - 启动全部后台服务；之后每 20 秒检查一次，进程退出了就自动重启（D78 自动修复）
  - 图标颜色：绿 = 正常，黄 = 正在准备 / 正在修复，红 = 有问题（一句话说明 + 一个「修复」按钮）
  - 菜单：打开 Aroomo、修复、立即备份、退出
  - 每次登录后台就绪后备份一次（D65）
  本文件保存为 UTF-8 带 BOM。
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$AppDir, [int]$Delay = 0)
$ErrorActionPreference = 'Stop'

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\AroomoStandaloneTray', [ref]$created)
if (-not $created) { return }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Import-Module (Join-Path $AppDir 'installer\windows\Aroomo.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $AppDir 'installer\standalone\AroomoStandalone.psm1') -Force -DisableNameChecking
$launcher = Join-Path $AppDir 'installer\standalone\aroomo-launch.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$main = Join-Path $AppDir 'installer\standalone\aroomo-standalone.ps1'

function New-DotIcon([System.Drawing.Color]$Color) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush $Color), 3, 3, 26, 26)
    $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 2), 3, 3, 26, 26)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{
    green  = New-DotIcon ([System.Drawing.Color]::FromArgb(46, 160, 67))
    yellow = New-DotIcon ([System.Drawing.Color]::FromArgb(218, 165, 32))
    red    = New-DotIcon ([System.Drawing.Color]::FromArgb(207, 34, 46))
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons.yellow
$tray.Text = 'Aroomo：正在准备'
$tray.Visible = $true

$state = @{ Status = 'yellow'; Message = '正在准备'; Busy = $false; BackedUp = $false }

function Set-State([string]$Color, [string]$Msg) {
    $state.Status = $Color; $state.Message = $Msg
    $tray.Icon = $icons[$Color]
    $t = "Aroomo：$Msg"
    if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }
    $tray.Text = $t
}

function Invoke-Launcher([string]$Act) {
    Start-Process -FilePath $wscript -ArgumentList @("`"$launcher`"", $Act)
}

# 后台工作放在单独的 PowerShell 进程里跑，托盘界面不卡
function Start-BackgroundStart {
    if ($state.Busy) { return }
    $state.Busy = $true
    Set-State 'yellow' '正在准备'
    $script:job = Start-Job -ScriptBlock {
        param($ps, $main, $app)
        & $ps -NoProfile -ExecutionPolicy Bypass -File $main -Action start -AppDir $app *> $null
        return $LASTEXITCODE
    } -ArgumentList $ps, $main, $AppDir
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)
$miOpen = $menu.Items.Add('打开 Aroomo')
$miRepair = $menu.Items.Add('修复')
$miBackup = $menu.Items.Add('立即备份')
[void]$menu.Items.Add('-')
$miExit = $menu.Items.Add('退出（先备份再停止）')
$tray.ContextMenuStrip = $menu

$miOpen.Add_Click({ Invoke-Launcher 'open' })
$tray.Add_DoubleClick({ Invoke-Launcher 'open' })
$miRepair.Add_Click({
        Set-State 'yellow' '正在修复'
        $state.Busy = $true
        $script:job = Start-Job -ScriptBlock { param($ps, $main, $app) $env:CI = ''; & $ps -NoProfile -ExecutionPolicy Bypass -File $main -Action repair -AppDir $app *> $null; return 0 } -ArgumentList $ps, $main, $AppDir
    })
$miBackup.Add_Click({ Invoke-Launcher 'backup' })
$miExit.Add_Click({
        $tray.Text = 'Aroomo：正在停止'
        & $ps -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $main -Action stop -AppDir $AppDir *> $null
        $tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    })
$tray.Add_BalloonTipClicked({ if ($state.Status -eq 'red') { $miRepair.PerformClick() } })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$script:waitUntil = (Get-Date).AddSeconds($Delay)
$script:started = $false
$script:lastCheck = Get-Date '2000-01-01'
$timer.Add_Tick({
        try {
            if (-not $script:started) {
                if ((Get-Date) -lt $script:waitUntil) { return }
                $script:started = $true
                Start-BackgroundStart
                return
            }
            if ($state.Busy) {
                if ($script:job.State -in 'Completed', 'Failed', 'Stopped') {
                    $code = Receive-Job $script:job -ErrorAction SilentlyContinue | Select-Object -Last 1
                    Remove-Job $script:job -Force
                    $state.Busy = $false
                    if ($code -eq 0) {
                        Set-State 'green' '正常运行'
                        if (-not $state.BackedUp) {
                            $state.BackedUp = $true
                            # D65：每次登录、后台就绪后备份一次（不弹窗）
                            Start-Job -ScriptBlock {
                                param($app)
                                Import-Module (Join-Path $app 'installer\windows\Aroomo.psm1') -DisableNameChecking
                                Import-Module (Join-Path $app 'installer\standalone\AroomoStandalone.psm1') -DisableNameChecking
                                $ctx = Get-AroomoSAContext
                                if ($ctx -and $ctx.Config['BACKUP_AGE_RECIPIENT']) { [void](Invoke-AroomoSABackup -Context $ctx) }
                            } -ArgumentList $AppDir | Out-Null
                        }
                    } else {
                        Set-State 'red' '有服务没能启动'
                        $script:lastCheck = (Get-Date).AddMinutes(5)   # 失败后 5 分钟内不再自动重试，避免反复重启
                        $tray.ShowBalloonTip(10000, 'Aroomo 没能启动', '有服务没能启动。点这里或托盘菜单里的「修复」。', 'Error')
                    }
                }
                return
            }
            if (((Get-Date) - $script:lastCheck).TotalSeconds -lt 20) { return }
            $script:lastCheck = Get-Date
            $ctx = Get-AroomoSAContext
            if (-not $ctx) { return }
            # 监听表只读一次；进程还在（正在启动，例如稍后启动的完整档模块）的不算「掉了」
            $listen = Get-AroomoSAListeningPorts
            $down = @($ctx.Specs | Where-Object { -not (Test-AroomoSAServiceHealthy -Spec $_ -Paths $ctx.Paths -Listening $listen) -and -not (Test-AroomoSAServiceAlive -Spec $_ -Paths $ctx.Paths) })
            if ($down.Count -gt 0) {
                # D78：有进程退出了就自动重启（start 只启动没在运行的）
                Start-BackgroundStart
            } elseif ($state.Status -ne 'green') {
                Set-State 'green' '正常运行'
            }
        } catch {
            Set-State 'red' '出了点问题，请点「修复」'
        }
    })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
$mutex.ReleaseMutex()
