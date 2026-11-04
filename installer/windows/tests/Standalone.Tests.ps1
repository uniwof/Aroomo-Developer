# Pester 5 测试：Windows 独立版启动器的并行启动逻辑（Start-AroomoSAParallel，D77-3）和启动标记。
# 不启动任何真实服务：启动、健康检查、数据库操作都用 Mock 模拟（每个服务在启动后若干毫秒「就绪」）。
# 在 windows-latest（Windows PowerShell 5.1）和 ubuntu（pwsh 7）上都跑。

BeforeAll {
    $script:Here = Split-Path -Parent $PSCommandPath
    $script:WinDir = Split-Path -Parent $script:Here
    $script:Root = (Resolve-Path (Join-Path $script:WinDir '..\..')).Path
    Import-Module (Join-Path $script:WinDir 'Aroomo.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $script:Root 'installer\standalone\AroomoStandalone.psm1') -Force -DisableNameChecking

    function script:New-FakeContext([string]$Dir) {
        $exe = Join-Path $Dir 'fake.exe'
        Set-Content -LiteralPath $exe -Value 'x'
        $site = Join-Path $Dir 'python\Lib\site-packages'
        New-Item -ItemType Directory -Path (Join-Path $site 'litellm-1.106.4.dist-info'), (Join-Path $site 'litellm_proxy_extras-0.4.dist-info') -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $Dir 'lobe') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $Dir 'lobe\.aroomo-lobe-sha256') -Value 'abc123' -NoNewline
        $paths = @{
            AppDir = $Dir; DataDir = $Dir; PythonDir = (Join-Path $Dir 'python'); LobeDir = (Join-Path $Dir 'lobe')
            State = (Join-Path $Dir 'state'); Run = (Join-Path $Dir 'run'); Logs = (Join-Path $Dir 'logs'); PgData = (Join-Path $Dir 'pgdata')
            RustFSData = (Join-Path $Dir 'rustfs'); MeiliData = (Join-Path $Dir 'meili'); KarakeepData = (Join-Path $Dir 'karakeep'); RedisData = (Join-Path $Dir 'redis')
        }
        $mk = {
            param($Name, $Port, [string[]]$Deps = @(), [switch]$Deferred, $Kind = 'process')
            [pscustomobject]@{ Name = $Name; Label = $Name; Kind = $Kind; Port = $Port; TimeoutSec = 20; DependsOn = $Deps; Deferred = [bool]$Deferred; Exe = $exe; Arguments = @(); Env = @{ A = '1' }; Health = 'tcp'; HealthUrl = $null }
        }
        $specs = @(
            (& $mk 'postgres' 1 -Kind 'pgctl'),
            (& $mk 'redis' 2),
            (& $mk 'rustfs' 3),
            (& $mk 'litellm' 4 @('postgres')),
            (& $mk 'core' 5 @('postgres')),
            (& $mk 'lobe' 6 @('postgres', 'redis', 'rustfs')),
            (& $mk 'meilisearch' 7 -Deferred),
            (& $mk 'karakeep' 8 -Deferred),
            (& $mk 'shell' 9)
        )
        return @{ Paths = $paths; Config = @{ RUSTFS_LOBE_BUCKET = 'lobe' }; Specs = $specs }
    }

    function script:Reset-Fake {
        $script:clock = [Diagnostics.Stopwatch]::StartNew()
        $script:startedAt = @{}
        $script:startedEnv = @{}
        $script:dead = @()
        $script:bucketCalls = 0
        # 每个服务启动后多少毫秒就绪（LiteLLM、LobeHub 最慢；完整档模块更慢）
        $script:delayMs = @{ postgres = 0; redis = 100; rustfs = 150; shell = 50; litellm = 700; core = 300; lobe = 600; meilisearch = 1500; karakeep = 1500 }
    }
}

Describe 'Start-AroomoSAParallel（D77-3 并行启动）' {
    BeforeEach {
        Reset-Fake
        $script:dir = Join-Path ([IO.Path]::GetTempPath()) ("aroomo-sa-test-" + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $script:dir -Force | Out-Null
        $script:ctx = New-FakeContext $script:dir

        Mock -ModuleName AroomoStandalone Get-AroomoSAListeningPorts { return $null }
        Mock -ModuleName AroomoStandalone Test-AroomoSAServiceAlive { return $false }
        Mock -ModuleName AroomoStandalone Write-AroomoSay { }
        Mock -ModuleName AroomoStandalone Get-AroomoSAInitSql { return 'SELECT 1;' }
        Mock -ModuleName AroomoStandalone Invoke-AroomoSAPsql { return @{ ExitCode = 0; Output = '' } }
        Mock -ModuleName AroomoStandalone Initialize-AroomoSALiteLLMKey { return $true }
        Mock -ModuleName AroomoStandalone Initialize-AroomoSABucket { $script:bucketCalls++; return $true }
        Mock -ModuleName AroomoStandalone Write-AroomoSARedisConf { }
        Mock -ModuleName AroomoStandalone Invoke-AroomoSAHidden { $script:startedAt['postgres'] = $script:clock.Elapsed.TotalMilliseconds; return @{ ExitCode = 0; Output = '' } }
        Mock -ModuleName AroomoStandalone Start-AroomoSAProcess {
            $script:startedAt[$Spec.Name] = $script:clock.Elapsed.TotalMilliseconds
            $script:startedEnv[$Spec.Name] = $Spec.Env
            return (1000 + [int]$Spec.Port)
        }
        Mock -ModuleName AroomoStandalone Get-Process {
            if ($script:dead -contains [int]@($Id)[0]) { return $null }
            return [pscustomobject]@{ Id = [int]@($Id)[0]; ProcessName = 'cmd' }
        }
        Mock -ModuleName AroomoStandalone Test-AroomoSAServiceHealthy {
            $n = $Spec.Name
            if (-not $script:startedAt.ContainsKey($n)) { return $false }
            return (($script:clock.Elapsed.TotalMilliseconds - $script:startedAt[$n]) -ge $script:delayMs[$n])
        }
    }
    AfterEach {
        Remove-Item -LiteralPath $script:dir -Recurse -Force -ErrorAction SilentlyContinue
    }

    It '没有依赖的服务最先同时启动；数据库就绪后 LiteLLM、Core、LobeHub 才启动' {
        $t = [ordered]@{}
        Start-AroomoSAParallel -Context $script:ctx -EnsureDbAccounts -Quiet -Timing $t | Should -BeTrue
        foreach ($n in 'shell', 'redis', 'rustfs', 'postgres') { $t[$n]['start'] | Should -BeLessThan 0.5 }
        foreach ($n in 'litellm', 'core', 'lobe') { $t[$n]['start'] | Should -BeGreaterOrEqual $t['postgres']['ready'] }
        $t['lobe']['start'] | Should -BeGreaterOrEqual $t['rustfs']['ready']
        # LiteLLM 和 LobeHub 并行：LobeHub 不等 LiteLLM 就绪
        $t['lobe']['start'] | Should -BeLessThan $t['litellm']['ready']
        Should -Invoke -ModuleName AroomoStandalone Invoke-AroomoSAPsql -Times 1 -Exactly
    }

    It '完整档模块在主界面就绪后才启动；不加 -WaitAll 时不等它们就绪' {
        $t = [ordered]@{}
        Start-AroomoSAParallel -Context $script:ctx -Quiet -Timing $t | Should -BeTrue
        $mainReady = (@('shell', 'litellm', 'core', 'lobe') | ForEach-Object { $t[$_]['ready'] } | Measure-Object -Maximum).Maximum
        $t['meilisearch']['start'] | Should -BeGreaterOrEqual $mainReady
        $t['karakeep']['start'] | Should -BeGreaterOrEqual $mainReady
        $t['meilisearch'].Contains('ready') | Should -BeFalse
        $t['karakeep'].Contains('ready') | Should -BeFalse
    }

    It '-WaitAll 时等完整档模块也就绪' {
        $t = [ordered]@{}
        Start-AroomoSAParallel -Context $script:ctx -WaitAll -Quiet -Timing $t | Should -BeTrue
        $t['meilisearch'].Contains('ready') | Should -BeTrue
        $t['karakeep'].Contains('ready') | Should -BeTrue
    }

    It '之前起的主界面服务卡住（进程在、不健康）：等 AdoptGraceSec 后结束并重启一次' {
        $script:stopped = @()
        Mock -ModuleName AroomoStandalone Test-AroomoSAServiceAlive { return ($Spec.Name -eq 'litellm' -and $script:stopped -notcontains 'litellm') }
        Mock -ModuleName AroomoStandalone Stop-AroomoSAService { $script:stopped += $Spec.Name }
        $t = [ordered]@{}
        Start-AroomoSAParallel -Context $script:ctx -WaitAll -Quiet -Timing $t -AdoptGraceSec 1 | Should -BeTrue
        $script:stopped | Should -Be @('litellm')
        $t['litellm'].Contains('restart') | Should -BeTrue
        $t['litellm']['ready'] | Should -BeGreaterOrEqual $t['litellm']['restart']
        Should -Invoke -ModuleName AroomoStandalone Stop-AroomoSAService -Times 1 -Exactly
    }

    It '第一次迁移并建桶，记下标记；第二次跳过迁移和建桶；标记清掉后重新迁移' {
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        $script:startedEnv['litellm'].ContainsKey('DISABLE_SCHEMA_UPDATE') | Should -BeFalse
        $script:startedEnv['lobe'].ContainsKey('AROOMO_LOBE_SKIP_MIGRATION') | Should -BeFalse
        $script:bucketCalls | Should -Be 1
        Get-AroomoSAMarker -Paths $script:ctx.Paths -Name 'lobe-schema' | Should -Be 'abc123'
        Get-AroomoSAMarker -Paths $script:ctx.Paths -Name 'litellm-schema' | Should -Be 'litellm-1.106.4.dist-info;litellm_proxy_extras-0.4.dist-info'

        Reset-Fake
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        $script:startedEnv['litellm']['DISABLE_SCHEMA_UPDATE'] | Should -Be 'true'
        $script:startedEnv['lobe']['AROOMO_LOBE_SKIP_MIGRATION'] | Should -Be '1'
        $script:bucketCalls | Should -Be 0
        # 服务定义本身不被改动（每次启动都从原始环境变量复制）
        $script:ctx.Specs[3].Env.ContainsKey('DISABLE_SCHEMA_UPDATE') | Should -BeFalse

        Clear-AroomoSAStartupMarkers -Paths $script:ctx.Paths
        Reset-Fake
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        $script:startedEnv['litellm'].ContainsKey('DISABLE_SCHEMA_UPDATE') | Should -BeFalse
        $script:startedEnv['lobe'].ContainsKey('AROOMO_LOBE_SKIP_MIGRATION') | Should -BeFalse
        $script:bucketCalls | Should -Be 1
    }

    It 'LobeHub 版本变了（程序包 SHA-256 不同）就重新迁移' {
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        Set-Content -LiteralPath (Join-Path $script:dir 'lobe\.aroomo-lobe-sha256') -Value 'def456' -NoNewline
        Reset-Fake
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        $script:startedEnv['lobe'].ContainsKey('AROOMO_LOBE_SKIP_MIGRATION') | Should -BeFalse
        Get-AroomoSAMarker -Paths $script:ctx.Paths -Name 'lobe-schema' | Should -Be 'def456'
    }

    It '主界面的服务启动后马上退出：返回失败' {
        $script:delayMs['core'] = 100000
        $script:dead = @(1005)
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeFalse
    }

    It '完整档模块退出不影响主界面（不加 -WaitAll）；加 -WaitAll 时返回失败' {
        $script:delayMs['karakeep'] = 100000
        $script:dead = @(1008)
        Start-AroomoSAParallel -Context $script:ctx -Quiet | Should -BeTrue
        Reset-Fake
        $script:delayMs['karakeep'] = 100000
        $script:dead = @(1008)
        Start-AroomoSAParallel -Context $script:ctx -WaitAll -Quiet | Should -BeFalse
    }

    It '已经在运行的服务不重复启动' {
        Mock -ModuleName AroomoStandalone Test-AroomoSAServiceHealthy { return $true }
        Start-AroomoSAParallel -Context $script:ctx -WaitAll -Quiet | Should -BeTrue
        Should -Invoke -ModuleName AroomoStandalone Start-AroomoSAProcess -Times 0 -Exactly
        Should -Invoke -ModuleName AroomoStandalone Invoke-AroomoSAHidden -Times 0 -Exactly
    }
}

Describe 'Get-AroomoSAListeningPorts / 健康检查先看监听表' {
    It '返回正在监听的端口（包含刚打开的本机端口）' {
        $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
        $l.Start()
        try {
            $port = ([System.Net.IPEndPoint]$l.LocalEndpoint).Port
            $set = Get-AroomoSAListeningPorts
            $set | Should -Not -BeNullOrEmpty
            $set.Contains($port) | Should -BeTrue
        } finally { $l.Stop() }
    }

    It '端口没人监听时直接判为没就绪（不发起连接）' {
        $spec = [pscustomobject]@{ Name = 'x'; Port = 1; Health = 'http'; HealthUrl = 'http://127.0.0.1:1/' }
        $empty = New-Object 'System.Collections.Generic.HashSet[int]'
        $sw = [Diagnostics.Stopwatch]::StartNew()
        Test-AroomoSAServiceHealthy -Spec $spec -Paths @{} -Listening $empty | Should -BeFalse
        $sw.ElapsedMilliseconds | Should -BeLessThan 200
    }
}
