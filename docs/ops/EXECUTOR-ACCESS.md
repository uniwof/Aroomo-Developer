# 执行员公网通路：Cloudflare Access 配置与实网验收（#365，负责人裁定方向 1a）

执行员（所有者电脑）→ `https://<环境域名>/api/executor/*` → Cloudflare Access（按路径的单独应用，Service Token）→ tunnel → Shell（原始路径严格检查、自验 Access JWT、按 IP 限速、精确头白名单）→ Core（只认设备令牌，设备令牌也进不了别的 /api）。

两道独立的闸：边缘 Access Service Token + Core 设备令牌；Shell 再验一遍 Access JWT，Access 配错时也还有一道闸。

## 谁做什么（负责人裁定）

| 动作 | 谁定 |
|---|---|
| 创建 / 轮换 Service Token | Hark 自行（所有者 10-28 授权范围内） |
| **新建按路径的 Access 应用和策略** | **先请所有者回一句确认**；staging 一次，生产另外一次 |
| 修改现有「Aroomo owner only」应用、上生产、花钱、删除 | 所有者本人（红线） |
| 往所有者电脑上装 token | 一条命令、零粘贴；做不到就 Hark 远程协助 |

## 上 staging 前必须满足

1. #365 的 PR 已获负责人批准（leader-approved），CI 全绿。
2. staging 设好 `CORE_OWNER_ACCOUNT_ID` 并核对过。
3. 拆掉 #232 预跑的临时转发，并**轮换预跑用过的设备令牌**（转发「沙箱 → core:8080」一段是明文）。临时转发严禁连接生产。
4. Access 配置以导出或截图附在 #365。
5. 确认费用为 0（Access 免费额度内，Service Token 不收费）。

## 一、Cloudflare Access 配置（staging 与生产各做一遍）

现有的「Aroomo owner only」应用**一个字不改**。

1. **Service Token**：Zero Trust → Access → Service credentials → Service Tokens → Create。
   - 名称：`aroomo-executor-<环境>-<设备名>`（如 `aroomo-executor-staging-owner-pc`）。一个环境一台设备一枚。
   - 时长：按默认（1 年），日历里记轮换日期。
   - 记下 Client ID（不是秘密）和 Client Secret（只显示一次；直接经安全通道交给安装步骤，不进聊天、仓库、日志、工单）。
2. **按路径的应用**：Access → Applications → Add → Self-hosted。
   - 名称：`Aroomo executor <环境>`。
   - 域名：`staging.pcmanai.com`（生产 `app.pcmanai.com`），**路径：`api/executor/`**（带尾斜杠；Access 对更具体的路径优先匹配，`/`、`/api/users` 等仍落在 owner-only 应用）。
   - 会话时长：最短（如 15 分钟）。
   - 记下应用的 **AUD 标签**（Overview → Application Audience (AUD) Tag）。
3. **策略**：只有一条。
   - Action：**Service Auth**。
   - Include：**Service Token = 第 1 步那一枚**（只这一枚；不选「Any Access Service Token」）。
   - **不准**有 Bypass、Everyone、Email、Email domain、IP 范围等任何其他规则或策略。
4. **Shell 配置**（服务器 `deploy/.env`，改前先备份；这三项都不是秘密）：
   ```
   SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN=<团队名>.cloudflareaccess.com
   SHELL_EXECUTOR_ACCESS_AUD=<第 2 步的 AUD 标签>
   SHELL_EXECUTOR_ACCESS_CLIENT_ID=<第 1 步的 Client ID>
   # SHELL_EXECUTOR_RATE_PER_MIN=120   （可选，鉴权前每 IP 每分钟上限）
   ```
   三项缺任何一项：Shell 拒绝启动；三项都留空：`/api/executor/*` 整条 404。改完 `docker compose up -d shell`。
5. **导出留痕**：应用和策略页面截图（或 `GET /accounts/<id>/access/apps/<app_id>` 与 `/policies` 的 JSON，去掉任何 secret）附到 #365。

## 二、执行员一侧（所有者电脑）

Secret 存 Windows DPAPI（当前用户，`%APPDATA%\Aroomo\executor\cf-access-secret.dpapi`），`config.json` 只写 `cfAccess.clientId`；`config.json` 里出现 secret 字段会拒绝加载。

- **全新安装（远程、非交互，#376 M7）**：三样凭据写进一个 JSON 凭据文件，经远程通道**拷贝**到她电脑（不在任何交互式 PowerShell 里敲；`$env:X='<秘密>'` 这种写法会被 PSReadLine 明文记进 `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`，禁止使用），再以非交互方式运行一条只含路径的命令：
  ```json
  {"deviceToken":"<设备令牌>","cfClientId":"<Client ID>","cfClientSecret":"<Client Secret>"}
  ```
  ```
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File executor\scripts\install-windows.ps1 -CredentialFile <凭据文件路径>
  ```
  脚本读完凭据文件立刻覆盖为零并删除；设备令牌写入只有当前用户可读的 `device-token`；Secret 经标准输入交给 `cf-access` 用 DPAPI 加密，命令行、历史、日志里都没有秘密。计划任务以**当前用户、仅登录时**运行（不是系统账户；DPAPI 按当前用户加密，换身份就解不开）。Windows CI 实跑这一整套（含真 DPAPI 往返、凭据文件已删、计划任务运行身份）。
- **远程通道是什么（未定，等所有者本人选）**：凭据文件要从 Hark 到她电脑，命令要在她电脑上跑，都需要一条远程通道。现状与选项：
  - **Tailscale SSH 用不了**：Tailscale SSH 的服务端只支持 Linux 和 macOS（开源 tailscaled），不支持 Windows（[Tailscale 文档 · Prerequisites / Limitations](https://tailscale.com/kb/1193/tailscale-ssh)）。Tailscale 本身只提供网络层。
  - **选项 A：在她电脑上开 Windows 自带的 OpenSSH Server（sshd），只放行 Tailscale 网段、只允许密钥登录**，Hark 经 tailnet 用 `scp` 拷凭据文件、`ssh` 非交互运行上面那条命令。**这是对她电脑的安全变更（新开一个入站服务），必须所有者本人确认后才能做**；做之前要写清：监听范围、密钥放哪、用完是否关闭。
  - **选项 B：不开任何入站服务**，由所有者或在场的人把凭据文件放到指定位置并运行那条只含路径的命令（命令里没有秘密，不需要粘贴令牌）。对视力不便不友好，只作后备。
  - **选项 C：控制台「零粘贴」下发（设备授权流程）**，另开工单；给家人或客户发执行员之前必须完成（负责人 #376 第 1 轮 Q3）。
  - 这里不替所有者决定；在她选定之前，远程安装不执行。
- **已安装，只补 Access 凭据**：`<Secret 从标准输入> | node dist\cli.js cf-access <Client ID>`（标准输入是终端时拒绝，防止在屏幕上粘贴）。
- 自查：`node dist\cli.js status` 应显示「Cloudflare Access：已配置」「Core 连通：正常」。探活走 `/api/executor/hello`（`/healthz` 经公网会被 owner-only 拦，探不出真实情况）。
- 执行员只把 CF 两个头发给 `coreUrl` 同源，`redirect: 'manual'`，遇到 3xx（Access 跳登录页、或任何跳转）当错误，不跟随。

> 尚未做到：所有者在控制台点一下就把设备令牌「零粘贴」下发到电脑（选项 C，另开工单）。

**令牌规则（#376 M4）**：设备令牌只能带 `tasks:pull` / `tasks:secret`，签发时混入别的范围 → 400 `MIXED_SCOPES`；本 PR 之前签发的混合令牌在 Core 上一律失效（执行员接口和其他接口都 403、`/v1` 401）。**上 staging 前盘点 staging 现存的混合令牌**（`client_tokens` 里同时带执行员范围和别的范围的未吊销行），结果贴 #365，受影响的设备重发纯设备令牌。

## 三、实网验收 E1–E7（在 staging 跑；临时转发的结果只算「预跑」，不能当证据）

在 Hark 沙箱或所有者电脑上用 curl，`$H` = staging 域名，`$ID`/`$SEC` = 这一枚 Service Token，`$DEV` = 设备令牌。每条记下状态码和关键响应头，结果贴 #365。

| # | 请求 | 预期 |
|---|---|---|
| E1 | `POST $H/api/executor/hello`，带 CF 两个头 + `Authorization: Bearer $DEV` + 合法 JSON | 200，返回 `executorId`；控制台「本机执行员」页设备在线 |
| E2 | 同 E1 但**不带** CF 两个头 | 被 Access 拦（302 跳登录 / 403），Core 审计无新增 `executor.hello` |
| E3 | 同 E1 但用**另一枚** Service Token（或错误 Secret） | 被 Access 拦（403）；若 Access 误放行，Shell 返回 403 `ACCESS_DENIED`（common_name 不符） |
| E4 | 带正确 CF 两个头，`Authorization` 换成：无、乱写、所有者令牌、账号会话令牌、MCP 客户端令牌 | Core 401/403，不领到任何任务 |
| E5 | **带正确 CF 两个头请求 `GET $H/`、`GET $H/api/users`、`GET $H/console/`、`GET $H/aroomo/api/executors`** | **仍被 owner-only 应用拦住**（302 到 Access 登录），证明这枚 token 只能打开 `/api/executor/` |
| E7 | **浏览器带 Access 会话**（所有者用邮箱登录过 owner-only 应用、带 `CF_Authorization` Cookie）请求 `POST $H/api/executor/hello`，不带 Service Token | **被拒**：按路径的应用只认 Service Token（策略只有 Service Auth），浏览器会话进不来（302 / 403）；即使边缘放行，Shell 校验 JWT 的 AUD / common_name 不符 → 403 `ACCESS_DENIED`；Core 审计无新增 `executor.hello` |
| E6 | 带正确 CF 两个头 + 设备令牌，路径变形：`/api/executor/../users`、`/api/executor/%2e%2e/users`、`/api/executor//hello`、`/api/executor/x%2fy`、`/api/%65xecutor/hello` | 被 Access 拦，或 Shell 400/404；Core 访问日志与审计里**没有**对应请求；随后跑 #232 M3 第 1–4 条（正式通路），结果作为验收证据 |

E1–E7 全部通过后，才跑 #232 M3 第 1–4 条作为正式验收。在 #365 贴：Access 导出、E1–E7 结果、混合令牌盘点结果、费用为 0 的截图；生产重复第一、二节（生产新建应用前再请所有者确认一次）。
