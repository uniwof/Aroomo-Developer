# Windows 本地版：安装与使用

适用：Windows 10 22H2（内部版本 19045）或更新、Windows 11。建议 16 GB 内存、50 GB 以上空闲磁盘。
对应 PRODUCT §7.1、§7.3、§16 P0；DECISIONS v4.3 P0-f、**D64**（主密钥）、**D65**（电脑版异地备份）。

> 当前是**测试版**：还没有在真实的 Windows 电脑上完整跑过，安装包没有数字签名。

## 安装

1. 双击 AroomoSetup 安装包。如果出现「Windows 已保护你的电脑」，选「更多信息」，再选「仍要运行」。（安装包还没有数字签名。）
2. 安装向导只有几步，一路选「下一步」，最后一页保持勾选「继续完成 Aroomo 安装」，选「完成」。
3. 会打开一个文字窗口，按步骤报告进度。每一步开头都会读出「第几步，共几步」。
4. 需要你操作时会弹出标准对话框：
   - 「是否允许此应用对你的设备进行更改」：选「是」。用于启用 WSL2 和安装 Docker Desktop。
   - 「需要重启电脑」：选「是」立即重启。重启并登录后，安装会自动继续。
   - 「数据文件夹放在这里吗」：一般选「是」。
5. **主密钥窗口**（D64）：安装到第 8 步会弹出一个大字窗口，显示你的主密钥（`AGE-SECRET-KEY-1` 开头）。只显示这一次。
   - 点「复制主密钥」，粘贴到密码管理器里保存；
   - 点「打印」，打印一份纸质副本，放在安全的地方；
   - 都做完后点「已保存」，再在确认框里选「是」。
   - 不点「已保存」就关窗口：安装停在这一步，下次运行会重新生成一个新的主密钥。
   - 窗口里还有「公钥」（`age1` 开头），它不是秘密。安装后也存在 `数据文件夹\config\master-key-public.txt`，请发给主程序员，服务器用同一个主密钥（D65）。
6. 第一次启动要下载几 GB 程序，通常 10 到 30 分钟。每分钟会报告一次进度。
7. 完成后浏览器会自动打开 Aroomo。

## 日常使用

桌面上有四个图标：

1. 「Aroomo 启动」：启动并打开浏览器。
2. 「Aroomo 停止」：**先备份，再停止**。数据保留。关机前请用它。
3. 「Aroomo 备份」：立即备份。
4. 「Aroomo 更新」：先备份，备份成功才更新。

开始菜单的 Aroomo 文件夹里还有「Aroomo 打开」「Aroomo 状态」「Aroomo 设置异地备份」「Aroomo 重新生成主密钥」「Aroomo 安装与修复」。

## 备份（D65）

1. 什么时候备份：每次登录 Windows 后约 2 分钟自动备份一次；点「Aroomo 停止」或「Aroomo 更新」时先备份。
2. 存在哪里：数据文件夹的 `backups`，只留最近 3 份。设置了异地备份后，同时上传到和服务器同一个异地存储的 `pc/<电脑名>/` 目录。
3. 加密：用主密钥的公钥加密。电脑上没有主密钥，只有你手里的那份能打开备份。
4. 没设置异地备份时：本机备份照常进行，但每次都会提示「还没有设置异地备份」。硬盘坏了，本机备份会一起丢。
5. 设置异地备份：开始菜单「Aroomo 设置异地备份」，按提示填存储地址、桶名、访问密钥 ID、访问密钥（输入时不显示）。这些信息请主程序员用安全表单给你，不要在聊天里发。
6. **直接关机时来不及备份。** Windows 没有可靠的「关机前先跑几分钟程序」的办法（关机脚本只在专业版以上可用、需要管理员、而且有时间限制；关机时 Docker Desktop 会同时被关掉）。所以：关机前用「Aroomo 停止」；直接关机的话，下次登录后会自动补一份。

每个窗口结束时会提示「按回车键关闭这个窗口」，方便读完结果。

## 必须另存的东西

1. 只有一样：**主密钥**（安装时窗口里显示的那一串）。存在密码管理器里，外加一份纸质副本（D64）。
2. 不要把主密钥发到任何聊天里，也不要存在这台电脑的文件里。
3. 配置文件 `数据文件夹\config\aroomo.env` 不用再另存：它已经随加密备份一起保存。
4. 丢了主密钥，所有备份都打不开。要更换主密钥，用开始菜单「Aroomo 重新生成主密钥」（旧备份仍要用旧主密钥打开，旧的请继续保留一段时间）。

## 数据放在哪里

1. 数据库、上传的文件：在 Docker Desktop 管理的数据卷里（WSL2 磁盘）。
2. 备份、配置、日志：在你选的数据文件夹里（默认是剩余空间最大的非系统盘上的 `AroomoData`）。
3. 为什么数据库不直接放在数据文件夹：PostgreSQL 放在 Windows 文件夹（NTFS 绑定挂载）里会很慢，还常因权限无法启动。所以数据库放在 Docker 卷里，按上面「备份」一节的时机加密备份到数据文件夹。
4. 本机备份防误删和更新失败，不防硬盘损坏。防硬盘损坏要设置异地备份。

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
- 安装包：`installer/windows/aroomo-setup.iss`，CI 在 windows-latest 上编译，artifact 名 `aroomo-setup-windows`；测试版发布见 `.github/workflows/release-local-test.yml`（预发布 `local-test`）。构建前运行 `installer/windows/Get-AgeKeygen.ps1`：下载官方 age v1.2.1 并核对 SHA-256，`age-keygen.exe` 打进安装包，用于离线生成主密钥。
- 主密钥（D64）：`Invoke-AroomoMasterKeySetup` → `New-AroomoMasterKey`（运行 age-keygen，私钥只在内存）→ `Show-AroomoMasterKeyWindow`（复制 / 打印 / 已保存）→ 只把公钥写进 `BACKUP_AGE_RECIPIENT`。
- 开机备份（D65）：计划任务 `\Aroomo\Aroomo 开机备份`（登录时、延迟 2 分钟，运行 `aroomo.ps1 boot-backup`，日志在 `%LOCALAPPDATA%\Aroomo\logs\boot-backup-*.log`）；不能建计划任务时退回「启动」文件夹快捷方式。
- 本地版 `.env` 固定值：`COMPOSE_PROFILES=`（不常驻备份进程）、`BACKUP_S3_PREFIX=pc/<电脑名>`、`BACKUP_LOCAL_KEEP=3`、`CORE_ACCESS_REAUTH=off`（本地没有 Cloudflare Access，重要确认仍然两次点击 + 3 秒）。
- 无人值守：`Install-Aroomo.ps1 -Unattended -DataDir D:\AroomoData`（不会自动重启）。
- 所有 `.ps1/.psm1/.iss` 必须是 UTF-8 带 BOM（Windows PowerShell 5.1 读中文需要），测试会检查。
