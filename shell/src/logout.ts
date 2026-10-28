/**
 * 退出登录（PRODUCT §8.3 设置「账号」；docs/ops/OLD-VS-NEW.md #2）。
 * POST /aroomo/logout（同源 + 自定义头，防跨站）：
 *   1. 替浏览器调用 LobeHub 的 Better Auth `POST /api/auth/sign-out`，把它清 Cookie 的 Set-Cookie 原样带回；
 *      LobeHub 没响应时也把常见的会话 Cookie 设为过期（兜底）。
 *   2. 返回下一步要去的地址：经过 Cloudflare Access 的请求（服务器版，带 Cf-Access-Jwt-Assertion 头）
 *      → `/cdn-cgi/access/logout`（同时结束 Access 会话）；否则（电脑版）→ `/signin`。
 * 不需要先登录（已经过期的会话也能「退出」）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ACCESS_LOGOUT = '/cdn-cgi/access/logout';

/** 兜底：Better Auth 的会话 Cookie（http 与 https 两种前缀） */
const FALLBACK_EXPIRE = ['better-auth.session_token', 'better-auth.session_data'].flatMap((n) => [
  `${n}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  `__Secure-${n}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
]);

export function logoutDestination(req: IncomingMessage): string {
  return req.headers['cf-access-jwt-assertion'] ? ACCESS_LOGOUT : '/signin';
}

export async function handleLogout(
  req: IncomingMessage,
  res: ServerResponse,
  lobe: URL,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  let cookies: string[] = [];
  const cookie = req.headers.cookie;
  if (cookie) {
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]!.trim();
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0]!.trim();
    const origin = (req.headers.origin as string | undefined) ?? (host ? `${proto}://${host}` : undefined);
    try {
      const r = await fetchImpl(new URL('/api/auth/sign-out', lobe), {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/json',
          accept: 'application/json',
          ...(origin ? { origin } : {}),
          ...(host ? { 'x-forwarded-host': host, 'x-forwarded-proto': proto } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      await r.body?.cancel().catch(() => undefined);
    } catch {
      cookies = [];
    }
  }
  const setCookie = cookies.length ? cookies : FALLBACK_EXPIRE;
  const body = JSON.stringify({ ok: true, location: logoutDestination(req) });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': setCookie });
  res.end(body);
}
