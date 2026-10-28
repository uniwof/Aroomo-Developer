# Pester 5 测试：Windows 安装器的纯逻辑部分（档位、内存、版本检查、.env 生成、Compose 文件组合、端口、文件编码）。
# 在 windows-latest（Windows PowerShell 5.1）和 ubuntu（pwsh 7）上都跑。
# 不安装 Docker Desktop，不改系统设置。

BeforeAll {
    $script:Here = Split-Path -Parent $PSCommandPath
    $script:WinDir = Split-Path -Parent $script:Here
    $script:Root = (Resolve-Path (Join-Path $script:WinDir '..\..')).Path
    Import-Module (Join-Path $script:WinDir 'Aroomo.psm1') -Force

    function script:Find-Bash {
        $candidates = @()
        if ($env:OS -eq 'Windows_NT') {
            $candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')
        } else {
            $c = Get-Command bash -ErrorAction SilentlyContinue
            if ($c) { $candidates += $c.Source }
        }
        foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
        return $null
    }
}

Describe 'Get-AroomoTier' {
    It '<mb> MB → <tier>' -ForEach @(
        @{ mb = 1; tier = 'demo-2g' }, @{ mb = 1900; tier = 'demo-2g' }, @{ mb = 3499; tier = 'demo-2g' },
        @{ mb = 3500; tier = 'standard' }, @{ mb = 3900; tier = 'standard' }, @{ mb = 6999; tier = 'standard' },
        @{ mb = 7000; tier = 'full' }, @{ mb = 7700; tier = 'full' }, @{ mb = 8192; tier = 'full' }, @{ mb = 65536; tier = 'full' }
    ) {
        Get-AroomoTier -MemoryMB $mb | Should -Be $tier
    }

    It '与 scripts/select-tier.sh 对同一组输入给出相同档位' {
        $bash = Find-Bash
        if (-not $bash) { Set-ItResult -Skipped -Because '找不到 bash'; return }
        $sh = Join-Path $script:Root 'scripts/select-tier.sh'
        foreach ($mb in 1, 1024, 2048, 3499, 3500, 4096, 6999, 7000, 7600, 8192, 16384) {
            $env:MEM_TOTAL_MB = "$mb"
            try { $fromSh = (& $bash $sh).Trim() } finally { Remove-Item Env:MEM_TOTAL_MB }
            $fromPs = Get-AroomoTier -MemoryMB $mb
            "$mb=$fromPs" | Should -Be "$mb=$fromSh"
        }
    }
}

Describe 'Get-AroomoEffectiveMemoryMB（WSL2 能用的内存）' {
    It '没有 .wslconfig：主机内存的一半（16 GB 电脑 → 8 GB → 完整版）' {
        $eff = Get-AroomoEffectiveMemoryMB -HostMemoryMB 16384
        $eff | Should -Be 8192
        Get-AroomoTier -MemoryMB $eff | Should -Be 'full'
    }
    It '读取 [wsl2] memory=10GB' {
        Get-AroomoEffectiveMemoryMB -HostMemoryMB 16384 -WslConfigText "[wsl2]`r`nmemory=10GB`r`nprocessors=4" | Should -Be 10240
    }
    It '读取 memory = 6144MB（带空格）' {
        Get-AroomoEffectiveMemoryMB -HostMemoryMB 16384 -WslConfigText "[wsl2]`nmemory = 6144MB" | Should -Be 6144
    }
    It '忽略其他小节里的 memory' {
        Get-AroomoEffectiveMemoryMB -HostMemoryMB 16384 -WslConfigText "[experimental]`nmemory=2GB" | Should -Be 8192
    }
    It '不超过主机内存' {
        Get-AroomoEffectiveMemoryMB -HostMemoryMB 8192 -WslConfigText "[wsl2]`nmemory=32GB" | Should -Be 8192
    }
    It '8 GB 电脑默认只有 4 GB → 标准版' {
        Get-AroomoTier -MemoryMB (Get-AroomoEffectiveMemoryMB -HostMemoryMB 8192) | Should -Be 'standard'
    }
}

Describe 'Test-AroomoWindowsBuild' {
    It '<build> → <ok>' -ForEach @(
        @{ build = 17763; ok = $false }, @{ build = 19044; ok = $false }, @{ build = 19045; ok = $true },
        @{ build = 22000; ok = $true }, @{ build = 26100; ok = $true }
    ) {
        $r = Test-AroomoWindowsBuild -Build $build
        $r.Ok | Should -Be $ok
        $r.Message | Should -Not -BeNullOrEmpty
    }
}

Describe 'Get-AroomoVirtualizationState' {
    It '已有虚拟机监控程序 → ok（此时固件标志会是 False）' {
        Get-AroomoVirtualizationState -HypervisorPresent $true -FirmwareEnabled $false | Should -Be 'ok'
    }
    It '固件已开启 → ok' {
        Get-AroomoVirtualizationState -HypervisorPresent $false -FirmwareEnabled $true | Should -Be 'ok'
    }
    It '都没有 → disabled' {
        Get-AroomoVirtualizationState -HypervisorPresent $false -FirmwareEnabled $false | Should -Be 'disabled'
    }
}

Describe '密钥生成' {
    It 'New-AroomoSecret：64 位十六进制，每次不同' {
        $a = New-AroomoSecret; $b = New-AroomoSecret
        $a | Should -Match '^[0-9a-f]{64}$'
        $a | Should -Not -Be $b
    }
    It 'New-AroomoJwks：合法的 RS256 JWK Set，含私钥参数' {
        $j = New-AroomoJwks | ConvertFrom-Json
        $k = @($j.keys)[0]
        $k.kty | Should -Be 'RSA'
        $k.alg | Should -Be 'RS256'
        $k.e | Should -Be 'AQAB'
        foreach ($f in 'n', 'd', 'p', 'q', 'dp', 'dq', 'qi') { $k.$f | Should -Match '^[A-Za-z0-9_-]+$' }
        $k.n.Length | Should -BeGreaterThan 300
    }
}

Describe 'ConvertTo-AroomoEnv（以 deploy/.env.example 为模板）' {
    BeforeAll {
        $script:Template = [IO.File]::ReadAllText((Join-Path $script:Root 'deploy/.env.example'))
        $script:Values = @{
            APP_URL = 'http://localhost:3211'; S3_ENDPOINT = 'http://localhost:9001'; LOBE_PORT = '3211'; RUSTFS_PORT = '9001'
            COMPOSE_PROFILES = 'backup'; AROOMO_TIER = 'full'; BACKUP_S3_PREFIX = 'pc/test-pc'
            LOCAL_BACKUP_DIR = 'D:/Aroomo Data/backups'; JWKS_KEY = '{"keys":[{"kty":"RSA"}]}'; BACKUP_CRON = '0 12,20 * * *'
        }
        $script:Out = ConvertTo-AroomoEnv -Template $script:Template -Values $script:Values
        $script:Path = Join-Path ([IO.Path]::GetTempPath()) ("aroomo-test-{0}.env" -f (New-AroomoSecret -Bytes 16))
        [IO.File]::WriteAllText($script:Path, $script:Out, (New-Object System.Text.UTF8Encoding $false))
        $script:Parsed = Read-AroomoEnv -Path $script:Path
    }
    AfterAll { Remove-Item -LiteralPath $script:Path -Force -ErrorAction SilentlyContinue }

    It '不留任何 CHANGE_ME' { $script:Out | Should -Not -Match 'CHANGE_ME' }
    It '模板里的 CHANGE_ME 都换成了随机值' {
        foreach ($k in 'POSTGRES_PASSWORD', 'LITELLM_DB_PASSWORD', 'CORE_DB_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'AUTH_SECRET') {
            $script:Parsed[$k] | Should -Match '^[0-9a-f]{64}$' -Because $k
        }
    }
    It 'KEY_VAULTS_SECRET 是 base64、解码后正好 32 字节（LobeHub 要求，十六进制会被拒绝）' {
        [Convert]::FromBase64String($script:Parsed['KEY_VAULTS_SECRET']).Length | Should -Be 32
    }
    It 'LiteLLM 的两个密钥以 sk- 开头且互不相同' {
        $script:Parsed['LITELLM_MASTER_KEY'] | Should -Match '^sk-[0-9a-f]{64}$'
        $script:Parsed['LITELLM_SALT_KEY'] | Should -Match '^sk-[0-9a-f]{64}$'
        $script:Parsed['LITELLM_MASTER_KEY'] | Should -Not -Be $script:Parsed['LITELLM_SALT_KEY']
    }
    It '给定的值原样写入（含空格、JSON 的值用单引号）' {
        foreach ($k in $script:Values.Keys) { $script:Parsed[$k] | Should -Be $script:Values[$k] -Because $k }
        $script:Out | Should -Match "(?m)^JWKS_KEY='\{"
        $script:Out | Should -Match "(?m)^LOCAL_BACKUP_DIR='D:/Aroomo Data/backups'$"
    }
    It '模板里没有的键追加在末尾，且每个键只出现一次' {
        $script:Out | Should -Match '(?m)^AROOMO_TIER=full$'
        $keys = [regex]::Matches($script:Out, '(?m)^([A-Z][A-Z0-9_]*)=') | ForEach-Object { $_.Groups[1].Value }
        @($keys | Group-Object | Where-Object Count -gt 1).Count | Should -Be 0
    }
    It '不生成 BOM，换行为 LF' {
        $bytes = [IO.File]::ReadAllBytes($script:Path)
        ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB) | Should -BeFalse
        $script:Out | Should -Not -Match "`r"
    }
    It '值里有单引号时拒绝' {
        { ConvertTo-AroomoEnv -Template 'A=1' -Values @{ A = "it's" } } | Should -Throw
    }
}

Describe 'Compose 文件组合（与 scripts/compose.sh 的 AROOMO_LOCAL=1 一致）' {
    It '基础 + 档位 + local.yml，再加 local-backup.yml；不含 data-dir.yml' {
        $d = Join-Path $script:Root 'deploy'
        $files = Get-AroomoComposeFiles -DeployDir $d -Tier 'standard'
        ($files | ForEach-Object { Split-Path -Leaf $_ }) -join ',' | Should -Be 'docker-compose.yml,standard.yml,local.yml,local-backup.yml'
        foreach ($f in $files) { Test-Path -LiteralPath $f | Should -BeTrue -Because $f }
        ($files -join ',') | Should -Not -Match 'data-dir'
    }
    It 'compose.sh 也使用同样的前三个文件' {
        $sh = Get-Content -Raw (Join-Path $script:Root 'scripts/compose.sh')
        $sh | Should -Match 'docker-compose\.yml'
        $sh | Should -Match 'tiers/\$tier\.yml'
        $sh | Should -Match 'local\.yml'
    }
    It '参数以 compose --project-directory 开头' {
        $a = Get-AroomoComposeArgs -DeployDir 'C:\x\deploy' -Tier 'full'
        $a[0] | Should -Be 'compose'
        $a[1] | Should -Be '--project-directory'
        @($a | Where-Object { $_ -eq '-f' }).Count | Should -Be 4
    }
    It '未知档位报错' { { Get-AroomoComposeFiles -DeployDir 'x' -Tier 'huge' } | Should -Throw }
}

Describe '路径、端口、数据文件夹' {
    It 'Windows 路径转成 Docker 写法' {
        ConvertTo-AroomoDockerPath 'D:\AroomoData\backups\' | Should -Be 'D:/AroomoData/backups'
    }
    It '端口被占用时顺延，且跳过排除的端口' {
        $busy = @(3210, 3211)
        Find-AroomoFreePort -Preferred 3210 -IsFree { param($p) $busy -notcontains $p } | Should -Be 3212
        Find-AroomoFreePort -Preferred 9000 -Exclude @(9000) -IsFree { param($p) $p -gt 0 } | Should -Be 9001
        # 默认端口附近被 Hyper-V 整段保留时换到 20000 段
        Find-AroomoFreePort -Preferred 3280 -IsFree { param($p) $p -ge 20000 } | Should -Be 23280
    }
    It '默认数据文件夹选剩余空间最大的非系统盘' {
        $drives = @(
            [pscustomobject]@{ Name = 'C:'; FreeGB = 500; IsSystem = $true },
            [pscustomobject]@{ Name = 'D:'; FreeGB = 300; IsSystem = $false },
            [pscustomobject]@{ Name = 'E:'; FreeGB = 20; IsSystem = $false }
        )
        Get-AroomoDefaultDataDir -Drives $drives -UserProfile 'C:\Users\u' | Should -Be 'D:\AroomoData'
    }
    It '没有合适的非系统盘时放在用户目录' {
        $drives = @([pscustomobject]@{ Name = 'C:'; FreeGB = 300; IsSystem = $true })
        Get-AroomoDefaultDataDir -Drives $drives -UserProfile 'C:\Users\u' | Should -Match 'AroomoData$'
    }
}

Describe '快捷方式' {
    It '启动、停止、更新、备份都在桌面；设置异地备份、重新生成主密钥在开始菜单' {
        $menu = @(Get-AroomoShortcutSpecs | ForEach-Object Command)
        foreach ($c in 'offsite', 'masterkey') { $menu | Should -Contain $c }
        $desk = @(Get-AroomoShortcutSpecs | Where-Object Desktop | ForEach-Object Command)
        foreach ($c in 'start', 'stop', 'update', 'backup') { $desk | Should -Contain $c }
    }
    It '每个子命令 aroomo.ps1 都支持' {
        $src = Get-Content -Raw (Join-Path $script:WinDir 'aroomo.ps1')
        foreach ($s in Get-AroomoShortcutSpecs) { $src | Should -Match ("'{0}'" -f $s.Command) }
    }
}

Describe '主密钥（D64）' {
    BeforeAll {
        # 假密钥在运行时拼出来（源码里不出现像密钥的字面量）
        $script:FakeId = 'AGE-SECRET-KEY-1' + ('Q' * 58)
        $script:FakePub = 'age1' + ('q' * 58)
    }
    It '解析 age-keygen 输出：取私钥和公钥' {
        $text = "# created: 2026-10-28T08:00:00+08:00`r`n# public key: $($script:FakePub)`r`n$($script:FakeId)`r`n"
        $k = ConvertFrom-AroomoAgeKeygenOutput -Text $text
        $k.Identity | Should -BeExactly $script:FakeId
        $k.PublicKey | Should -BeExactly $script:FakePub
    }
    It '输出不完整时报错' {
        { ConvertFrom-AroomoAgeKeygenOutput -Text "# public key: $($script:FakePub)" } | Should -Throw
        { ConvertFrom-AroomoAgeKeygenOutput -Text '' } | Should -Throw
    }
    It '公钥格式检查（bech32 字符集，没有 b、i、o、1）' {
        Test-AroomoAgeRecipient $script:FakePub | Should -BeTrue
        Test-AroomoAgeRecipient ('age1' + ('b' * 58)) | Should -BeFalse
        Test-AroomoAgeRecipient '' | Should -BeFalse
        Test-AroomoAgeRecipient $script:FakePub.ToUpperInvariant() | Should -BeFalse
    }
    It '分组显示：开头一行 AGE-SECRET-KEY-1，之后每 4 个字符一组、每行 6 组，拼回去与原文相同' {
        $lines = Format-AroomoKeyGroups -Key $script:FakeId
        $lines[0] | Should -BeExactly 'AGE-SECRET-KEY-1'
        $lines[1] | Should -BeExactly ((@('QQQQ') * 6) -join ' ')
        (($lines -join '') -replace ' ', '') | Should -BeExactly $script:FakeId
    }
    It '已有公钥时不重新生成；无人值守时不生成' {
        $p = Join-Path ([IO.Path]::GetTempPath()) ("aroomo-mk-{0}.env" -f (New-AroomoSecret -Bytes 16))
        try {
            [IO.File]::WriteAllText($p, "BACKUP_AGE_RECIPIENT=$($script:FakePub)`n")
            Invoke-AroomoMasterKeySetup -AppDir ([IO.Path]::GetTempPath()) -EnvPaths @($p) | Should -Be 'exists'
            [IO.File]::WriteAllText($p, "BACKUP_AGE_RECIPIENT=`n")
            Invoke-AroomoMasterKeySetup -AppDir ([IO.Path]::GetTempPath()) -EnvPaths @($p) -Unattended | Should -Be 'unavailable'
            Invoke-AroomoMasterKeySetup -AppDir ([IO.Path]::GetTempPath()) -EnvPaths @($p) | Should -Be 'unavailable'
        } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
    }
}

Describe '本地版配置（D63、D65）' {
    It 'Set-AroomoEnvValues：改已有键、追加新键、删除指定键，重复执行结果不变' {
        $c = "# 注释`nA=1`nRESTIC_PASSWORD=x`nB='有 空格'`n"
        $out = Set-AroomoEnvValues -Content $c -Values @{ A = '2'; C = '3' } -Remove @('RESTIC_PASSWORD')
        $out | Should -Match '(?m)^A=2$'
        $out | Should -Match '(?m)^C=3$'
        $out | Should -Match "(?m)^B='有 空格'$"
        $out | Should -Not -Match 'RESTIC_PASSWORD'
        $out | Should -Match '(?m)^# 注释$'
        (Set-AroomoEnvValues -Content $out -Values @{ A = '2'; C = '3' } -Remove @('RESTIC_PASSWORD')) | Should -BeExactly $out
    }
    It '电脑版异地目录 pc/<电脑名>（小写、只留字母数字和连字符）' {
        Get-AroomoPcBackupPrefix -HostName 'DESKTOP-AB_12 x' | Should -BeExactly 'pc/desktop-ab-12-x'
        Get-AroomoPcBackupPrefix -HostName '' | Should -BeExactly 'pc/pc'
    }
    It '本地版固定值：不常驻备份进程、留 3 份、没有 Cloudflare Access' {
        $d = Get-AroomoLocalEnvDefaults -HostName 'PC1'
        $d['COMPOSE_PROFILES'] | Should -BeExactly ''
        $d['BACKUP_LOCAL_KEEP'] | Should -Be '3'
        $d['CORE_ACCESS_REAUTH'] | Should -Be 'off'
        $d['BACKUP_S3_PREFIX'] | Should -Be 'pc/pc1'
    }
    It '新生成的 .env：没有 restic 的键和定时备份，主密钥只有公钥位置' {
        $tpl = [IO.File]::ReadAllText((Join-Path $script:Root 'deploy/.env.example'))
        $out = Set-AroomoEnvValues -Content (ConvertTo-AroomoEnv -Template $tpl -Values (Get-AroomoLocalEnvDefaults -HostName 'PC1')) -Remove (Get-AroomoObsoleteEnvKeys)
        $out | Should -Not -Match '(?m)^(RESTIC_REPOSITORY|RESTIC_PASSWORD|BACKUP_CRON)='
        $out | Should -Match '(?m)^BACKUP_AGE_RECIPIENT=$'
        $out | Should -Match '(?m)^CORE_ACCESS_REAUTH=off$'
        $out | Should -Not -Match 'AGE-SECRET-KEY-1[0-9A-Z]{58}'
    }
}

Describe '脚本文件' {
    BeforeAll {
        $script:Scripts = @(Get-ChildItem -Path $script:WinDir -File | Where-Object { $_.Extension -in '.ps1', '.psm1' })
    }
    It '所有脚本能被解析（无语法错误）' {
        foreach ($f in $script:Scripts) {
            $tokens = $null; $errors = $null
            [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
            @($errors).Count | Should -Be 0 -Because $f.Name
        }
    }
    It '所有脚本是 UTF-8 带 BOM（Windows PowerShell 5.1 读中文需要）' {
        foreach ($f in $script:Scripts + @(Get-Item (Join-Path $script:WinDir 'aroomo-setup.iss'))) {
            $b = [IO.File]::ReadAllBytes($f.FullName)
            ($b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) | Should -BeTrue -Because $f.Name
        }
    }
    It '不把 .env 内容输出到屏幕' {
        foreach ($f in $script:Scripts) {
            $src = Get-Content -Raw $f.FullName
            $src | Should -Not -Match 'Write-(Host|Output|AroomoSay)[^\r\n]*\$(content|cfg|values|Parsed)\b' -Because $f.Name
        }
    }
}
