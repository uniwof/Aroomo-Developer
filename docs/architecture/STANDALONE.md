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
| 所有者 | 包含完整档模块（收藏 Karakeep + 搜索、网页代办 + Chromium 等），取消体积上限 | Karakeep + Meilisearch + Chromium、RSSHub 已原生接入；网页代办没有服务可接（§6） |
| D70 关切 | 不在 Core 里重做路由 / Key / 限额 | 打包 LiteLLM 本体（PyPI 官方 Windows wheel，和服务器同为 1.106.4）。之前的「Core 内置网关」草稿已删除 |
| D71 关切 | 不公开分发含 LobeHub 的安装包 | 只发草稿（所有者已同意打包）。仓库改为私有后可以改成普通预发布 |
| D64/D65 | age 公钥加密备份，本机 3 份，主密钥不离开电脑 | 沿用；主密钥用 DPAPI 保存在本机（D78） |
| D68/D69 | 隐藏 §8 以外功能、TTS 隐藏且禁用；薄层不 fork | 官方 `FEATURE_FLAGS` 关掉能关的；其余由 Aroomo Shell 隐藏（和 Docker 版同一个 shell/） |
| D73 | 用户手动增改 Key = 普通保存；智能体 / 操作员新增、查看明文、导出、删除 = 重要确认 | Core 的 keys 服务实现，独立版和 Docker 版共用同一份 Core |
| D77-1 | 先评估官方 LobeHub Desktop | 结论见 §3：**不采用** |
| D77-3 | 一个 PG、一个 Node、python-build-standalone、预编译；后台冷启动 ≤ 15 秒 | 组成已按此实现（§2）；启动按依赖并行、完整档模块延后、跳过已做过的迁移（§4.1），CI 每次记录启动计时 |
| D77-4 | 登录 30 秒后静默启动；窗口立即出现，未就绪显示「正在准备」 | `aroomo-launch.vbs tray 30` + `preparing.html` |
| D77-5/6 | 分层更新、A/B 目录、回滚；更新源用 R2 / app.pcmanai.com + ed25519 签名清单 | 设计见 §7，**本版未实现** |
| D78 | %LOCALAPPDATA%、无管理员、无选项、装完自动打开；只需粘贴一次主密钥（DPAPI）；托盘红黄绿；自动修复；「修复」按钮 + 诊断包；无语音；标准控件 | 已实现，R2 自动恢复和诊断包上传未实现（§8） |
| D79 | 服务器为主、本机为热备；开机单向从 R2 恢复；日常窗口连服务器 | 备份格式已和服务器统一，能恢复服务器备份（§5）；开机自动恢复和窗口连服务器见 §7，**未实现** |

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
  LobeHub 本身要求一个账号（Better Auth）：安装程序生成随机主人账号（`LOCAL_OWNER_EMAIL` / `LOCAL_OWNER_PASSWORD`，只在本机配置里），Shell 替浏览器自动登录（只在只听 127.0.0.1 时允许开启；Docker / 服务器版不开）。
- 托盘：绿 = 正常，黄 = 准备 / 修复中，红 = 有服务没起来（气泡一句话，点它 = 修复）。每 20 秒巡检，进程退出就重启；失败后 5 分钟内不反复重试。
- 「修复」：停止 → 清掉残留进程和过期的 PG 锁文件 → 换掉被占端口 → 启动 → 生成去掉密钥的诊断包（`diagnostics\*.zip`：日志末尾 2000 行，配置里所有密钥值替换成「[已隐藏]」）。
- 数据库损坏 → 恢复最近的本机备份（需要普通确认）：恢复函数已有（`Restore-AroomoSABackup`），自动检测损坏**未实现**。
- 没有语音提示；所有窗口用标准 WinForms 控件 + 14pt 字号，有 AccessibleName。

### 4.1 启动速度（D77-3：后台冷启动 ≤ 15 秒）

`start`（托盘、修复都调用它）由 `Start-AroomoSAParallel` 按每个服务的 `DependsOn` 并行启动：

| 阶段 | 服务 | 说明 |
| --- | --- | --- |
| 立即 | Shell、Redis、RustFS、PostgreSQL | Shell 不依赖任何服务，最先就绪：窗口一打开就是 Aroomo 自己的「正在准备」页，LobeHub 好了自动进入 |
| 数据库就绪后 | LiteLLM、Core、LobeHub（LobeHub 还等 Redis、RustFS） | 三个同时起；LobeHub 启动不需要 LiteLLM（对话时才用） |
| 主界面就绪后 | Meilisearch、Chromium、收藏（Karakeep + 后台任务）、RSSHub | `Deferred`：主界面就绪后才启动、`start` 不等它们就绪（不和主界面抢 CPU）；托盘每 20 秒巡检照常看管。`start -WaitAll`（修复、冒烟测试）会等它们也就绪 |

其他：

- **健康检查先看系统监听表**（`Get-AroomoSAListeningPorts`）：Windows 上连一个没人听的本机端口要等 1～2 秒（系统重试 SYN），以前每个还没起来的服务都要空等这一下（启动前检查、换端口检查、托盘巡检各一次）。现在端口没在听就直接算「没就绪」。就绪轮询间隔 2 秒 → 0.25 秒。
- **启动标记**（`<数据文件夹>\state\`）：`litellm-schema`（随包 LiteLLM 的版本）、`lobe-schema`（LobeHub 程序包的 SHA-256）、`lobe-bucket`。版本对得上时第二次启动跳过 LiteLLM 的 Prisma 迁移（`DISABLE_SCHEMA_UPDATE=true`，LiteLLM 仍会做一次只读的结构比对）、LobeHub 的数据库迁移（`AROOMO_LOBE_SKIP_MIGRATION=1`，`runtime/lobe-start.cjs`）和建桶。换版本、新建数据库（initdb）、从备份恢复后标记作废，下次启动照常迁移（备份可能来自别的版本）。
- LiteLLM 用随包的模型价格表（`LITELLM_LOCAL_MODEL_COST_MAP=True`）：启动时不去 GitHub 下载，断网时不用等超时。
- 每次启动把每个服务「开始 / 就绪」的秒数写进 `logs\startup-timing.json`，`launcher.log` 里一行摘要；冒烟测试打印第二次启动的 `ui_ready_s`（界面可用：Shell 替浏览器登录 LobeHub 成功）、`second_start_s`（`start` 结束：主界面全部就绪）、`all_ready_s`（完整档模块也就绪）和每个服务的计时，超过 15 秒时在 CI 里给出警告（不判失败：CI 机器的速度和用户电脑不同）。

## 5. 备份（D64、D65、D79：和服务器同一格式）

格式和服务器 `scripts/backup.sh` 一致（**format 2**）：`aroomo-<标签>-<UTC 时间>.tar.zst.age` + 明文 `.meta.json`。压缩包里：
`backup-stage/`（`manifest.json`、`globals.sql`、`db/<库>.dump`，每个库 `pg_dump -Fc`）、`data/secrets/aroomo.env`、`data/rustfs/`（对象存储）；独立版另有 `data/karakeep/`（收藏资料）和 `backup-stage/karakeep-db.db`（收藏 SQLite 的在线一致副本）。zstd 用随包的官方 `zstd.exe`，加密用 age（主密钥的公钥）。Windows 自带的 tar.exe（bsdtar）不支持 `-s` 改名，所以对象存储和收藏资料先硬链接（不同盘时复制）到 `<数据文件夹>\backup-tmp-*\data\` 再打包，打完删除。`backups\` 留 3 份；配置了 S3（R2）时 rclone 上传到 `pc/<电脑名>/`，按天 / 周 / 月保留。
时机：每次登录后后台就绪时、托盘「退出」时、「立即备份」。主密钥只用于恢复（DPAPI 解出，用完删临时文件）。

**恢复（`Restore-AroomoSABackup`）认三种来源：** 本机 format 2、早期测试版 `standalone-1`（`.tar.gz.age`）、**服务器的 format 2**（D79 单向恢复）。
恢复服务器备份时：只从服务器配置里取「打开数据要用的密钥」（`KEY_VAULTS_SECRET`、`AUTH_SECRET`、`JWKS_KEY`、`LITELLM_SALT_KEY`、`LITELLM_MASTER_KEY`、`CORE_TOKEN_SECRET`、`CORE_OWNER_TOKEN`、`LOBE_LITELLM_VIRTUAL_KEY`），端口、数据库密码、本机主人等保留本机的；`pg_restore -L` 去掉 Windows 版 PostgreSQL 没有的 ParadeDB 扩展（`pg_search`、`pg_cron`、`pg_stat_statements`）和 bm25 索引（LobeHub 改用 `pg_like`）；对象存储同为 RustFS 1.0.4。
CI 冒烟测试做本机备份 → 恢复演练（删库重建再导入）→ 重启 → 核对数据；**用真正的服务器备份恢复还没演练**（需要 R2 和主密钥，见 §8）。Meilisearch 索引不备份，恢复后清掉，由收藏重建。

## 6. 完整档模块（所有者 2026-10-28：全部功能离线可用、取消体积上限）

| 模块 | 做法 | 本版状态 |
| --- | --- | --- |
| LobeHub、LiteLLM、Core、Shell、PG + pgvector、Redis、RustFS、备份 | §2 | 已包含，CI 冒烟测试 |
| 本机主人自动登录（D78） | Shell 只听 127.0.0.1 时，替浏览器用随机主人账号登录 LobeHub（Better Auth 邮箱登录 / 第一次注册）；收藏（Karakeep 0.34 同为 Better Auth）由 `runtime/karakeep-gate.cjs` 用同一个主人账号做同样的事（Karakeep 改听本机空闲端口，3283 上是只听本机的转发）；用户不注册、不输入密码 | 已包含，CI 检查 |
| 收藏 Karakeep 0.34.1（+ 搜索） | `build/prepare-apps.sh`：官方镜像 `/app` + `/db_migrations` 原样使用，sharp / re2 换官方 Windows 预编译，better-sqlite3 用自带的 win32 预编译；`runtime/karakeep-start.cjs` 代替镜像里的 s6：迁移 → web；workers 单独进程。Meilisearch 官方 Windows 版；抓网页用随包 Chromium（无界面，只开 127.0.0.1 调试端口）；OCR 语言数据（英文、简体中文）随包；AI 打标签走本机 LiteLLM | 已包含（端口 3283，开始菜单「Aroomo 收藏」），CI 检查 |
| RSSHub | 官方镜像 `/app`（按摘要固定），oxc-parser 换 Windows 绑定，ws 用纯 JS；需要浏览器的路由用随包 Chromium；内存缓存 | 已包含（端口 1280），CI 检查 |
| 网页代办（智能体操作浏览器） | Core 侧服务尚未实现（P1+，Docker 版也没有）；Chromium 已随包 | **未接入**：没有服务可接。最近替代：收藏的网页抓取 + RSSHub 已用同一个 Chromium |
| MetaMCP、OpenMemory | Docker 版也还没有；OpenMemory 按 PRODUCT §7 用 pgvector 代替 | 未接入 |
| LobeHub Agent Gateway | 官方只发 Linux 镜像 | 默认关闭（Docker 版也默认关闭） |

本来就要联网的：云端模型 API、R2 异地备份、更新、收藏「抓网页」和 RSSHub 拉取订阅源（访问的是外部网站）。
离线时为了能启动而关掉的：收藏的广告过滤（规则要从网上下载）、视频下载（需要 yt-dlp，没带）。

## 7. 后续设计（本版未实现）

**D79 服务器为主、本机热备：** 托盘启动时若配置了 R2，下载服务器最新备份，DPAPI 解出主密钥，用 `Restore-AroomoSABackup` 恢复到本机（单向，不双向同步；格式已统一，§5）。窗口默认打开 `https://app.pcmanai.com`（Cloudflare Access），服务器连不上时自动改开本机。

**D77-5/6 更新：** 三层包（runtime：node/python/pgsql/…；app：core/shell/litellm 配置/启动器；ui：lobe.tar.gz），各自独立版本号。清单 `manifest.json` 用 ed25519 签名（私钥只在 CI 机密里，公钥随安装包），放在 R2 或 app.pcmanai.com，验签失败一律拒绝。A/B 两个程序目录，升级前先备份，切换后健康检查，不通过自动回滚；空闲时静默升级。

## 8. 已知问题和限制

1. **未在用户电脑上验证**：只在 GitHub windows-latest 上做了静默安装 + 冒烟测试 + 恢复演练。
2. 收藏（Karakeep）的主人自动登录用的是在 Karakeep 前面加一层本机转发（`runtime/karakeep-gate.cjs`），Karakeep 升级改了 Better Auth 接口时要跟着核对（CI 冒烟测试会检查）。
3. 用服务器真实备份恢复到本机（D79）代码已写、格式一致，但没有演练过（需要 R2 桶和主密钥）。开机自动从 R2 恢复、窗口默认连服务器（§7）未实现。
4. 安装包未做代码签名（SmartScreen 会提示「仍要运行」）。
5. Redis 用的是社区 Windows 构建（redis-windows），不是 Redis 官方发布。
6. 不能用 Docker 的功能：ParadeDB `pg_search`（用 `pg_like` 代替）、LobeHub Agent Gateway（只有 Linux 镜像）。
7. 一键卸载 Docker + WSL：`installer\standalone\Remove-DockerAndWSL.ps1`（随包，不建快捷方式、不自动运行；两次确认 + 管理员）。按 D78 只在独立版验收并迁移数据后使用。
8. Karakeep / RSSHub 用 Node 22 运行（官方镜像用 Node 24）；RSSHub 上游只发 `latest`，按摘要固定，升级要手动换摘要。

## 9. 构建与发布

- `installer/standalone/versions.json`：全部第三方组件的版本 + SHA-256。
- `build/prepare-lobe.sh`（Ubuntu）：crane 按摘要导出官方 LobeHub 镜像 /app，换 Windows 版 sharp / ffmpeg，检查无 Linux 二进制、无非法文件名。
- `build/build-windows.ps1`（windows-latest + MSVC）：组装程序文件夹、编译 pgvector、pip 安装 LiteLLM、Prisma 生成 Windows 引擎、构建 Core / Shell、瘦身、预编译。
- `aroomo-standalone.iss`：Inno Setup，lzma2/max。
- `build/smoke-test.ps1`：静默安装后 初始化 → 启动全部服务 → LiteLLM 虚拟 Key 列模型 + 写入一个模型 → Core 健康 → LobeHub / Shell HTTP → 加密备份 → 恢复演练 → 停止 → 恢复后启动（重新迁移）并核对数据 → 停止 → 第二次启动计时（§4.1）→ 卸载（数据必须保留）。
- `.github/workflows/release-standalone-test.yml`：push 到 dev / p0/standalone* 时发布到**草稿**预发布 `standalone-test`（旧草稿先删）。PR 只构建和测试。
