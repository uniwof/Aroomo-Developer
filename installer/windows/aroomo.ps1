<#
.SYNOPSIS
    Aroomo Windows control script supporting start / stop / update / status subcommands.

.DESCRIPTION
    Invokes the same Docker Compose file combinations as scripts/compose.sh:
    - Base: deploy/docker-compose.yml + deploy/tiers/<tier>.yml
    - AROOMO_LOCAL=1 (enabled by default): adds -f deploy/local.yml
    - AROOMO_DATA_DIR=1 or DATA_DIR set: adds -f deploy/data-dir.yml
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
    Write-Error "aroomo.ps1: Unknown tier $Tier (file not found: $TierFile)"
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
        Write-Host "Creating pre-update local data snapshot..." -ForegroundColor Cyan
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
    Write-Host "Pulling latest images..." -ForegroundColor Green
    & docker compose @DockerArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host "Restarting services..." -ForegroundColor Green
    $StartArgs = @("--project-directory", $DeployDir) + $ComposeFiles + @("up", "-d")
    & docker compose @StartArgs
    exit $LASTEXITCODE
} else {
    & docker compose @DockerArgs
    exit $LASTEXITCODE
}
