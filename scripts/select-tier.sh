#!/usr/bin/env bash
# 按内存自动选择部署档位（PRODUCT §7.1、§7.3；DECISIONS v4.3：档位待实测后定稿）。
# 输出档位名：demo-2g | standard | full
#
# 用法：scripts/select-tier.sh            # 读取 /proc/meminfo
#       MEM_TOTAL_MB=8000 scripts/select-tier.sh   # 指定内存（安装器 / 测试用）
#
# 注意：Windows（WSL2）里 /proc/meminfo 看到的是 WSL 虚拟机的上限（默认约为主机内存的一半，
# 可由 .wslconfig 修改），不是主机内存。Windows 安装器应传入实际可给 Docker 的内存（见安装器调研 Issue）。
#
# 阈值（暂定）：可用内存 < 3500 MB → demo-2g；< 7000 MB → standard；其余 → full。
# 8 GB 机器的 MemTotal 通常约 7600–7900 MB，因此落在 full。
set -euo pipefail

mem_mb="${MEM_TOTAL_MB:-}"
if [[ -z "$mem_mb" ]]; then
  if [[ ! -r /proc/meminfo ]]; then
    echo "select-tier: 无法读取 /proc/meminfo，请设置 MEM_TOTAL_MB" >&2
    exit 2
  fi
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_mb=$(( mem_kb / 1024 ))
fi

if ! [[ "$mem_mb" =~ ^[0-9]+$ ]]; then
  echo "select-tier: MEM_TOTAL_MB 必须是整数" >&2
  exit 2
fi

if (( mem_mb < 3500 )); then
  echo "demo-2g"
elif (( mem_mb < 7000 )); then
  echo "standard"
else
  echo "full"
fi
