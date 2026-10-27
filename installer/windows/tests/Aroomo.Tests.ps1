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
            COMPOSE_PROFILES = 'backup'; AROOMO_TIER = 'full'; RESTIC_REPOSITORY = '/repo'; RESTIC_PASSWORD = 'placeholder-restic'
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
        foreach ($k in 'POSTGRES_PASSWORD', 'LITELLM_DB_PASSWORD', 'CORE_DB_PASSWORD', 'RUSTFS_ACCESS_KEY', 'RUSTFS_SECRET_KEY', 'KEY_VAULTS_SECRET', 'AUTH_SECRET') {
            $script:Parsed[$k] | Should -Match '^[0-9a-f]{64}$' -Because $k
        }
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
    It '启动、停止、更新、备份都在桌面' {
        $desk = @(Get-AroomoShortcutSpecs | Where-Object Desktop | ForEach-Object Command)
        foreach ($c in 'start', 'stop', 'update', 'backup') { $desk | Should -Contain $c }
    }
    It '每个子命令 aroomo.ps1 都支持' {
        $src = Get-Content -Raw (Join-Path $script:WinDir 'aroomo.ps1')
        foreach ($s in Get-AroomoShortcutSpecs) { $src | Should -Match ("'{0}'" -f $s.Command) }
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
