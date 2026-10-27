BeforeAll {
    $ScriptDir = $PSScriptRoot
    $GetTierPath = Join-Path $ScriptDir "Get-AroomoTier.ps1"
    $AroomoPath = Join-Path $ScriptDir "aroomo.ps1"
    $RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
    $SelectTierSh = Join-Path $RepoRoot "scripts\select-tier.sh"
}

Describe "Get-AroomoTier.ps1 Tier Selection Tests" {
    Context "When -MemTotalMB is explicitly provided" {
        It "Returns demo-2g when memory < 3500 MB" {
            $tier = & $GetTierPath -MemTotalMB 2000
            $tier | Should -Be "demo-2g"

            $tierBorder = & $GetTierPath -MemTotalMB 3499
            $tierBorder | Should -Be "demo-2g"
        }

        It "Returns standard when 3500 MB <= memory < 7000 MB" {
            $tierMin = & $GetTierPath -MemTotalMB 3500
            $tierMin | Should -Be "standard"

            $tierMid = & $GetTierPath -MemTotalMB 4000
            $tierMid | Should -Be "standard"

            $tierMax = & $GetTierPath -MemTotalMB 6999
            $tierMax | Should -Be "standard"
        }

        It "Returns full when memory >= 7000 MB" {
            $tierMin = & $GetTierPath -MemTotalMB 7000
            $tierMin | Should -Be "full"

            $tierLarge = & $GetTierPath -MemTotalMB 16384
            $tierLarge | Should -Be "full"
        }
    }

    Context "When MEM_TOTAL_MB environment variable is set" {
        It "Reads MEM_TOTAL_MB and returns corresponding tier" {
            try {
                $env:MEM_TOTAL_MB = "1900"
                (& $GetTierPath) | Should -Be "demo-2g"

                $env:MEM_TOTAL_MB = "3900"
                (& $GetTierPath) | Should -Be "standard"

                $env:MEM_TOTAL_MB = "7700"
                (& $GetTierPath) | Should -Be "full"
            } finally {
                Remove-Item env:MEM_TOTAL_MB -ErrorAction SilentlyContinue
            }
        }
    }

    Context "Comparison with scripts/select-tier.sh threshold logic" {
        It "Produces identical output as bash script for representative memory values" {
            $testCases = @(1000, 2000, 3499, 3500, 5000, 6999, 7000, 8000, 16000)

            $hasBash = $null -ne (Get-Command "bash" -ErrorAction SilentlyContinue)
            if (-not $hasBash) {
                $hasBash = $null -ne (Get-Command "wsl" -ErrorAction SilentlyContinue)
            }

            foreach ($mem in $testCases) {
                $psResult = & $GetTierPath -MemTotalMB $mem

                if ($hasBash) {
                    $shPathUnix = $SelectTierSh -replace '\\', '/'
                    $shResult = (bash -c "MEM_TOTAL_MB=$mem '$shPathUnix'").Trim()
                    $psResult | Should -Be $shResult
                } else {
                    if ($mem -lt 3500) {
                        $psResult | Should -Be "demo-2g"
                    } elseif ($mem -lt 7000) {
                        $psResult | Should -Be "standard"
                    } else {
                        $psResult | Should -Be "full"
                    }
                }
            }
        }
    }
}

Describe "aroomo.ps1 Subcommands and Compose Options Verification" {
    Context "start subcommand" {
        It "Defaults to AROOMO_LOCAL=1 and includes local.yml compose file" {
            try {
                Remove-Item env:AROOMO_LOCAL -ErrorAction SilentlyContinue
                Remove-Item env:AROOMO_TIER -ErrorAction SilentlyContinue
                Remove-Item env:AROOMO_DATA_DIR -ErrorAction SilentlyContinue
                Remove-Item env:DATA_DIR -ErrorAction SilentlyContinue

                $res = & $AroomoPath -Command start -Tier standard -DryRun
                $res.Command | Should -Be "start"
                $res.Tier | Should -Be "standard"

                $files = $res.ComposeFiles
                $files | Should -Contain "-f"
                ($files -like "*docker-compose.yml").Count | Should -Be 1
                ($files -like "*standard.yml").Count | Should -Be 1
                ($files -like "*local.yml").Count | Should -Be 1

                $res.DockerArgs[-2] | Should -Be "up"
                $res.DockerArgs[-1] | Should -Be "-d"
            } finally {}
        }
    }

    Context "stop subcommand" {
        It "Builds down command combination" {
            $res = & $AroomoPath -Command stop -Tier standard -DryRun
            $res.Command | Should -Be "stop"
            $res.DockerArgs[-1] | Should -Be "down"
        }
    }

    Context "update subcommand" {
        It "Builds pull command combination" {
            $res = & $AroomoPath -Command update -Tier standard -DryRun
            $res.Command | Should -Be "update"
            $res.DockerArgs[-1] | Should -Be "pull"
        }
    }

    Context "status subcommand" {
        It "Builds ps command combination" {
            $res = & $AroomoPath -Command status -Tier standard -DryRun
            $res.Command | Should -Be "status"
            $res.DockerArgs[-1] | Should -Be "ps"
        }
    }

    Context "DATA_DIR and AROOMO_DATA_DIR handling" {
        It "Appends data-dir.yml when DATA_DIR is configured" {
            try {
                $env:DATA_DIR = "C:\AroomoData"
                $res = & $AroomoPath -Command start -Tier full -DryRun
                ($res.ComposeFiles -like "*data-dir.yml").Count | Should -Be 1
            } finally {
                Remove-Item env:DATA_DIR -ErrorAction SilentlyContinue
            }
        }
    }
}
