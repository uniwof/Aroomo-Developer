<#
.SYNOPSIS
    Select Aroomo tier based on system memory (PRODUCT §7.1, §7.3, DECISIONS v4.3).

.DESCRIPTION
    Memory thresholds (MB):
    - < 3500 MB  -> demo-2g
    - < 7000 MB  -> standard
    - >= 7000 MB -> full

    Thresholds match scripts/select-tier.sh exactly.
#>
[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [Nullable[int64]]$MemTotalMB = $null
)

$ErrorActionPreference = "Stop"

if ($null -eq $MemTotalMB) {
    if ($env:MEM_TOTAL_MB) {
        $parsed = 0
        if ([int64]::TryParse($env:MEM_TOTAL_MB, [ref]$parsed)) {
            $MemTotalMB = $parsed
        } else {
            Write-Error "Get-AroomoTier: MEM_TOTAL_MB must be an integer" -Category IllegalArgument
            exit 2
        }
    } else {
        try {
            $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
            $MemTotalMB = [math]::Floor($osInfo.TotalVisibleMemorySize / 1024)
        } catch {
            try {
                $gcMem = [GC]::GetGCMemoryInfo().TotalAvailableMemoryBytes
                $MemTotalMB = [math]::Floor($gcMem / 1MB)
            } catch {
                Write-Error "Get-AroomoTier: Unable to detect memory automatically. Specify -MemTotalMB or set MEM_TOTAL_MB" -Category InvalidOperation
                exit 2
            }
        }
    }
}

if ($MemTotalMB -lt 0) {
    Write-Error "Get-AroomoTier: MEM_TOTAL_MB must be a positive integer" -Category IllegalArgument
    exit 2
}

if ($MemTotalMB -lt 3500) {
    "demo-2g"
} elseif ($MemTotalMB -lt 7000) {
    "standard"
} else {
    "full"
}
