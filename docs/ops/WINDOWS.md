# Windows 本地版：安装与使用

适用：Windows 10 22H2（内部版本 19045）或更新、Windows 11。建议 16 GB 内存、50 GB 以上空闲磁盘。
对应 PRODUCT §7.1、§7.3、§16 P0；DECISIONS v4.3 P0-f。

## 安装

1. 双击 AroomoSetup 安装包。如果出现「Windows 已保护你的电脑」，选「更多信息」，再选「仍要运行」。（安装包还没有数字签名。）
2. 安装向导只有几步，一路选「下一步」，最后一页保持勾选「继续完成 Aroomo 安装」，选「完成」。
3. 会打开一个文字窗口，按步骤报告进度。每一步开头都会读出「第几步，共几步」。
4. 需要你操作时会弹出标准对话框：
   - 「是否允许此应用对你的设备进行更改」：选「是」。用于启用 WSL2 和安装 Docker Desktop。
   - 「需要重启电脑」：选「是」立即重启。重启并登录后，安装会自动继续。
   - 「数据文件夹放在这里吗」：一般选「是」。
5. 第一次启动要下载几 GB 程序，通常 10 到 30 分钟。每分钟会报告一次进度。
6. 完成后浏览器会自动打开 Aroomo。

## 日常使用

桌面上有四个图标：

1. 「Aroomo 启动」：启动并打开浏览器。
2. 「Aroomo 停止」：停止。数据保留。
3. 「Aroomo 备份」：立即备份到数据文件夹里的 backups。
4. 「Aroomo 更新」：先备份，备份成功才更新。

开始菜单的 Aroomo 文件夹里还有「Aroomo 打开」「Aroomo 状态」「Aroomo 安装与修复」。

每个窗口结束时会提示「按回车键关闭这个窗口」，方便读完结果。

## 必须另存的文件

1. 安装时生成的配置文件：`数据文件夹\config\aroomo.env`。
2. 里面有恢复数据必需的密钥（包括 `LITELLM_SALT_KEY` 和备份口令）。
3. 请复制一份到 U 盘或密码管理器。不要发到聊天里。

## 数据放在哪里

1. 数据库、上传的文件：在 Docker Desktop 管理的数据卷里（WSL2 磁盘）。
2. 备份、配置、日志：在你选的数据文件夹里（默认是剩余空间最大的非系统盘上的 `AroomoData`）。
3. 为什么数据库不直接放在数据文件夹：PostgreSQL 放在 Windows 文件夹（NTFS 绑定挂载）里会很慢，还常因权限无法启动。所以数据库放在 Docker 卷里，再每天两次（12:00、20:00，电脑开着时）自动备份到数据文件夹。
4. 本机备份防误删和更新失败，不防硬盘损坏。需要异地备份时，见 BACKUP.md 第 2 节。

## 卸载

1. 「设置 → 应用」里找到「Aroomo 本地版」，选「卸载」。
2. 会问「是否同时删除全部数据」。默认「否」：保留数据，重新安装后接着用。
3. Docker Desktop 和 WSL2 不会被卸载。

## 遇到问题

| 提示 | 处理 |
|------|------|
| Windows 版本太旧 | 在「设置 → Windows 更新」更新到 22H2 或更新 |
| 没有开启虚拟化 | 需要在 BIOS 里打开 Intel VT-x 或 AMD-V，请身边的人帮忙 |
| Docker Desktop 没能启动 | 注销并重新登录 Windows；Docker Desktop 弹窗要求登录时可以选跳过 |
| 端口被占用 | 安装器会自动换一个端口，浏览器地址以「Aroomo 就绪」那一行为准 |
| 其他 | 把 `%LOCALAPPDATA%\Aroomo\logs` 文件夹发给主程序员（日志里没有密钥） |

## 给维护者

- 安装器：`installer/windows/Install-Aroomo.ps1`；日常命令：`installer/windows/aroomo.ps1 start|stop|update|backup|status|open`；共用函数：`Aroomo.psm1`。
- Compose 文件组合与 `scripts/compose.sh` 的 `AROOMO_LOCAL=1` 相同（基础 + 档位 + `local.yml`），另加 `local-backup.yml`。
- 档位按 WSL2 能用的内存选（`.wslconfig` 的 `memory=`，没有则为主机内存一半），阈值与 `scripts/select-tier.sh` 相同。16 GB 电脑 → 8 GB → 完整版。
- 安装包：`installer/windows/aroomo-setup.iss`，CI 在 windows-latest 上编译，artifact 名 `aroomo-setup-windows`。
- 无人值守：`Install-Aroomo.ps1 -Unattended -DataDir D:\AroomoData`（不会自动重启）。
- 所有 `.ps1/.psm1/.iss` 必须是 UTF-8 带 BOM（Windows PowerShell 5.1 读中文需要），测试会检查。
