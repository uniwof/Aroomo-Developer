# 主密钥小工具的回归测试（#248，负责人 #192 补审必改）：没插 U 盘就停、不默认存桌面；OneDrive 下的位置警告并不写文件。
# 不联网、不弹窗、不生成真私钥：AROOMO_MK_LOAD_ONLY=1 只加载函数。
# 运行：powershell -NoProfile -ExecutionPolicy Bypass -File tools/master-key/MasterKey.Tests.ps1（pwsh 也可以）
$ErrorActionPreference = 'Stop'
$failed = 0
function Check([string]$name, [bool]$ok) {
    if ($ok) { Write-Output "ok   $name" } else { Write-Output "FAIL $name"; $script:failed++ }
}
$tool = Join-Path $PSScriptRoot 'New-AroomoMasterKey.cmd'
$src = [IO.File]::ReadAllText($tool, [Text.Encoding]::UTF8)
$env:AROOMO_MK_LOAD_ONLY = '1'
Invoke-Expression $src
$env:AROOMO_MK_LOAD_ONLY = $null

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mk-test-{0}" -f [Guid]::NewGuid())
$od = Join-Path $tmp 'OneDrive - Contoso'
$other = Join-Path $tmp 'Keys'
New-Item -ItemType Directory -Path (Join-Path $od 'Desktop'), $other -Force | Out-Null
$saved = @{ OneDrive = $env:OneDrive; OneDriveConsumer = $env:OneDriveConsumer; OneDriveCommercial = $env:OneDriveCommercial; NI = $env:AROOMO_MK_NONINTERACTIVE; OUT = $env:AROOMO_MK_OUT }
try {
    # 1. 不再默认存桌面
    Check '脚本里没有回退到桌面' (-not $src.Contains("GetFolderPath('Desktop')"))

    # 2. 没插 U 盘：停下并提示先插 U 盘
    $msg = $null
    try { [void](Get-AroomoKeyDir -Drives @()) } catch { $msg = $_.Exception.Message }
    Check '没有 U 盘 → 报「请先插 U 盘」' ($msg -and $msg.Contains('请先插 U 盘'))
    $fixed = [pscustomobject]@{ DriveType = 'Fixed'; IsReady = $true; RootDirectory = [pscustomobject]@{ FullName = 'C:\' } }
    $msg = $null
    try { [void](Get-AroomoKeyDir -Drives @($fixed)) } catch { $msg = $_.Exception.Message }
    Check '只有本地硬盘 → 也停' ($msg -and $msg.Contains('请先插 U 盘'))
    $usb = [pscustomobject]@{ DriveType = 'Removable'; IsReady = $true; RootDirectory = [pscustomobject]@{ FullName = 'E:\' } }
    $notReady = [pscustomobject]@{ DriveType = 'Removable'; IsReady = $false; RootDirectory = [pscustomobject]@{ FullName = 'D:\' } }
    Check '插了 U 盘 → 默认打开 U 盘' ((Get-AroomoKeyDir -Drives @($fixed, $notReady, $usb)) -eq 'E:\')

    # 2b. 双击运行（有界面）且没插 U 盘：先停，不下载 age、不生成、不写文件
    $script:downloaded = $false
    function Invoke-WebRequest { $script:downloaded = $true }
    $realKeyDir = ${function:Get-AroomoKeyDir}
    function Get-AroomoKeyDir { & $realKeyDir -Drives @() }
    $env:AROOMO_MK_NONINTERACTIVE = $null
    $rc = Invoke-AroomoMasterKeyTool 6>$null
    Check '有界面、没 U 盘 → 退出码 1' ($rc -eq 1)
    Check '有界面、没 U 盘 → 没下载 age（还没开始生成）' (-not $script:downloaded)
    Set-Item function:Get-AroomoKeyDir $realKeyDir
    Remove-Item function:Invoke-WebRequest

    # 3. OneDrive 路径判定（$env:OneDrive / OneDriveConsumer / OneDriveCommercial，不分大小写）
    $env:OneDrive = $od; $env:OneDriveConsumer = $null; $env:OneDriveCommercial = $null
    Check 'OneDrive 下的桌面算' (Test-AroomoOneDrivePath (Join-Path $od 'Desktop\aroomo-master-key.txt'))
    Check 'OneDrive 根目录本身算' (Test-AroomoOneDrivePath $od)
    Check '大小写不同也算' (Test-AroomoOneDrivePath ((Join-Path $od 'a.txt').ToUpperInvariant()))
    Check '名字相近的兄弟目录不算' (-not (Test-AroomoOneDrivePath ($od + 'X\a.txt')))
    Check '别的目录不算' (-not (Test-AroomoOneDrivePath (Join-Path $other 'a.txt')))
    $env:OneDrive = $null; $env:OneDriveCommercial = $od
    Check 'OneDriveCommercial 也查' (Test-AroomoOneDrivePath (Join-Path $od 'a.txt'))
    $env:OneDriveCommercial = $null
    Check '没装 OneDrive → 都不算' (-not (Test-AroomoOneDrivePath (Join-Path $od 'a.txt')))

    # 4. 无交互模式选到 OneDrive 下：失败、不写任何文件（在下载 age 之前就停，不联网）
    $env:OneDrive = $od
    $env:AROOMO_MK_NONINTERACTIVE = '1'
    $key = Join-Path $od 'Desktop\aroomo-master-key.txt'
    $env:AROOMO_MK_OUT = $key
    $rc = Invoke-AroomoMasterKeyTool 2>$null
    Check '存到 OneDrive 下 → 退出码 1' ($rc -eq 1)
    Check '存到 OneDrive 下 → 没写私钥文件' (-not (Test-Path -LiteralPath $key))
} finally {
    $env:OneDrive = $saved.OneDrive; $env:OneDriveConsumer = $saved.OneDriveConsumer; $env:OneDriveCommercial = $saved.OneDriveCommercial
    $env:AROOMO_MK_NONINTERACTIVE = $saved.NI; $env:AROOMO_MK_OUT = $saved.OUT
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Output "$failed 条失败"; exit 1 }
Write-Output '全部通过'
