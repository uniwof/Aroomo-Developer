BeforeAll {
    $ScriptDir = $PSScriptRoot
    $GetTierPath = Join-Path $ScriptDir "Get-AroomoTier.ps1"
    $AroomoPath = Join-Path $ScriptDir "aroomo.ps1"
    $RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
    $SelectTierSh = Join-Path $RepoRoot "scripts\select-tier.sh"
}

Describe "Get-AroomoTier.ps1 档位选拔测试" {
    Context "明确指定 -MemTotalMB 参数" {
        It "当内存 < 3500 MB 时，返回 demo-2g" {
            $tier = & $GetTierPath -MemTotalMB 2000
            $tier | Should -Be "demo-2g"

            $tierBorder = & $GetTierPath -MemTotalMB 3499
            $tierBorder | Should -Be "demo-2g"
        }

        It "当 3500 MB <= 内存 < 7000 MB 时，返回 standard" {
            $tierMin = & $GetTierPath -MemTotalMB 3500
            $tierMin | Should -Be "standard"

            $tierMid = & $GetTierPath -MemTotalMB 4000
            $tierMid | Should -Be "standard"

            $tierMax = & $GetTierPath -MemTotalMB 6999
            $tierMax | Should -Be "standard"
        }

        It "当内存 >= 7000 MB 时，返回 full" {
            $tierMin = & $GetTierPath -MemTotalMB 7000
            $tierMin | Should -Be "full"

            $tierLarge = & $GetTierPath -MemTotalMB 16384
            $tierLarge | Should -Be "full"
        }
    }

    Context "通过环境变量 MEM_TOTAL_MB 传入内存" {
        It "读取 MEM_TOTAL_MB 并返回对应档位" {
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

    Context "与 scripts/select-tier.sh 档位判定一致性对照" {
        It "对同一组代表性内存输入，Powershell 与 bash 脚本输出必须相同" {
            $testCases = @(1000, 2000, 3499, 3500, 5000, 6999, 7000, 8000, 16000)

            # 检查是否有 wsl 或 bash 用于跨域比对测试
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
                    # 如果缺少 bash/wsl，直接根据相同逻辑校验
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

Describe "aroomo.ps1 子命令与 Compose 参数验证" {
    Context "start 子命令" {
        It "默认 AROOMO_LOCAL=1，生成包含 local.yml 的 compose 文件组合" {
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

    Context "stop 子命令" {
        It "构建 down 组合" {
            $res = & $AroomoPath -Command stop -Tier standard -DryRun
            $res.Command | Should -Be "stop"
            $res.DockerArgs[-1] | Should -Be "down"
        }
    }

    Context "update 子命令" {
        It "构建 pull 组合" {
            $res = & $AroomoPath -Command update -Tier standard -DryRun
            $res.Command | Should -Be "update"
            $res.DockerArgs[-1] | Should -Be "pull"
        }
    }

    Context "status 子命令" {
        It "构建 ps 组合" {
            $res = & $AroomoPath -Command status -Tier standard -DryRun
            $res.Command | Should -Be "status"
            $res.DockerArgs[-1] | Should -Be "ps"
        }
    }

    Context "DATA_DIR 与 AROOMO_DATA_DIR 响应" {
        It "当设置 DATA_DIR 时自动加入 data-dir.yml" {
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
