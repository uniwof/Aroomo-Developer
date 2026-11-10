# Pester 5 测试：本机执行员 Windows 安装 / 更新脚本（#232，M3 验收 1）。
# 只测验收标准和红线：能解析、5.1 能读中文（BOM）、令牌不进输出、缺 Node 时给出人话、更新脚本在非 git 目录安全退出。
# 真正的「一次装成」由 executor.yml 的 windows-install 作业实跑；这里不装依赖、不注册计划任务。

# -Skip 在发现阶段求值，早于 BeforeAll，所以放在最外层
$script:OnWindows = ($env:OS -eq 'Windows_NT')

BeforeAll {
    $script:Here = Split-Path -Parent $PSCommandPath
    $script:ScriptsDir = (Resolve-Path (Join-Path $script:Here '..\..\scripts')).Path
    $script:Install = Join-Path $script:ScriptsDir 'install-windows.ps1'
    $script:Update = Join-Path $script:ScriptsDir 'update-windows.ps1'
    function script:Get-ParsedAst([string]$Path) {
        $errors = $null
        $tokens = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
        [pscustomobject]@{ Ast = $ast; Errors = @($errors) }
    }
}

Describe '安装脚本 install-windows.ps1' {
    It '能被解析，没有语法错误' {
        (Get-ParsedAst $script:Install).Errors.Count | Should -Be 0
    }

    It '带 UTF-8 BOM（Windows PowerShell 5.1 才不会把中文读成乱码）' {
        $b = [IO.File]::ReadAllBytes($script:Install)
        $b[0] | Should -Be 0xEF
        $b[1] | Should -Be 0xBB
        $b[2] | Should -Be 0xBF
    }

    It '开头把控制台输出设为 UTF-8（读屏读 node 的中文不乱码）' {
        (Get-Content -Raw -Encoding UTF8 $script:Install) | Should -Match 'OutputEncoding\s*=\s*New-Object System\.Text\.UTF8Encoding'
    }

    It '提供 NoAutostart / NoAutoUpdate / SkipToken / TaskName 四个参数' {
        $names = (Get-ParsedAst $script:Install).Ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }
        foreach ($n in 'NoAutostart', 'NoAutoUpdate', 'SkipToken', 'TaskName') { $names | Should -Contain $n }
    }

    It '令牌变量从不进入任何输出语句（红线：令牌不进日志）' {
        $ast = (Get-ParsedAst $script:Install).Ast
        $cmds = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true)
        $out = $cmds | Where-Object { $_.GetCommandName() -in 'Write-Output', 'Write-Host', 'Write-Step', 'Write-Verbose', 'Write-Warning', 'Out-File', 'Add-Content', 'Set-Content' }
        foreach ($c in $out) { $c.Extent.Text | Should -Not -Match '\$plain|\$secure|\$cfSecret|\$cred\b|\$env:AROOMO_EXECUTOR_TOKEN|\$env:AROOMO_CF_ACCESS_CLIENT_SECRET' }
    }

    It '计划任务运行身份是当前用户、仅登录时（不是 SYSTEM；DPAPI 按当前用户加密，#376 M5）' {
        $text = Get-Content -LiteralPath $script:Install -Raw -Encoding UTF8
        $text | Should -Match 'New-ScheduledTaskPrincipal -UserId \(\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.Name\) -LogonType Interactive'
        $text | Should -Not -MatchExactly 'NT AUTHORITY|\bSYSTEM\b|ServiceAccount|-RunLevel Highest'
        ([regex]::Matches($text, 'Register-ScheduledTask ')).Count | Should -Be ([regex]::Matches($text, '-Principal \$principal')).Count
    }

    It '远程安装用凭据文件：只有路径进命令行，读完覆盖并删除，给了凭据文件就不弹输入（#376 M7）' {
        $text = Get-Content -LiteralPath $script:Install -Raw -Encoding UTF8
        $text | Should -Match '\[string\]\$CredentialFile'
        $text | Should -Match 'WriteAllBytes\(\$CredentialFile'
        $text | Should -Match 'Remove-Item -LiteralPath \$CredentialFile -Force'
        $text | Should -Match 'if \(-not \$plain -and -not \$CredentialFile\)'
    }

    It '令牌文件收紧为只有当前用户可读，且不在命令行里带令牌' {
        $text = Get-Content -LiteralPath $script:Install -Raw -Encoding UTF8
        $text | Should -Match 'icacls \$tokenFile /inheritance:r /grant:r'
        $text | Should -Not -Match 'Invoke-Expression|\biex\b'
    }

    It 'Node.js 找不到时给出人话并以失败退出（不是一堆红字栈）' -Skip:(-not $script:OnWindows) {
        $empty = Join-Path ([IO.Path]::GetTempPath()) ('aroomo-nonode-' + [guid]::NewGuid())
        New-Item -ItemType Directory -Path $empty | Out-Null
        try {
            $ps = (Get-Command powershell.exe).Source
            $cmd = "`$env:PATH = '$empty'; & '$($script:Install)' -NoAutostart -SkipToken"
            $ErrorActionPreference = 'Continue' # 子进程的错误输出在 Pester 里会变成终止错误，这里只看输出和退出码
            $out = & $ps -NoProfile -ExecutionPolicy Bypass -Command $cmd 2>&1 | Out-String
            $LASTEXITCODE | Should -Not -Be 0
            $out | Should -Match 'Node\.js'
        } finally { Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Describe '更新脚本 update-windows.ps1' {
    It '能被解析，没有语法错误' {
        (Get-ParsedAst $script:Update).Errors.Count | Should -Be 0
    }

    It '开头把控制台输出设为 UTF-8（读屏读 node 的中文不乱码）' {
        (Get-Content -Raw -Encoding UTF8 $script:Update) | Should -Match 'OutputEncoding\s*=\s*New-Object System\.Text\.UTF8Encoding'
    }

    It '带 UTF-8 BOM' {
        $b = [IO.File]::ReadAllBytes($script:Update)
        $b[0] | Should -Be 0xEF
        $b[1] | Should -Be 0xBB
        $b[2] | Should -Be 0xBF
    }

    It '失败时回到更新前的提交，且不碰配置和令牌' {
        $text = Get-Content -LiteralPath $script:Update -Raw -Encoding UTF8
        $text | Should -Match 'git reset --hard \$before'
        $text | Should -Not -Match 'device-token|config\.json'
    }

    It '不在 git 分支上（下载的压缩包）时安全跳过，退出码 0' -Skip:(-not $script:OnWindows) {
        $root = Join-Path ([IO.Path]::GetTempPath()) ('aroomo-upd-' + [guid]::NewGuid())
        $dir = Join-Path $root 'executor\scripts'
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        try {
            Copy-Item -LiteralPath $script:Update -Destination $dir
            $ps = (Get-Command powershell.exe).Source
            & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'update-windows.ps1') -NoRestart | Out-Null
            $LASTEXITCODE | Should -Be 0
        } finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
    }
}
