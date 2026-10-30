/**
 * 控制台会话 Cookie（PROGRESS「控制台会话」）：登录时可选把会话令牌放进 HttpOnly + SameSite=Strict 的 Cookie，
 * 页面脚本读不到令牌。只对账号会话有效；改动类请求（POST/PUT/PATCH/DELETE）必须带 X-Aroomo-Request 头，
 * 跨站页面发不出这个自定义头（要先过 CORS 预检，Core 不放行），作为 SameSite 之外的第二层防护。
 */
export const SESSION_COOKIE = 'aroomo_session';
export const CSRF_HEADER = 'x-aroomo-request';

/** 从 Cookie 头里取会话令牌；没有或格式不对返回 null */
export function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== SESSION_COOKIE) continue;
    const v = part.slice(i + 1).trim();
    return /^[A-Za-z0-9_-]{8,200}$/.test(v) ? v : null;
  }
  return null;
}

const base = (secure: boolean) => `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export function sessionCookie(token: string, expiresAt: Date, now: Date, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${SESSION_COOKIE}=${token}; Max-Age=${maxAge}; ${base(secure)}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Max-Age=0; ${base(secure)}`;
}

export const isSecureRequest = (req: { protocol: string; headers: Record<string, string | string[] | undefined> }): boolean =>
  req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';

export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
