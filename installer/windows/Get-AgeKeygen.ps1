<#
.SYNOPSIS
  构建安装包前运行：下载官方 age v1.2.1（Windows amd64），核对 SHA-256，把 age-keygen.exe 和 LICENSE 放到 installer\windows\bin。
  安装包用它在用户电脑上离线生成主密钥（DECISIONS D64 实现注 b）。bin\ 不进仓库。
  文件必须保存为 UTF-8 带 BOM。
#>
[CmdletBinding()]
param([string]$OutDir = (Join-Path $PSScriptRoot 'bin'))

$ErrorActionPreference = 'Stop'
$version = 'v1.2.1'
$url = "https://github.com/FiloSottile/age/releases/download/$version/age-$version-windows-amd64.zip"
# 2026-10-28 从上面的地址下载后计算（GitHub 发布页没有单独的校验文件）；升级 age 时一并更新
$expected = '46db0db71f146061f7c8fffa912cb806aef1bc8450e27a3abc1744f0591b89fb'

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("age-{0}.zip" -f [Guid]::NewGuid())
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $tmp).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    Remove-Item -LiteralPath $tmp -Force
    throw "age 下载文件的 SHA-256 不对：$actual（应为 $expected）"
}
$x = Join-Path ([IO.Path]::GetTempPath()) ("age-{0}" -f [Guid]::NewGuid())
Expand-Archive -LiteralPath $tmp -DestinationPath $x
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $x 'age\age-keygen.exe') -Destination $OutDir -Force
Copy-Item -LiteralPath (Join-Path $x 'age\LICENSE') -Destination (Join-Path $OutDir 'age-LICENSE.txt') -Force
Remove-Item -LiteralPath $tmp -Force
Remove-Item -LiteralPath $x -Recurse -Force
Write-Output ("age-keygen.exe 已就绪：{0}（zip SHA-256 {1}）" -f (Join-Path $OutDir 'age-keygen.exe'), $actual)
