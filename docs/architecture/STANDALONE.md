# Aroomo Windows 独立版（不需要 Docker / WSL）

> 状态：测试版（standalone-test，GitHub **草稿**预发布）。2026-10-28 起草，主程序员。
> 依据：项目所有者 2026-10-28 的指示（权限高于负责人，覆盖 D70 / D75 中「取消独立包」的部分）+ 负责人 D76–D79。
> 本文件只记设计和取舍；裁决原文以 docs/DECISIONS.md 为准（本 PR 不改 DECISIONS.md）。

## 0. 一句话

一个离线安装包，双击即装、装完自动打开；在 Windows 上以普通进程运行和服务器**同一套开源组件**
（LobeHub、LiteLLM、PostgreSQL + pgvector、Redis、RustFS、Core、Aroomo Shell），不需要 Docker、WSL、管理员权限，安装和第一次启动都不联网。

## 1. 所有者指示与负责人裁决的对应

| 来源 | 内容 | 在独立版里的做法 |
| --- | --- | --- |
| 所有者 | 必须做独立版；尽量接近完整 Aroomo；方便优先 | 本文件全部 |
| 所有者 | 可以把 LobeHub 打进安装包；仓库公开期间只能发**草稿**预发布 | `release-standalone-test.yml` 只建 draft；中转构件下载后立即删除；`licenses\` 带 LobeHub LICENSE 和 NOTICE |
| 所有者 | 完全离线：运行时、Chromium、搜索引擎、LobeHub、LiteLLM、PG 全部随包 | `build-windows.ps1` 在 CI 里下载并核对全部组件，用户电脑上不下载 |
| 所有者 | 包含完整档模块（收藏 Karakeep + 搜索、网页代办 + Chromium 等），<300 MB 目标放宽 | Chromium、Meilisearch 已随包；Karakeep / 网页代办服务的进程接入见 §6（分阶段） |
| D70 关切 | 不在 Core 里重做路由 / Key / 限额 | 打包 LiteLLM 本体（PyPI 官方 Windows wheel，和服务器同为 1.106.4）。之前的「Core 内置网关」草稿已删除 |
| D71 关切 | 不公开分发含 LobeHub 的安装包 | 只发草稿（所有者已同意打包）。仓库改为私有后可以改成普通预发布 |
| D64/D65 | age 公钥加密备份，本机 3 份，主密钥不离开电脑 | 沿用；主密钥用 DPAPI 保存在本机（D78） |
| D68/D69 | 隐藏 §8 以外功能、TTS 隐藏且禁用；薄层不 fork | 官方 `FEATURE_FLAGS` 关掉能关的；其余由 Aroomo Shell 隐藏（和 Docker 版同一个 shell/） |
| D73 | 用户手动增改 Key = 普通保存；智能体 / 操作员新增、查看明文、导出、删除 = 重要确认 | Core 的 keys 服务实现，独立版和 Docker 版共用同一份 Core |
| D77-1 | 先评估官方 LobeHub Desktop | 结论见 §3：**不采用** |
| D77-3 | 一个 PG、一个 Node、python-build-standalone、预编译 | 已按此实现（§2） |
| D77-4 | 登录 30 秒后静默启动；窗口立即出现，未就绪显示「正在准备」 | `aroomo-launch.vbs tray 30` + `preparing.html` |
| D77-5/6 | 分层更新、A/B 目录、回滚；更新源用 R2 / app.pcmanai.com + ed25519 签名清单 | 设计见 §7，**本版未实现** |
| D78 | %LOCALAPPDATA%、无管理员、无选项、装完自动打开；只需粘贴一次主密钥（DPAPI）；托盘红黄绿；自动修复；「修复」按钮 + 诊断包；无语音；标准控件 | 已实现，R2 自动恢复和诊断包上传未实现（§8） |
| D79 | 服务器为主、本机为热备；开机单向从 R2 恢复；日常窗口连服务器 | 设计见 §7，**本版未实现**（窗口目前连本机） |

## 2. 组成

```
%LOCALAPPDATA%\Programs\AroomoStandalone\   程序（卸载时删除）
  node\        Node.js 22（Core、LobeHub、Shell 共用一个，D77-3）
  python\      python-build-standalone 3.12 + LiteLLM[proxy] + prisma（.pyc 预编译，删测试 / pip / tk）
  litellm\     config.yaml（和 deploy/litellm 同一份）、prisma-cache（Prisma CLI + Windows 引擎，离线）
  pgsql\       PostgreSQL 17（EDB 官方免安装包）+ 自己编译的 pgvector
  redis\  rustfs\  rclone\  meilisearch\  chromium\
  core\        Aroomo Core（dist + 生产依赖）
  shell\       Aroomo Shell（仓库有 shell/ 时；用户打开的就是它）
  lobe.tar.gz  LobeHub 官方镜像里的 /app（首次启动时解开到 lobe\，用目录联接代替符号链接）
  installer\   启动器、托盘、模块；licenses\；aroomo-components.json（组件和版本清单）

<数据文件夹>（默认：剩余空间最大的非系统盘 \AroomoStandalone；卸载时保留）
  config\aroomo.env（随机密钥，只有当前 Windows 用户能读）  config\master-key.dpapi
  pgdata\  redis\  rustfs\  backups\（本机 3 份 .age）  logs\  diagnostics\  window-profile\
```

一个 PostgreSQL 实例，三个库：`lobechat`（LobeHub，postgres 账号）、`litellm`（litellm 账号）、`aroomo_core`（aroomo_core 账号），和服务器一致。
全文搜索：Windows 版 PostgreSQL 没有 ParadeDB 的 `pg_search`，LobeHub 用它自己支持的 `pg_like`（结果相同，数据多时慢）。

端口（和 Docker 版错开，两个版本可同时装）：界面 3280（Shell）→ LobeHub 3281，LiteLLM 40280，Core 38280，PG 54329，Redis 63799，RustFS 9280。被占用时启动器自动换端口（D78）。

## 3. D77-1：官方 LobeHub Desktop 评估（结论：不采用）

查证（v2.2.20 源码）：

1. Desktop 的界面是**安装包里自带的前端**（`app://renderer`，`RendererUrlManager.ts`、`Browser.ts`），连自建服务器时只走 OIDC + 接口取数据，**不加载服务器的网页**。
   Aroomo Shell 是在服务器网页外面加的薄层（品牌、隐藏 §8 以外功能、朗读按钮、Aroomo 页面），Desktop 里不会出现。要出现只能改 Desktop 的前端 = 深度 fork，违反 D69。
2. Desktop 的本地模式（PGlite）已被官方移除（`RemoteServerConfigCtr.ts`：“Local mode has been removed; fall back to cloud”），只能连官方云或自建服务器，不能单独离线用。
3. Desktop 自带的热更新从 LobeHub 官方源拉新版本，会绕过 Aroomo 的版本固定和薄层。

所以：窗口用 Windows 10/11 自带的 **Edge 应用窗口**（`msedge --app=… --user-data-dir=<数据文件夹>\window-profile`，没有地址栏，像独立程序，读屏 / 放大镜正常），打开 Aroomo Shell。体积 0，启动 <1 秒（D77-3 目标）。
如果以后 LobeHub Desktop 支持「加载服务器网页」模式，再复评。

## 4. 启动、托盘、自动修复（D77-4、D78）

- 安装包（Inno Setup，`PrivilegesRequired=lowest`，不显示任何页面）→ 运行 `aroomo-launch.vbs firstrun`：生成配置、快捷方式（桌面「Aroomo」、开始菜单「Aroomo / 修复 / 立即备份 / 主密钥」）、登录自启（HKCU Run，`tray 30`），**立刻**打开窗口（未就绪时显示本地「正在准备」页，就绪后自动跳转），托盘在后台启动全部服务。
- 首次运行唯一的动作：粘贴主密钥（或「我还没有，生成新的」，或「以后再说」）。主密钥用 Windows DPAPI（当前用户）加密存在 `config\master-key.dpapi`，配置里只写公钥。没有本地登录密码，信任 Windows 账户。
  *注：LobeHub 本身仍要求注册一个账号（Better Auth）；这一步目前还在，见 §8 问题 2。*
- 托盘：绿 = 正常，黄 = 准备 / 修复中，红 = 有服务没起来（气泡一句话，点它 = 修复）。每 20 秒巡检，进程退出就重启；失败后 5 分钟内不反复重试。
- 「修复」：停止 → 清掉残留进程和过期的 PG 锁文件 → 换掉被占端口 → 启动 → 生成去掉密钥的诊断包（`diagnostics\*.zip`：日志末尾 2000 行，配置里所有密钥值替换成「[已隐藏]」）。
- 数据库损坏 → 恢复最近的本机备份（需要普通确认）：恢复函数已有（`Restore-AroomoSABackup`），自动检测损坏**未实现**。
- 没有语音提示；所有窗口用标准 WinForms 控件 + 14pt 字号，有 AccessibleName。

## 5. 备份（D64、D65）

和 Docker 版同一规则：每个库 `pg_dump -Fc` + 对象存储 + 配置 → tar.gz → age 公钥加密 → `backups\` 留 3 份；配置了 S3（R2）时 rclone 上传到 `pc/<电脑名>/`，按天 / 周 / 月保留。
时机：每次登录后后台就绪时、托盘「退出」时、「立即备份」。主密钥只用于恢复（DPAPI 解出，用完删临时文件）。
独立版备份格式 `standalone-1` 和 Docker 版（restic / 卷）不同，不能互相直接恢复（§8）。

## 6. 完整档模块（所有者 2026-10-28 要求）

| 模块 | Windows 原生 | 本版状态 |
| --- | --- | --- |
| LobeHub、LiteLLM、Core、Shell、PG + pgvector、Redis、RustFS、备份 | 是 | **已包含并在 CI 冒烟测试** |
| Chromium（网页代办、抓取网页） | 是（Chrome for Testing 官方 win64） | 随包，尚无服务使用 |
| Meilisearch（Karakeep 搜索） | 是（官方 win 构建） | 随包，尚无服务使用 |
| Karakeep（收藏） | 可以：Node 程序 + SQLite。做法和 LobeHub 一样从官方镜像取 /app，把 better-sqlite3 等原生模块换成同版本 win32 预编译 | **未接入**（下一步）。仓库里 Docker 版也还没有 Karakeep 服务 |
| 网页代办服务 | Core 侧尚未实现（P1+） | 未接入；Chromium 已备好 |
| RSSHub | Node 程序，可原生 | 未接入（Docker 版也还没有） |
| MetaMCP、OpenMemory | Docker 版也还没有；OpenMemory 按 PRODUCT §7 用 pgvector 代替 | 未接入 |
| LobeHub Agent Gateway（`ghcr.io/lobehub/lobehub-gateway`） | 官方只发 Linux 镜像，Windows 上需要从源码构建 | 默认关闭（Docker 版也默认关闭） |
| cloudflared | 有官方 Windows 版 | 独立版不需要（本机访问） |

## 7. 后续设计（本版未实现）

**D79 服务器为主、本机热备：** 托盘启动时若配置了 R2，下载服务器最新备份，DPAPI 解出主密钥，恢复到本机（单向，不双向同步）。窗口默认打开 `https://app.pcmanai.com`（Cloudflare Access），服务器连不上时自动改开本机。需要：服务器备份格式与独立版统一（目前不同，§8 问题 3）。

**D77-5/6 更新：** 三层包（runtime：node/python/pgsql/…；app：core/shell/litellm 配置/启动器；ui：lobe.tar.gz），各自独立版本号。清单 `manifest.json` 用 ed25519 签名（私钥只在 CI 机密里，公钥随安装包），放在 R2 或 app.pcmanai.com，验签失败一律拒绝。A/B 两个程序目录，升级前先备份，切换后健康检查，不通过自动回滚；空闲时静默升级。

## 8. 已知问题和限制

1. **未在用户电脑上验证**：本版只在 GitHub windows-latest 上做了静默安装 + 冒烟测试；真机测试见 PR 说明。
2. LobeHub 首次打开要注册账号（Better Auth 邮箱密码）。D78 要求「不设本地登录密码」——要做到需要 Shell 层自动登录或 LobeHub 的受信任头登录，未实现。
3. 独立版备份格式（standalone-1）与 Docker / 服务器版不同，D79 的「从服务器备份恢复到本机」需要先统一格式。
4. 安装包未做代码签名（SmartScreen 会提示「仍要运行」）。
5. Redis 用的是社区 Windows 构建（redis-windows），不是 Redis 官方发布。
6. 不能用 Docker 的功能：ParadeDB `pg_search`（用 `pg_like` 代替）、LobeHub Agent Gateway（只有 Linux 镜像）。
7. 一键卸载 Docker + WSL：`installer\standalone\Remove-DockerAndWSL.ps1`（随包，不建快捷方式、不自动运行；两次确认 + 管理员）。按 D78 只在独立版验收并迁移数据后使用。

## 9. 构建与发布

- `installer/standalone/versions.json`：全部第三方组件的版本 + SHA-256。
- `build/prepare-lobe.sh`（Ubuntu）：crane 按摘要导出官方 LobeHub 镜像 /app，换 Windows 版 sharp / ffmpeg，检查无 Linux 二进制、无非法文件名。
- `build/build-windows.ps1`（windows-latest + MSVC）：组装程序文件夹、编译 pgvector、pip 安装 LiteLLM、Prisma 生成 Windows 引擎、构建 Core / Shell、瘦身、预编译。
- `aroomo-standalone.iss`：Inno Setup，lzma2/max。
- `build/smoke-test.ps1`：静默安装后 初始化 → 启动全部服务 → LiteLLM 虚拟 Key 列模型 + 写入一个模型 → Core 健康 → LobeHub / Shell HTTP → 加密备份 → 停止 → 再启动计时 → 卸载（数据必须保留）。
- `.github/workflows/release-standalone-test.yml`：push 到 dev / p0/standalone* 时发布到**草稿**预发布 `standalone-test`（旧草稿先删）。PR 只构建和测试。
