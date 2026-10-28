<#
.SYNOPSIS
  CI 冒烟测试（windows-latest，Windows PowerShell 5.1）：直接用打包好的程序文件夹，在临时数据文件夹里
  初始化 → 启动全部服务 → 检查各服务、LiteLLM 虚拟 Key、模型列表 → 备份（测试用主密钥）→ 停止。
  记录冷启动时间（D77-3 目标：后台冷启动 ≤ 15 秒；第一次启动含数据库初始化和迁移，单独记录）。
  失败时打印各服务日志的末尾（日志本来就不含密钥）。
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$AppDir, [string]$DataDir = (Join-Path $env:RUNNER_TEMP 'AroomoData'))
$ErrorActionPreference = 'Stop'
$env:CI = 'true'
$launcher = Join-Path $AppDir 'installer\standalone\aroomo-standalone.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$results = [ordered]@{}

function Run([string]$Act) {
    # 子进程输出直接打印到控制台（不混进返回值）；最多等 25 分钟，卡住时打印日志再失败
    $p = Start-Process -FilePath $ps -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$launcher`"", '-Action', $Act, '-AppDir', "`"$AppDir`"", '-DataDir', "`"$DataDir`"") -NoNewWindow -PassThru
    # 先取一次 Handle：否则 Windows PowerShell 的 Start-Process 结束后 ExitCode 是空的（会被当成 0）
    $null = $p.Handle
    if (-not $p.WaitForExit(25 * 60 * 1000)) {
        & taskkill.exe /T /F /PID $p.Id | Out-Null
        throw "$Act 25 分钟没有结束"
    }
    $p.WaitForExit()
    if ($null -eq $p.ExitCode) { return 99 }
    return [int]$p.ExitCode
}
function Dump-Logs {
    foreach ($f in Get-ChildItem (Join-Path $DataDir 'logs') -File -ErrorAction SilentlyContinue) {
        Write-Host "----- $($f.Name)（末尾）-----"
        Get-Content $f.FullName -Tail 60 | ForEach-Object { Write-Host $_ }
    }
}

try {
    if ((Run 'init') -ne 0) { throw 'init 失败' }
    Import-Module (Join-Path $AppDir 'installer\windows\Aroomo.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $AppDir 'installer\standalone\AroomoStandalone.psm1') -Force -DisableNameChecking

    $t = [Diagnostics.Stopwatch]::StartNew()
    if ((Run 'start') -ne 0) { throw '第一次启动失败' }
    $results.first_start_s = [int]$t.Elapsed.TotalSeconds
    if ((Run 'status') -ne 0) { throw '有服务不正常' }

    $ctx = Get-AroomoSAContext -AppDir $AppDir -DataDir $DataDir
    $c = $ctx.Config
    $ll = "http://127.0.0.1:$($c['LITELLM_PORT'])"
    $h = @{ Authorization = "Bearer $($c['LITELLM_MASTER_KEY'])" }
    # LobeHub 用的虚拟 Key 能列模型（证明 LiteLLM + Prisma + PostgreSQL 都通）
    $models = Invoke-RestMethod -Uri "$ll/v1/models" -Headers @{ Authorization = "Bearer $($c['LOBE_LITELLM_VIRTUAL_KEY'])" } -UseBasicParsing
    $results.litellm_virtual_key = 'ok'
    # 用管理接口加一个模型（假 Key，不会真的调用），确认写入数据库
    $body = @{ model_name = 'smoke-test'; litellm_params = @{ model = 'openai/gpt-4o-mini'; api_key = 'sk-smoke-test-not-real-000000' } } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Method Post -Uri "$ll/model/new" -Headers $h -ContentType 'application/json' -Body $body -UseBasicParsing | Out-Null
    $results.litellm_model_new = 'ok'
    # Core 健康 + 能连 LiteLLM
    $results.core_healthz = (Invoke-WebRequest -Uri "http://127.0.0.1:$($c['CORE_PORT'])/healthz" -UseBasicParsing).StatusCode
    $results.lobe_http = Get-AroomoSAHttpStatus -Url "http://127.0.0.1:$($c['LOBE_PORT'])/" -TimeoutMs 30000
    $pub = Get-AroomoSAPublicUrl -Paths $ctx.Paths -Config $c
    $results.public_url_http = Get-AroomoSAHttpStatus -Url "$pub/" -TimeoutMs 30000
    if ($results.lobe_http -lt 200 -or $results.lobe_http -ge 500) { throw "LobeHub 返回 $($results.lobe_http)" }

    # D78：本机主人自动登录（没有 Cookie 打开界面 → Shell 替浏览器登录 → 302 带会话 Cookie）；再用这个会话经 Shell 调 Core
    if (Test-AroomoSAShell -Paths $ctx.Paths) {
        $req = [System.Net.HttpWebRequest]::Create("$pub/")
        $req.Accept = 'text/html'; $req.AllowAutoRedirect = $false; $req.Proxy = $null; $req.Timeout = 120000
        try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
        $code = [int]$resp.StatusCode
        $raw = [string]$resp.Headers['Set-Cookie']
        $resp.Close()
        $m = [regex]::Match($raw, '([A-Za-z0-9_.\-]*session_token)=([^;,\s]+)')
        if ($code -ne 302 -or -not $m.Success) { throw "本机主人自动登录没有成功（HTTP $code）" }
        $results.autologin = 'ok'
        $cookie = "$($m.Groups[1].Value)=$($m.Groups[2].Value)"
        $results.aroomo_api_via_shell = (Invoke-WebRequest -Uri "$pub/aroomo/api/inbox/unread-count" -Headers @{ Cookie = $cookie } -UseBasicParsing).StatusCode
    }

    # 备份：测试用主密钥（只在这台 CI 机器上，用完即弃）
    $k = New-AroomoMasterKey -AgeKeygenPath (Get-AroomoAgeKeygenPath -AppDir $AppDir)
    Write-AroomoPrivateFile -Path $ctx.Paths.EnvFile -Content (Set-AroomoEnvValues -Content ([IO.File]::ReadAllText($ctx.Paths.EnvFile)) -Values @{ BACKUP_AGE_RECIPIENT = $k.PublicKey })
    Remove-Variable k
    $ctx = Get-AroomoSAContext -AppDir $AppDir -DataDir $DataDir
    $b = Invoke-AroomoSABackup -Context $ctx
    if (-not $b.Ok) { throw "备份失败：$($b.Step)" }
    $results.backup = "ok（$($b.DurationS) 秒，$([int]((Get-Item $b.File).Length / 1KB)) KB）"

    if ((Run 'stop') -ne 0) { throw '停止失败' }
    # 第二次（热数据）冷启动时间：D77-3 目标 ≤ 15 秒
    $t = [Diagnostics.Stopwatch]::StartNew()
    if ((Run 'start') -ne 0) { throw '第二次启动失败' }
    $results.second_start_s = [int]$t.Elapsed.TotalSeconds
    [void](Run 'stop')
    $results.data_dir_mb = [int]((Get-ChildItem -Recurse -File $DataDir | Measure-Object Length -Sum).Sum / 1MB)
    $results.installed_mb = [int]((Get-ChildItem -Recurse -File $AppDir -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB)
    $results | ConvertTo-Json | Tee-Object -FilePath (Join-Path $env:RUNNER_TEMP 'smoke-results.json')
} catch {
    Write-Host "冒烟测试失败：$($_.Exception.Message)"
    Dump-Logs
    $results | ConvertTo-Json
    exit 1
}
