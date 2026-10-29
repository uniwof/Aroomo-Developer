# Aroomo 本机执行员（executor/）

在所有者自己的电脑上运行的小程序：主动连到 Aroomo Core，领取「签到 / 登录 / 注册 / 浏览」任务，
用本机浏览器（ego lite 为主，Playwright MCP 备用）完成，再把进度、结果和截图摘要报回 Core。
遇到验证码、两步验证、付款会暂停，在收件箱推一张「接管卡」，你处理完它再继续。

依据：DECISIONS D162、D173、D189、D192；协议见 [docs/executor-protocol.md](../docs/executor-protocol.md)。

## 安全要点

- **只出站**：不在你的电脑上开任何端口。
- **白名单**：只访问 `allowlist.sites` 里的网站；默认是空的，什么都不访问（保守默认，待 Q5 确认初始名单）。
- **凭据不落盘**：账号密码只在填写那一刻从 Core 保险箱按 secret id 取，放在内存里，用完即弃；日志、进度、结果全部脱敏。
- **登录状态留在本机**：由 ego lite 自己保存，Aroomo 不导出、不保存 cookie。
- 设备令牌不写进 config.json，单独放在 `device-token` 文件（或环境变量 `AROOMO_EXECUTOR_TOKEN`）。

## Windows 安装（优先）

> 需要 Node.js 22 LTS。备用的 Playwright MCP 需要本机装有 Chrome（首次使用时 npx 自动下载 @playwright/mcp）。ego lite 由你自己从官方安装（我们不打包、不分发），并在 ego lite 设置里**关闭崩溃报告上传**（D162）。

```powershell
# 1. 构建（开发期；正式版会给一个一键安装脚本）
cd executor
npm ci
npm run build

# 2. 生成配置：%APPDATA%\Aroomo\executor\config.json
node dist\cli.js init

# 3. 编辑 config.json：在 allowlist.sites 里加允许的网站，例如
#    "sites": ["example.com", "*.example.org"]

# 4. 把控制台「本机执行员」页生成的令牌保存为 %APPDATA%\Aroomo\executor\device-token
#    并只让自己能读：
icacls "$env:APPDATA\Aroomo\executor\device-token" /inheritance:r /grant:r "$($env:USERNAME):R"

# 5. 检查
node dist\cli.js check
node dist\cli.js check-url https://example.com/

# 6. 前台试跑（Ctrl+C 退出）
node dist\cli.js run
```

### 开机自启（登录后自动运行，无需管理员）

```powershell
$node = (Get-Command node).Source
$cli  = (Resolve-Path dist\cli.js).Path
$act  = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" run"
$trg  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit 0 -StartWhenAvailable
Register-ScheduledTask -TaskName "Aroomo Executor" -Action $act -Trigger $trg -Settings $set -Description "Aroomo 本机执行员"
```

取消自启：`Unregister-ScheduledTask -TaskName "Aroomo Executor"`。

## macOS / Linux

同样 `npm ci && npm run build && node dist/cli.js init`，配置在 `~/.config/aroomo/executor/`。

## 命令

| 命令 | 作用 |
|---|---|
| `init` | 生成默认配置（白名单为空） |
| `check` | 检查配置和令牌是否就绪（不显示令牌） |
| `check-url <网址>` | 看某个网址是否允许 |
| `run` | 连接 Core，开始领任务 |

## 开发

```bash
npm ci
npm run check   # lint + typecheck + test（测试用 test/mock-core.ts 模拟 Core）
```

目录：

- `src/transport.ts` — 与 Core 通信（HTTP 长轮询，可替换）
- `src/runner.ts` — 主循环：上线、领取、心跳续租、接管等待、回报、断线重连
- `src/tasks/` — 任务类型 checkin / login / signup / browse
- `src/ports/browser.ts` — 任务用的高层浏览器端口；`src/ports/driver.ts` — 驱动原语（快照 / 点击 / 填写 / 交给所有者）
- `src/adapters/ego-lite.ts` — ego lite 驱动：经 `ego-browser nodejs` 的 stdin 传脚本（值不进命令行、不落盘），工作空间命名 `aroomo-…`
- `src/agent/` — 规划器与驱动→任务会话的包装：`model-planner.ts` 经 Core /v1 让模型规划（配置 `planner.type: "model"`，默认，模型 `aroomo/auto`；只发脱敏快照和字段名，失败自动退回规则版）；`planner.ts` 规则版（`planner.type: "rule"` 时不把页面内容发给任何模型）
- `src/adapters/playwright-mcp.ts` + `mcp-stdio.ts` — Playwright MCP 备用驱动（`npx -y @playwright/mcp@0.0.83 --browser chrome --user-data-dir <配置目录>\pw-profile`，独立持久配置，有界面，遇验证码直接在窗口里处理）；最小 MCP stdio 客户端，零依赖
- `src/adapters/droidrun.ts` + `bridges/droidrun_bridge.py` — 云手机 / 安卓（DroidRun，现名 mobilerun，MIT）：需要本机 Python 3.11–3.13 与 `pip install mobilerun`；配置 `phone: { enabled: true, device: { serial | control_backend + device_id } }`（云手机厂商待 Q3）；任务 `options.device = "phone"`、`site = "android-app://包名"`，按 `allowlist.apps` 校验；凭据经 type_secret 按 secret id 输入，模型看不到值；
- 新驱动新驱动加进 `test/driver-contract.test.ts` 的 DRIVERS 即跑同一套合同测试
- `src/allowlist.ts`、`src/redact.ts` — 白名单与脱敏

依赖只用可商用许可证（运行时零第三方依赖；开发依赖 TypeScript/ESLint/Vitest 均为 MIT/Apache-2.0）。
