<# : Aroomo 备份本机核对（恢复演练，双击运行）。本文件既是 .cmd 也是 PowerShell 脚本。
@echo off
set AROOMO_RD_FROM_CMD=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8))"
set AROOMO_RD_RC=%errorlevel%
if not "%AROOMO_RD_NONINTERACTIVE%"=="1" pause
exit /b %AROOMO_RD_RC%
#>
# ---------------------------------------------------------------------------
# Aroomo 备份本机核对（A+，D64；D199 红线第 4 条「R2 加密备份能恢复」的所有者侧演练）。
# 用 U 盘里的主密钥（私钥）在本机解开一份服务器备份，只取出清单和逐表行数，显示核对结果。
#   1. 从官方发布页下载 age（与主密钥小工具同版本同 SHA-256）和 zstd，核对 SHA-256。
#   2. 找私钥：U 盘根目录的 aroomo-master-key.txt（找不到就弹窗让所有者选）。
#   3. 找备份：「下载」文件夹里最新的 aroomo-*.tar.zst.age（找不到就弹窗选）。
#   4. 解密 → 解压 → 列出全部文件（整份读完：age 每块都带校验，坏一个字节就失败），
#      只把 manifest.json 和 *.counts.tsv 写进临时目录；数据库内容和 .env 不落盘。
#   5. 显示并朗读结果，结果（不含任何密钥）复制到剪贴板；删除临时目录。
# 私钥只交给 age.exe 读取：不显示、不复制、不上传、不进日志。不连服务器，不改任何数据。
# 无交互（CI 冒烟）：AROOMO_RD_NONINTERACTIVE=1，AROOMO_RD_KEY=私钥文件，AROOMO_RD_FILE=备份文件；
#   标准输出只有一行结果。
# 文件必须是 UTF-8 不带 BOM、CRLF。
# ---------------------------------------------------------------------------

$script:AgeVersion = 'v1.2.1'
$script:AgeZipUrl = "https://github.com/FiloSottile/age/releases/download/$($script:AgeVersion)/age-$($script:AgeVersion)-windows-amd64.zip"
# 与 tools/master-key/New-AroomoMasterKey.cmd、installer/windows/Get-AgeKeygen.ps1 相同（CI 检查一致）
$script:AgeZipSha256 = '46db0db71f146061f7c8fffa912cb806aef1bc8450e27a3abc1744f0591b89fb'
$script:ZstdVersion = 'v1.5.7'
$script:ZstdZipUrl = "https://github.com/facebook/zstd/releases/download/$($script:ZstdVersion)/zstd-$($script:ZstdVersion)-win64.zip"
# zstd v1.5.7 win64 zip 的 SHA-256：由 Hark 和负责人各自从官方发布页下载核对（2026-10-31，结果一致）；官方未公布此文件的哈希
$script:ZstdZipSha256 = 'acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9'

function Invoke-AroomoRestoreDrill {
    $quiet = ($env:AROOMO_RD_NONINTERACTIVE -eq '1')
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $work = Join-Path ([IO.Path]::GetTempPath()) ("aroomo-rd-{0}" -f [Guid]::NewGuid())
    $voice = $null

    function Say([string]$text, [string]$color = 'White') {
        if ($quiet) { return }
        Write-Host ''
        Write-Host ("  " + $text) -ForegroundColor $color
    }
    function Speak([string]$text) {
        if ($quiet -or -not $voice) { return }
        try { $voice.Speak($text) } catch { Write-Verbose 'speech failed' }
    }
    function Get-Pinned([string]$url, [string]$sha, [string]$name) {
        $zip = Join-Path $work "$name.zip"
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
        if ($actual -ne $sha) { throw "下载的 $name 指纹不对，已停止（$actual）。请告诉 Hark。" }
        $dir = Join-Path $work $name
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
        return $dir
    }
    function Invoke-Cmd([string]$line) {
        # 用 ProcessStartInfo 原样传命令行，避开 PowerShell 5.1 给原生程序传引号的问题
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
        $psi.Arguments = '/d /s /c "' + $line + '"'
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $p.WaitForExit()
        return $p.ExitCode
    }
    function Pick-File([string]$title, [string]$filter, [string]$dir) {
        if ($quiet) { return $null }
        $dlg = New-Object System.Windows.Forms.OpenFileDialog
        $dlg.Title = $title
        $dlg.Filter = $filter
        if ($dir -and (Test-Path -LiteralPath $dir)) { $dlg.InitialDirectory = $dir }
        if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $dlg.FileName }
        return $null
    }

    try {
        if (-not $quiet) {
            try { $Host.UI.RawUI.WindowTitle = 'Aroomo 备份核对' } catch { Write-Verbose 'title' }
            try {
                Add-Type -AssemblyName System.Speech
                $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
                try { $voice.SelectVoiceByHints('NotSet', 'NotSet', 0, [Globalization.CultureInfo]'zh-CN') } catch { Write-Verbose 'no zh voice' }
            } catch { $voice = $null }
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            Say '第 1 步：下载官方 age 和 zstd 工具，核对指纹……' 'Cyan'
            Speak '开始核对备份。先下载官方工具。'
        }

        # 1. 工具
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        $ageDir = Get-Pinned $script:AgeZipUrl $script:AgeZipSha256 'age'
        $zstdDir = Get-Pinned $script:ZstdZipUrl $script:ZstdZipSha256 'zstd'
        $age = Join-Path $ageDir 'age\age.exe'
        $zstd = Join-Path $zstdDir "zstd-$($script:ZstdVersion)-win64\zstd.exe"
        $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
        foreach ($t in @($age, $zstd, $tar)) { if (-not (Test-Path -LiteralPath $t)) { throw "找不到工具：$t" } }

        # 2. 私钥
        Say '第 2 步：找 U 盘里的主密钥……' 'Cyan'
        $key = $env:AROOMO_RD_KEY
        if (-not $key) {
            foreach ($d in ([IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Removable' -and $_.IsReady })) {
                $c = Join-Path $d.RootDirectory.FullName 'aroomo-master-key.txt'
                if (Test-Path -LiteralPath $c) { $key = $c; break }
            }
        }
        if (-not $key) {
            Say '没在 U 盘根目录找到 aroomo-master-key.txt，请在弹出的窗口里选它。如果没看到选择窗口，按 Alt+Tab 切换过去。' 'Yellow'
            Speak '没找到主密钥文件，请在窗口里选择。如果没看到选择窗口，按 Alt+Tab 切换过去。'
            $key = Pick-File '选择 Aroomo 主密钥文件（aroomo-master-key.txt）' '主密钥 (*.txt)|*.txt|所有文件 (*.*)|*.*' ''
        }
        if (-not $key -or -not (Test-Path -LiteralPath $key)) { throw '没有主密钥文件，已停止。插上 U 盘后再运行一次。' }

        # 3. 备份文件
        Say '第 3 步：找下载好的备份文件……' 'Cyan'
        $file = $env:AROOMO_RD_FILE
        $downloads = $null
        if (-not $file) {
            try { $downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path } catch { $downloads = Join-Path $env:USERPROFILE 'Downloads' }
            foreach ($dir in @($downloads, [Environment]::GetFolderPath('Desktop'))) {
                if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
                $f = Get-ChildItem -LiteralPath $dir -Filter 'aroomo-*.tar.zst.age' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
                if ($f) { $file = $f.FullName; break }
            }
        }
        if (-not $file) {
            Say '没在「下载」文件夹找到备份文件，请在弹出的窗口里选它。如果没看到选择窗口，按 Alt+Tab 切换过去。' 'Yellow'
            Speak '没找到备份文件，请在窗口里选择。如果没看到选择窗口，按 Alt+Tab 切换过去。'
            $file = Pick-File '选择 Aroomo 备份文件（aroomo-…tar.zst.age）' 'Aroomo 备份 (*.age)|*.age|所有文件 (*.*)|*.*' $downloads
        }
        if (-not $file -or -not (Test-Path -LiteralPath $file)) { throw '没有备份文件，已停止。先点 Hark 发的链接下载备份。' }
        $head = New-Object byte[] 21
        $fs = [IO.File]::OpenRead($file); try { [void]$fs.Read($head, 0, 21) } finally { $fs.Dispose() }
        if ([Text.Encoding]::ASCII.GetString($head) -ne 'age-encryption.org/v1') { throw '这个文件不是 Aroomo 加密备份（开头不对）。' }
        $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()

        # 4. 解密核对。cmd 管道传二进制不变形（PowerShell 5.1 的管道会）。
        Say '第 4 步：用主密钥解开备份并核对（数据库内容不会写到硬盘上）……' 'Cyan'
        Speak '正在解开备份，请稍等。'
        $out = Join-Path $work 'out'; New-Item -ItemType Directory -Path $out -Force | Out-Null
        # 每个程序的错误各写一个文件：cmd 管道两端同时写同一个文件会「另一个程序正在使用此文件」而失败
        $errA = Join-Path $work 'err-age.txt'; $errZ = Join-Path $work 'err-zstd.txt'; $errT = Join-Path $work 'err-tar.txt'
        $list = Join-Path $work 'list.txt'
        $dec = "`"$age`" -d -i `"$key`" `"$file`" 2>`"$errA`" | `"$zstd`" -d -q -c 2>`"$errZ`""
        $rc1 = Invoke-Cmd "$dec | `"$tar`" -tvf - >`"$list`" 2>`"$errT`""
        $errText = (@($errA, $errZ, $errT) | ForEach-Object { if (Test-Path -LiteralPath $_) { [string](Get-Content -LiteralPath $_ -Raw -ErrorAction SilentlyContinue) } }) -join ' '
        $errText = "$errText".Trim()
        if ($errText -match 'no identity matched') { throw '主密钥和这份备份不配对（这份备份是用另一把主密钥加密的）。请告诉 Hark。' }
        if ($rc1 -ne 0 -or $errText -match 'age: error') {
            # 分段诊断（输出都丢进 NUL，不写硬盘）：看是哪一步坏了
            $rcA = Invoke-Cmd "`"$age`" -d -i `"$key`" `"$file`" >NUL 2>NUL"
            $rcZ = Invoke-Cmd "`"$age`" -d -i `"$key`" `"$file`" 2>NUL | `"$zstd`" -t -q 2>NUL"
            $diag = "解密 $rcA，解压 $rcZ，列表 $rc1，tar 存在 $(Test-Path -LiteralPath $tar)"
            throw "解密或解压失败。请把这一整段告诉 Hark。（$diag；$errText）"
        }
        $entries = @(Get-Content -LiteralPath $list -Encoding UTF8 | Where-Object { $_.Trim() })
        # 只取出清单和行数文件：按名字点名（不用 --include，各版本 bsdtar 行为不一）
        $want = @($entries | ForEach-Object { if ($_ -match '(backup-stage/(manifest\.json|db/[^/\s]+\.counts\.tsv))$') { $Matches[1] } })
        if ($want.Count -eq 0) { throw '备份里没有清单文件（不是 Aroomo 服务器备份？）。请告诉 Hark。' }
        $names = ($want | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $err2 = Join-Path $work 'err2.txt'
        $line2 = "$dec | `"$tar`" -xf - -C `"$out`" $names 2>`"$err2`""
        $rc2 = Invoke-Cmd $line2
        if ($rc2 -ne 0) {
            $errText = if (Test-Path -LiteralPath $err2) { (Get-Content -LiteralPath $err2 -Raw -ErrorAction SilentlyContinue) } else { '' }
            if ($quiet) { [Console]::Error.WriteLine("debug: $line2") }
            throw "取出清单失败（$rc2）。请告诉 Hark。$($errText)"
        }
        $manifestPath = Join-Path $out 'backup-stage\manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { throw '备份里没有 manifest.json。请告诉 Hark。' }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $problems = @()
        $dbLines = @()
        $totalTables = 0; [long]$totalRows = 0
        foreach ($db in $manifest.databases) {
            $tsv = Join-Path $out "backup-stage\db\$($db.name).counts.tsv"
            $rows = @(); if (Test-Path -LiteralPath $tsv) { $rows = @(Get-Content -LiteralPath $tsv -Encoding UTF8 | Where-Object { $_.Trim() }) } else { $problems += "$($db.name) 没有行数文件" }
            if ($rows.Count -ne [int]$db.tables) { $problems += "$($db.name) 表数不一致（清单 $($db.tables)，实际 $($rows.Count)）" }
            [long]$n = 0; foreach ($r in $rows) { $p = $r -split "`t"; if ($p.Count -ge 2) { $n += [long]$p[1] } }
            $dump = $entries | Where-Object { $_ -match ("backup-stage/db/" + [regex]::Escape($db.name) + "\.dump$") } | Select-Object -First 1
            if (-not $dump) { $problems += "$($db.name) 没有数据库导出文件" }
            elseif ($dump -match '\s0\s+[A-Za-z]{3}\s') { $problems += "$($db.name) 导出文件大小为 0" }
            $totalTables += $rows.Count; $totalRows += $n
            $dbLines += ("{0}：{1} 张表，{2} 行" -f $db.name, $rows.Count, $n)
        }
        $hasEnv = [bool]($entries | Where-Object { $_ -match 'aroomo\.env$' })
        $ok = ($problems.Count -eq 0 -and @($manifest.databases).Count -gt 0)
        $name = [IO.Path]::GetFileName($file)
        $summary = @(
            ("Aroomo 备份本机核对：{0}" -f $(if ($ok) { '通过' } else { '不通过' }))
            ("备份：{0}（{1}）" -f $name, $manifest.created_at)
            ("SHA-256：{0}" -f $sha)
            ("主密钥：正确（解密成功）")
            ("数据库 {0} 个，共 {1} 张表、{2} 行；条目共 {3} 个（含目录）；含 .env：{4}" -f @($manifest.databases).Count, $totalTables, $totalRows, $entries.Count, $(if ($hasEnv) { '是' } else { '否' }))
        ) + $dbLines + ($problems | ForEach-Object { "问题：$_" })
        $text = $summary -join "`r`n"

        # 5. 结果
        if ($quiet) {
            [Console]::Out.WriteLine(("{0} databases={1} tables={2} rows={3} entries={4} env={5} sha256={6}" -f $(if ($ok) { 'ok' } else { 'fail' }), @($manifest.databases).Count, $totalTables, $totalRows, $entries.Count, $hasEnv.ToString().ToLower(), $sha))
            if ($ok) { return 0 } else { return 1 }
        }
        try { Set-Clipboard -Value $text } catch { Write-Verbose 'clipboard' }
        Say $text $(if ($ok) { 'Green' } else { 'Red' })
        if ($ok) { Speak ("核对通过。主密钥正确，{0} 个数据库，共 {1} 张表。结果已经复制好了，直接粘贴给 Hark。" -f @($manifest.databases).Count, $totalTables) }
        else { Speak '核对没有通过。结果已经复制好了，请粘贴给 Hark。' }

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Aroomo 备份核对（结果已复制）'
        $form.StartPosition = 'CenterScreen'
        $form.Width = 1200; $form.Height = 640
        $form.TopMost = $true
        $label = New-Object System.Windows.Forms.Label
        $label.Text = $(if ($ok) { "核对通过。结果已复制，直接粘贴给 Hark。" } else { "核对没有通过。结果已复制，请粘贴给 Hark。" })
        $label.Font = New-Object System.Drawing.Font('Microsoft YaHei', 22)
        $label.SetBounds(30, 20, 1120, 70)
        $box = New-Object System.Windows.Forms.TextBox
        $box.Multiline = $true; $box.ReadOnly = $true; $box.WordWrap = $true; $box.ScrollBars = 'Vertical'
        $box.Text = $text
        $box.Font = New-Object System.Drawing.Font('Microsoft YaHei', 16)
        $box.SetBounds(30, 100, 1120, 360)
        $ok2 = New-Object System.Windows.Forms.Button
        $ok2.Text = '好了'
        $ok2.Font = New-Object System.Drawing.Font('Microsoft YaHei', 20)
        $ok2.SetBounds(750, 480, 400, 90)
        $ok2.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.AcceptButton = $ok2
        $form.Controls.AddRange(@($label, $box, $ok2))
        [void]$form.ShowDialog()
        if ($ok) { return 0 } else { return 1 }
    } catch {
        if ($quiet) { [Console]::Error.WriteLine("错误：$($_.Exception.Message)") }
        else {
            Say ("出错了：" + $_.Exception.Message) 'Red'
            Speak '出错了，请告诉 Hark。'
        }
        return 1
    } finally {
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
        if ($voice) { $voice.Dispose() }
    }
}

$aroomoRdRc = Invoke-AroomoRestoreDrill
if ($env:AROOMO_RD_FROM_CMD -eq '1') { exit $aroomoRdRc }
if ($aroomoRdRc -ne 0 -and $env:AROOMO_RD_NONINTERACTIVE -ne '1') { [void](Read-Host '  按回车键关闭') }
