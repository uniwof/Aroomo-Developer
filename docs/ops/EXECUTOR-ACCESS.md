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

- **全新安装，一条命令**（Hark 远程协助：经 Tailscale SSH 在她电脑上设好环境变量后运行；她不用粘贴任何东西）：
  ```powershell
  $env:AROOMO_EXECUTOR_TOKEN='<设备令牌>'; $env:AROOMO_CF_ACCESS_CLIENT_ID='<Client ID>'; $env:AROOMO_CF_ACCESS_CLIENT_SECRET='<Client Secret>'
  powershell -ExecutionPolicy Bypass -File executor\scripts\install-windows.ps1
  ```
  这些环境变量只在这个会话里，脚本用完即删；Secret 经标准输入交给 `cf-access`，不进命令行和历史。
- **已安装，只补 Access 凭据**：`<Secret 从标准输入> | node dist\cli.js cf-access <Client ID>`（标准输入是终端时拒绝，防止在屏幕上粘贴）。
- 自查：`node dist\cli.js status` 应显示「Cloudflare Access：已配置」「Core 连通：正常」。探活走 `/api/executor/hello`（`/healthz` 经公网会被 owner-only 拦，探不出真实情况）。
- 执行员只把 CF 两个头发给 `coreUrl` 同源，`redirect: 'manual'`，遇到 3xx（Access 跳登录页、或任何跳转）当错误，不跟随。

> 尚未做到：所有者在控制台点一下就把设备令牌「零粘贴」下发到电脑（需要设备授权流程，另开工单）。在那之前由 Hark 远程协助完成，见上。

## 三、实网验收 E1–E6（在 staging 跑；临时转发的结果只算「预跑」，不能当证据）

在 Hark 沙箱或所有者电脑上用 curl，`$H` = staging 域名，`$ID`/`$SEC` = 这一枚 Service Token，`$DEV` = 设备令牌。每条记下状态码和关键响应头，结果贴 #365。

| # | 请求 | 预期 |
|---|---|---|
| E1 | `POST $H/api/executor/hello`，带 CF 两个头 + `Authorization: Bearer $DEV` + 合法 JSON | 200，返回 `executorId`；控制台「本机执行员」页设备在线 |
| E2 | 同 E1 但**不带** CF 两个头 | 被 Access 拦（302 跳登录 / 403），Core 审计无新增 `executor.hello` |
| E3 | 同 E1 但用**另一枚** Service Token（或错误 Secret） | 被 Access 拦（403）；若 Access 误放行，Shell 返回 403 `ACCESS_DENIED`（common_name 不符） |
| E4 | 带正确 CF 两个头，`Authorization` 换成：无、乱写、所有者令牌、账号会话令牌、MCP 客户端令牌 | Core 401/403，不领到任何任务 |
| E5 | **带正确 CF 两个头请求 `GET $H/`、`GET $H/api/users`、`GET $H/console/`、`GET $H/aroomo/api/executors`** | **仍被 owner-only 应用拦住**（302 到 Access 登录），证明这枚 token 只能打开 `/api/executor/` |
| E6 | 带正确 CF 两个头 + 设备令牌，路径变形：`/api/executor/../users`、`/api/executor/%2e%2e/users`、`/api/executor//hello`、`/api/executor/x%2fy`、`/api/%65xecutor/hello` | 被 Access 拦，或 Shell 400/404；Core 访问日志与审计里**没有**对应请求；随后跑 #232 M3 第 1–4 条（正式通路），结果作为验收证据 |

全部通过后，在 #365 贴：Access 导出、E1–E6 结果、费用为 0 的截图；生产重复第一、二节（生产新建应用前再请所有者确认一次）。
