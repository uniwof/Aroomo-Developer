/**
 * 控制台会话 Cookie（PROGRESS「控制台会话」）：登录时可选把会话令牌放进 HttpOnly + SameSite=Strict 的 Cookie，
 * 页面脚本读不到令牌。只对账号会话有效；改动类请求（POST/PUT/PATCH/DELETE）必须带 X-Aroomo-Request 头，
 * 跨站页面发不出这个自定义头（要先过 CORS 预检，Core 不放行），作为 SameSite 之外的第二层防护。
 *
 * Cookie 名：https（staging / 生产）：`__Host-aroomo_session`——浏览器强制 Secure、Path=/、不能带 Domain，
 * staging（staging.pcmanai.com，对话经 Shell 转发；chat-staging / core-edge 已移除，#267）写不了一个 .pcmanai.com 的同名 Cookie
 * 去顶替生产的（#264 负责人必改 1）。
 * http（电脑版本机、测试）：浏览器不让 http 页面写 Secure Cookie，只能用旧名 `aroomo_session`。
 */
export const SESSION_COOKIE = '__Host-aroomo_session';
/**
 * 旧名：http 下继续用；https 下只为过渡继续**读**（升级前登录的会话不用重新登录），不再写。
 * shortcut: 过渡期内 https 上没有 __Host- Cookie 时仍认旧名；所有人重新登录一次之后（D255 记录的过渡期结束）删掉旧名的读取。
 */
export const LEGACY_SESSION_COOKIE = 'aroomo_session';
export const CSRF_HEADER = 'x-aroomo-request';

const TOKEN_RE = /^[A-Za-z0-9_-]{8,200}$/;

/** 从 Cookie 头里取会话令牌：先认 __Host- 名，没有再认旧名；没有或格式不对返回 null */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  const found = new Map<string, string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if ((name === SESSION_COOKIE || name === LEGACY_SESSION_COOKIE) && !found.has(name)) found.set(name, part.slice(i + 1).trim());
  }
  const v = found.get(SESSION_COOKIE) ?? found.get(LEGACY_SESSION_COOKIE);
  return v !== undefined && TOKEN_RE.test(v) ? v : null;
}

const attrs = (secure: boolean) => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
const nameFor = (secure: boolean) => (secure ? SESSION_COOKIE : LEGACY_SESSION_COOKIE);

export function sessionCookie(token: string, expiresAt: Date, now: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${nameFor(secure)}=${token}; Max-Age=${maxAge}; ${attrs(secure)}`;
}

/** 退出：把会用到的名字都设为过期（https 上连过渡期的旧名一起清掉） */
export function clearSessionCookie(secure: boolean): string[] {
  const out = [`${LEGACY_SESSION_COOKIE}=; Max-Age=0; ${attrs(secure)}`];
  if (secure) out.unshift(`${SESSION_COOKIE}=; Max-Age=0; ${attrs(true)}`);
  return out;
}

export const isSecureRequest = (req: { protocol: string; headers: Record<string, string | string[] | undefined> }): boolean =>
  req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
