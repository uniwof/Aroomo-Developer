<# : Aroomo 主密钥小工具（双击运行）。本文件既是 .cmd 也是 PowerShell 脚本。
@echo off
set AROOMO_MK_FROM_CMD=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; iex ([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8))"
set AROOMO_MK_RC=%errorlevel%
if not "%AROOMO_MK_NONINTERACTIVE%"=="1" pause
exit /b %AROOMO_MK_RC%
#>
# ---------------------------------------------------------------------------
# Aroomo 主密钥小工具（A+，D64）。只做三件事：
#   1. 从 age 官方 GitHub 发布页下载 age，核对 SHA-256（版本与哈希写死，与
#      installer/windows/Get-AgeKeygen.ps1 相同；CI 检查两处一致）。
#   2. 在本机用官方 age-keygen 生成主密钥（这一步不联网）。
#   3. 私钥保存到所有者自己选的位置；屏幕上只显示公钥 age1…，并复制到剪贴板。
# 私钥永不上传、不显示、不进日志、不进聊天。
# 用法：从 GitHub Releases 的 master-key-v1 下载本文件，核对 SHA-256（见 docs/ops/MASTER-KEY.md）后双击。
#   不要从分支 raw 地址下载执行（分支内容会变）。
# 无交互（CI 冒烟）：AROOMO_MK_NONINTERACTIVE=1，AROOMO_MK_OUT=私钥文件完整路径；
#   标准输出只有一行公钥。
# 文件必须是 UTF-8 不带 BOM（带 BOM 会让 .cmd 第一行失效）。
# ---------------------------------------------------------------------------

$script:AgeVersion = 'v1.2.1'
$script:AgeZipUrl = "https://github.com/FiloSottile/age/releases/download/$($script:AgeVersion)/age-$($script:AgeVersion)-windows-amd64.zip"
# age v1.2.1 windows-amd64 zip 的 SHA-256（2026-10-28 计算，与 Get-AgeKeygen.ps1 相同）
$script:AgeZipSha256 = '46db0db71f146061f7c8fffa912cb806aef1bc8450e27a3abc1744f0591b89fb'

function Invoke-AroomoMasterKeyTool {
    $quiet = ($env:AROOMO_MK_NONINTERACTIVE -eq '1')
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $work = Join-Path ([IO.Path]::GetTempPath()) ("aroomo-mk-{0}" -f [Guid]::NewGuid())
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

    try {
        if (-not $quiet) {
            try { $Host.UI.RawUI.WindowTitle = 'Aroomo 主密钥' } catch { Write-Verbose 'title' }
            try {
                Add-Type -AssemblyName System.Speech
                $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
                try { $voice.SelectVoiceByHints('NotSet', 'NotSet', 0, [Globalization.CultureInfo]'zh-CN') } catch { Write-Verbose 'no zh voice' }
            } catch { $voice = $null }
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            Say '第 1 步：下载官方 age 工具，核对指纹……' 'Cyan'
            Speak '开始生成主密钥。先下载官方工具。'
        }

        # 1. 下载并核对 SHA-256
        New-Item -ItemType Directory -Path $work -Force | Out-Null
        $zip = Join-Path $work 'age.zip'
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { Write-Verbose 'tls' }
        Invoke-WebRequest -Uri $script:AgeZipUrl -OutFile $zip -UseBasicParsing
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
        if ($actual -ne $script:AgeZipSha256) { throw "下载的 age 指纹不对，已停止（$actual）。请告诉 Hark。" }
        Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
        $keygen = Join-Path $work 'age\age-keygen.exe'
        if (-not (Test-Path -LiteralPath $keygen)) { throw '压缩包里没有 age-keygen.exe' }

        # 2. 本机生成（不联网）。age-keygen 不带 -o：私钥只从 stdout 管道读进内存，
#    从不写进临时目录（临时目录里只有 age.zip 和解压出的程序）；唯一落盘处是第 3 步所有者选的位置。
        Say '第 2 步：在这台电脑上生成主密钥（不联网）……' 'Cyan'
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $keygen
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        [void]$p.StandardError.ReadToEnd()
        $p.WaitForExit()
        if ($p.ExitCode -ne 0) { throw "age-keygen 出错（退出码 $($p.ExitCode)）" }
        $identity = $null; $public = $null
        foreach ($line in ($out -split "`r?`n")) {
            $t = $line.Trim()
            if ($t -cmatch '^AGE-SECRET-KEY-1[0-9A-Z]{58}$') { $identity = $t }
            elseif ($t -cmatch '^#\s*public key:\s*(age1[0-9a-z]{58})$') { $public = $Matches[1] }
        }
        $out = $null
        if (-not $identity -or -not $public) { throw 'age-keygen 输出不完整' }

        # 私钥文件内容：age 身份文件格式（# 开头是注释），附抄写用分组
        $body = $identity.Substring('AGE-SECRET-KEY-1'.Length)
        $groups = for ($i = 0; $i -lt $body.Length; $i += 4) { $body.Substring($i, [Math]::Min(4, $body.Length - $i)) }
        $groupLines = for ($i = 0; $i -lt $groups.Count; $i += 6) { '#   ' + ($groups[$i..([Math]::Min($i + 6, $groups.Count) - 1)] -join ' ') }
        $content = @(
            '# Aroomo 主密钥（私钥）。谁拿到它就能打开全部备份。不要发给任何人，不要发进聊天。'
            '# 存两份：U 盘一份，抄在纸上一份。丢了就再也打不开备份。'
            "# created: $((Get-Date).ToString('yyyy-MM-dd HH:mm'))"
            "# public key: $public"
            '# 抄写用：AGE-SECRET-KEY-1 后面每 4 个字符一组'
        ) + $groupLines + @($identity, '')
        $identity = $null; $body = $null; $groups = $null; $groupLines = $null

        # 3. 保存到所有者自己选的位置
        if ($quiet) {
            $path = $env:AROOMO_MK_OUT
            if (-not $path) { throw '无交互模式需要 AROOMO_MK_OUT' }
        } else {
            Say '第 3 步：选一个地方保存私钥。最好直接存到 U 盘。' 'Yellow'
            Say '如果没看到保存窗口，按 Alt+Tab 切换过去。' 'Yellow'
            Speak '请选择保存私钥的位置，最好是 U 盘。'
            $usb = [IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Removable' -and $_.IsReady } | Select-Object -First 1
            $dir = if ($usb) { $usb.RootDirectory.FullName } else { [Environment]::GetFolderPath('Desktop') }
            $path = $null
            # 保存对话框挂到一个置顶的隐藏窗体上，避免它出现在控制台窗口后面
            $owner = New-Object System.Windows.Forms.Form
            $owner.TopMost = $true
            $owner.ShowInTaskbar = $false
            $owner.StartPosition = 'CenterScreen'
            $owner.FormBorderStyle = 'None'
            $owner.Opacity = 0
            $owner.Size = New-Object System.Drawing.Size(1, 1)
            try {
            [void]$owner.Show(); $owner.Activate()
            for ($try = 0; $try -lt 3 -and -not $path; $try++) {
                $dlg = New-Object System.Windows.Forms.SaveFileDialog
                $dlg.Title = '保存 Aroomo 主密钥（私钥）'
                $dlg.InitialDirectory = $dir
                $dlg.FileName = 'aroomo-master-key.txt'
                $dlg.Filter = '文本文件 (*.txt)|*.txt'
                $dlg.OverwritePrompt = $true
                if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $path = $dlg.FileName }
                else { Say '还没有保存。私钥必须先存好，才会给你公钥。' 'Yellow'; Speak '还没有保存，请再选一次。' }
            }
            } finally { $owner.Dispose() }
            if (-not $path) { throw '没有保存私钥，已放弃这次生成（什么都没留下）。可以再运行一次。' }
        }
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($path, ($content -join "`r`n"), $utf8)
        $back = [IO.File]::ReadAllText($path, $utf8)
        if ($back -ne ($content -join "`r`n")) { throw '私钥文件写入后核对不一致，请换个位置再运行一次。' }
        $back = $null; $content = $null

        # 4. 只显示公钥
        if ($quiet) { [Console]::Out.WriteLine($public); return 0 }
        try { Set-Clipboard -Value $public } catch { Write-Verbose 'clipboard' }
        Say '完成。私钥已保存到：' 'Green'
        Say $path 'Green'
        Say '下面是公钥（可以公开），已经复制好了，直接粘贴给 Hark：' 'Green'
        Write-Host ''
        Write-Host ("  " + $public) -ForegroundColor Black -BackgroundColor Yellow
        Say '记得：私钥再存一份到 U 盘，并抄在纸上。' 'Yellow'
        Speak '完成。公钥已经复制好了，直接粘贴给 Hark。私钥请再存一份到 U 盘，并抄在纸上。'

        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Aroomo 公钥（已复制）'
        $form.StartPosition = 'CenterScreen'
        $form.Width = 1200; $form.Height = 520
        $form.TopMost = $true
        $label = New-Object System.Windows.Forms.Label
        $label.Text = "公钥已复制。直接粘贴给 Hark。`r`n私钥：U 盘一份，纸上一份。"
        $label.Font = New-Object System.Drawing.Font('Microsoft YaHei', 22)
        $label.SetBounds(30, 20, 1120, 110)
        $box = New-Object System.Windows.Forms.TextBox
        $box.Multiline = $true; $box.ReadOnly = $true; $box.WordWrap = $true
        $box.Text = $public
        $box.Font = New-Object System.Drawing.Font('Consolas', 26)
        $box.SetBounds(30, 140, 1120, 150)
        $copy = New-Object System.Windows.Forms.Button
        $copy.Text = '再复制一次'
        $copy.Font = New-Object System.Drawing.Font('Microsoft YaHei', 20)
        $copy.SetBounds(30, 320, 400, 90)
        $copy.Add_Click({ try { Set-Clipboard -Value $public } catch { Write-Verbose 'clipboard' } }.GetNewClosure())
        $ok = New-Object System.Windows.Forms.Button
        $ok.Text = '好了'
        $ok.Font = New-Object System.Drawing.Font('Microsoft YaHei', 20)
        $ok.SetBounds(750, 320, 400, 90)
        $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.AcceptButton = $ok
        $form.Controls.AddRange(@($label, $box, $copy, $ok))
        [void]$form.ShowDialog()
        return 0
    } catch {
        if ($quiet) { [Console]::Error.WriteLine("错误：$($_.Exception.Message)") }
        else {
            Say ("出错了：" + $_.Exception.Message) 'Red'
            Speak '出错了，请告诉 Hark。'
        }
        return 1
    } finally {
        $identity = $null; $content = $null; $out = $null
        if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
        if ($voice) { $voice.Dispose() }
    }
}

$aroomoMkRc = Invoke-AroomoMasterKeyTool
if ($env:AROOMO_MK_FROM_CMD -eq '1') { exit $aroomoMkRc }
if ($aroomoMkRc -ne 0 -and $env:AROOMO_MK_NONINTERACTIVE -ne '1') { [void](Read-Host '  按回车键关闭') }
