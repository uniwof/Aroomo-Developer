<#
.SYNOPSIS
    根据系统内存自动选择 Aroomo 部署档位 (PRODUCT §7.1, §7.3, DECISIONS v4.3)。

.DESCRIPTION
    按内存（MB）计算档位：
    - < 3500 MB  -> demo-2g
    - < 7000 MB  -> standard
    - >= 7000 MB -> full

    阈值与 scripts/select-tier.sh 严格保持一致。
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
            Write-Error "Get-AroomoTier: MEM_TOTAL_MB 必须是整数" -Category IllegalArgument
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
                Write-Error "Get-AroomoTier: 无法自动获取内存，请指定 -MemTotalMB 或设置环境变量 MEM_TOTAL_MB" -Category InvalidOperation
                exit 2
            }
        }
    }
}

if ($MemTotalMB -lt 0) {
    Write-Error "Get-AroomoTier: MEM_TOTAL_MB 必须是正整数" -Category IllegalArgument
    exit 2
}

if ($MemTotalMB -lt 3500) {
    "demo-2g"
} elseif ($MemTotalMB -lt 7000) {
    "standard"
} else {
    "full"
}
