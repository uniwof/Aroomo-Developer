<#
.SYNOPSIS
  一键卸载 Docker Desktop 和 WSL（D78）。**只在独立版验收通过、数据已经迁移到独立版之后使用。**
  会删除 Docker 版 Aroomo 的全部容器和数据卷（对话、成员、Key 等）。运行前先确认独立版里数据都在。

  步骤：确认两次 → 停止 Docker 版 Aroomo → 卸载 Docker Desktop → 注销 docker-desktop WSL 发行版 →
       关闭「适用于 Linux 的 Windows 子系统」和「虚拟机平台」功能（需要重启）。
  需要管理员权限（会弹出一次「用户账户控制」确认）。安装包不会自动运行这个脚本。
  本文件保存为 UTF-8 带 BOM。
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param([switch]$KeepWslFeature)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($KeepWslFeature) { $a += '-KeepWslFeature' }
    Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $a -Verb RunAs
    return
}

$q1 = [System.Windows.Forms.MessageBox]::Show(
    "这会卸载 Docker Desktop 和 WSL，并删除 Docker 版 Aroomo 的全部数据。`r`n`r`n只有在 Aroomo 独立版已经验收、数据已经迁移过去之后才能这样做。`r`n`r`n要继续吗？",
    '卸载 Docker 和 WSL', 'YesNo', 'Warning', 'Button2')
if ($q1 -ne 'Yes') { return }
$q2 = [System.Windows.Forms.MessageBox]::Show('再确认一次：Docker 版的数据删除后不能恢复。确定要卸载吗？', '卸载 Docker 和 WSL', 'YesNo', 'Warning', 'Button2')
if ($q2 -ne 'Yes') { return }
if (-not $PSCmdlet.ShouldProcess('Docker Desktop + WSL', '卸载')) { return }

$log = Join-Path $env:TEMP ("aroomo-remove-docker-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
Start-Transcript -Path $log | Out-Null
try {
    Write-Host '1/4 停止 Docker 版 Aroomo'
    $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
    if ($docker) {
        & docker.exe ps -q --filter 'label=com.docker.compose.project=aroomo' | ForEach-Object { & docker.exe stop $_ | Out-Null }
    }
    Get-Process 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

    Write-Host '2/4 卸载 Docker Desktop'
    $inst = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop Installer.exe'
    if (Test-Path $inst) {
        $p = Start-Process -FilePath $inst -ArgumentList 'uninstall', '--quiet' -Wait -PassThru
        Write-Host "  退出码 $($p.ExitCode)"
    } else {
        Write-Host '  没有找到 Docker Desktop（可能已经卸载）'
    }

    Write-Host '3/4 注销 Docker 的 WSL 发行版'
    foreach ($d in 'docker-desktop', 'docker-desktop-data') {
        & wsl.exe --unregister $d 2>$null | Out-Null
    }

    if (-not $KeepWslFeature) {
        Write-Host '4/4 关闭 WSL 和虚拟机平台功能'
        & wsl.exe --shutdown 2>$null | Out-Null
        foreach ($f in 'Microsoft-Windows-Subsystem-Linux', 'VirtualMachinePlatform') {
            Disable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart -ErrorAction SilentlyContinue | Out-Null
        }
    }
    [void][System.Windows.Forms.MessageBox]::Show("卸载完成。请重新启动电脑。`r`n记录在：$log", '卸载 Docker 和 WSL', 'OK', 'Information')
} finally {
    Stop-Transcript | Out-Null
}
