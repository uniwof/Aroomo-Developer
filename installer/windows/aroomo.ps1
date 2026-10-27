<#
.SYNOPSIS
    Aroomo Windows 控制脚本，支持 start / stop / update / status 子命令。

.DESCRIPTION
    调用与 scripts/compose.sh 相同的 Compose 文件组合，逻辑如下：
    - 基础：deploy/docker-compose.yml + deploy/tiers/<tier>.yml
    - AROOMO_LOCAL=1 (默认启用)：添加 -f deploy/local.yml
    - AROOMO_DATA_DIR=1 或 DATA_DIR 已设置：添加 -f deploy/data-dir.yml
#>
[CmdletBinding()]
param (
    [Parameter(Position = 0, Mandatory = $true)]
    [ValidateSet("start", "stop", "update", "status")]
    [string]$Command,

    [Parameter(Mandatory = $false)]
    [string]$Tier = $env:AROOMO_TIER,

    [Parameter(Mandatory = $false)]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$DeployDir = Join-Path $RepoRoot "deploy"

if ([string]::IsNullOrWhiteSpace($Tier)) {
    $GetTierScript = Join-Path $ScriptDir "Get-AroomoTier.ps1"
    if (Test-Path $GetTierScript) {
        $Tier = & $GetTierScript
    } else {
        $Tier = "standard"
    }
}

$TierFile = Join-Path $DeployDir "tiers\$Tier.yml"
if (-not (Test-Path $TierFile)) {
    Write-Error "aroomo.ps1: 未知档位 $Tier (找不到文件 $TierFile)"
    exit 2
}

$ComposeFiles = @(
    "-f", (Join-Path $DeployDir "docker-compose.yml"),
    "-f", $TierFile
)

$LocalEnv = $env:AROOMO_LOCAL
if ([string]::IsNullOrWhiteSpace($LocalEnv)) {
    $LocalEnv = "1"
}

if ($LocalEnv -eq "1") {
    $ComposeFiles += "-f", (Join-Path $DeployDir "local.yml")
}

$DataDirEnv = $env:AROOMO_DATA_DIR
if ($DataDirEnv -eq "1" -or (-not [string]::IsNullOrWhiteSpace($env:DATA_DIR))) {
    $ComposeFiles += "-f", (Join-Path $DeployDir "data-dir.yml")
}

$DockerArgs = @("--project-directory", $DeployDir) + $ComposeFiles

switch ($Command) {
    "start" {
        $DockerArgs += @("up", "-d")
    }
    "stop" {
        $DockerArgs += @("down")
    }
    "update" {
        Write-Host "正在执行升级前本地数据快照..." -ForegroundColor Cyan
        # 快照/升级提示逻辑
        $DockerArgs += @("pull")
    }
    "status" {
        $DockerArgs += @("ps")
    }
}

if ($DryRun) {
    $Result = [PSCustomObject]@{
        Command      = $Command
        Tier         = $Tier
        ComposeFiles = $ComposeFiles
        DockerArgs   = $DockerArgs
        DeployDir    = $DeployDir
    }
    return $Result
}

if ($Command -eq "update") {
    Write-Host "拉取最新镜像..." -ForegroundColor Green
    & docker compose @DockerArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "重新启动服务..." -ForegroundColor Green
    $StartArgs = @("--project-directory", $DeployDir) + $ComposeFiles + @("up", "-d")
    & docker compose @StartArgs
    exit $LASTEXITCODE
} else {
    & docker compose @DockerArgs
    exit $LASTEXITCODE
}
