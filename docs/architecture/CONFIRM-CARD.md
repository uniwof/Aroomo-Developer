# 确认卡（ConfirmCard）接口约定

> 对应决策：DECISIONS **D63**（统一用一个确认卡组件，分两级）、D62（操作员不能完成重要确认）、D50（审计）。
> 服务端实现：`core/src/confirm/`（`confirm.ts` 确认服务、`access.ts` Cloudflare Access 校验、`routes.ts` 接口）。
> 本仓库目前没有前端包；组件本身随 LobeHub 界面改造实现，**必须**按本文的接口做。手机和电脑共用这一个组件，界面上不允许出现任何其他确认方式（浏览器 `confirm()`、自制弹窗、「输入 DELETE 确认」等都不行）。

## 1. 两级

| 级别 | 适用 | 用户看到的 | 服务端怎么判 |
|------|------|-----------|-------------|
| 普通（`normal`） | 收件箱里的一般动作（同意、不采纳、稍后…） | 卡片上点一下按钮 | 这一次请求本身就是确认；服务端记一条 `confirm.normal` 审计 |
| 重要（`important`），`kind` = `irreversible` 不可逆 / `payment` 花钱 / `credential` 涉及凭据 | 彻底删除成员、收件箱里标为重要的动作、新增 / 替换 / 删除 Key 等 | 卡片写明**后果**；点两次；第二次按钮有 3 秒倒计时；`credential` 在第二次之前要重新验证 Cloudflare Access | 两步确认后签发一次性令牌，带令牌重发原请求才执行；3 秒由服务端强制 |

当前用到重要确认的接口：

| 接口 | kind |
|------|------|
| `POST /api/members/:id/purge` | irreversible |
| `POST /api/inbox/:id/actions/:actionId`（动作的 `confirm.kind` 不是 `normal` 时） | 按动作 |
| `POST /api/keys`、`PATCH /api/keys/:id`（带 `apiKey`）、`DELETE /api/keys/:id` | credential |

## 2. 流程

```
组件                                   Core
 │ 1. 用户点卡片上的按钮（或界面上的「删除」等）
 │ ── 原请求（不带 confirmToken）──────────────▶ 普通：直接执行，返回 2xx（结束）
 │ ◀── 428 { error: { code: "CONFIRM_REQUIRED", confirm: Challenge } }   重要：不执行
 │ 2. 渲染确认卡：title、consequences、按钮①
 │ ── POST {stepUrl} {step:1} ────────────────▶ 记第一次点击
 │ ◀── 200 { confirm: Challenge(nextStep=2, step2NotBefore) }
 │ 3. 按钮②显示倒计时，到 step2NotBefore 才可点（以服务端时间为准，见第 5 节）
 │    credential：先引导重新验证 Cloudflare Access（第 4 节）
 │ ── POST {stepUrl} {step:2}（经 Access，带 Cf-Access-Jwt-Assertion）▶ 不满 3 秒 425；Access 不新 401
 │ ◀── 200 { confirm: Challenge(nextStep=0), confirmToken }
 │ 4. 自动用同样的请求体 + confirmToken 重发原请求（用户不再点）
 │ ── 原请求 + { confirmToken } ──────────────▶ 校验并消费令牌 → 执行
 │ ◀── 2xx
```

令牌：一次性、5 分钟内有效（从第 1 步的 428 算起）、绑定操作范围（scope）+ 操作者 + 请求体（加盐摘要）。请求体改了（例如换了一个 Key）令牌就无效。

## 3. 数据结构

### Challenge（服务端返回）

```ts
interface Challenge {
  id: string;                  // uuid
  level: 'important';
  kind: 'irreversible' | 'payment' | 'credential';
  title: string;               // 卡片标题：要做什么，例如「彻底删除成员「Groq」」
  consequences: string[];      // 后果，每条一句，至少一条；必须全部显示，不能折叠
  confirmLabel: string;        // 第二次点击按钮上的字，例如「彻底删除」
  steps: 2;
  nextStep: 0 | 1 | 2;         // 下一步该点第几次；0 = 已完成
  minDelayMs: number;          // 3000
  step2NotBefore: string | null; // ISO 时间；第一步完成后才有
  requiresAccessReauth: boolean; // true = 第二次点击前要重新验证 Cloudflare Access
  expiresAt: string;           // ISO 时间
  stepUrl: string;             // POST 这里完成每一步，例如 /api/confirm/<id>/steps
}
```

### 收件箱卡片上的动作

```ts
interface InboxAction {
  id: string;
  label: string;
  confirm?: { kind: 'normal' | 'irreversible' | 'payment' | 'credential'; consequences?: string[] };
  // 旧数据可能有 irreversible: true，等同 confirm.kind = 'irreversible'
}
```

普通动作直接渲染成按钮；重要动作的按钮第一次点下去会得到 428，按第 2 节继续。卡片在拿到 428 之前就可以先把 `confirm.consequences` 显示出来。

### 组件属性（建议）

```ts
interface ConfirmCardProps {
  // 普通：只有 label 和 onConfirm；重要：传入 428 里的 challenge
  level: 'normal' | 'important';
  title: string;
  label?: string;                 // 普通确认按钮的字
  challenge?: Challenge;          // 重要确认
  send: (confirmToken?: string) => Promise<Response>; // 发原请求；组件在拿到令牌后自动调用 send(token)
  onDone: (res: Response) => void;
  onCancel: () => void;
}
```

## 4. 涉及凭据：重新验证 Cloudflare Access

- `requiresAccessReauth: true` 时，组件在按钮②之前显示「请重新验证身份」，打开 Access 的重新登录（例如 `/cdn-cgi/access/logout` 后重新进入，或团队登录页），回来后再允许点按钮②。
- 第 2 步请求必须经过 Cloudflare Access（Access 会自动加 `Cf-Access-Jwt-Assertion` 头）。如果前端经 LobeHub 转发到 Core，转发时**必须保留这个头**。
- 服务端校验：签名（团队公钥）、`aud`、`iss`、未过期；`iat` 不早于 challenge 创建时间（允许 30 秒时钟偏差），且距现在不超过 `CORE_ACCESS_REAUTH_MAX_AGE_S`（默认 300 秒）。不满足返回 401 `ACCESS_REAUTH_REQUIRED`，用户重新验证后可以再点一次按钮②（不用从头来）。
- 服务器没有配置 Access（`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD`）且 `CORE_ACCESS_REAUTH=required` 时，凭据操作在第一步就返回 503 `ACCESS_REAUTH_NOT_CONFIGURED`，不会悄悄放行。本地 Windows 版没有 Access，设 `CORE_ACCESS_REAUTH=off`：仍然两次点击 + 3 秒，审计里记 `reauth=off`。

## 5. 错误码

| HTTP | code | 组件怎么做 |
|------|------|-----------|
| 428 | `CONFIRM_REQUIRED` | 渲染重要确认卡（`error.confirm`） |
| 425 | `CONFIRM_TOO_EARLY` | 还没到 3 秒；`error.retryAfterMs` 后再允许点（服务端时间为准，倒计时按这个修正） |
| 401 | `ACCESS_REAUTH_REQUIRED` | 引导重新验证 Access，然后允许再点按钮② |
| 409 | `CONFIRM_STEP1_REQUIRED` | 先点按钮① |
| 409 | `CONFIRM_EXPIRED` / `CONFIRM_USED` / `CONFIRM_INVALID` | 关掉卡片，提示「请重新操作」，从原请求重新开始 |
| 403 | `FORBIDDEN` | 操作员令牌不能完成重要确认（D62）；只显示提示，不再重试 |
| 503 | `ACCESS_REAUTH_NOT_CONFIGURED` | 提示「服务器还没配置身份验证，暂时不能修改 Key」 |

## 6. 界面要求（D63 + D2/D8）

1. 同一个组件、同一套交互用于手机和电脑；只按屏幕宽度调整排版。
2. 重要确认卡：标题 → 后果列表（全部展开）→ 按钮①（「继续」）→ 按钮②（`confirmLabel`，带倒计时「3、2、1」，倒计时期间不可点、并对读屏软件报告剩余秒数）。按钮②之前显示「请重新验证身份」（仅 credential）。
3. 取消随时可用（关闭卡片即可；challenge 会自然过期）。
4. 不在前端缓存或显示 `confirmToken`；拿到后立刻用于重发并丢弃。
5. 按钮①、②位置错开，避免连点两下误触。
