/**
 * 登录校验：Aroomo 页面和 /aroomo/api 只对已登录 LobeHub 的用户开放。
 * 做法：把浏览器的 Cookie 原样带给 LobeHub 的 Better Auth `GET /api/auth/get-session`，
 * 有 user 就算登录（单用户，登录邮箱由 LobeHub 的 AUTH_ALLOWED_EMAILS 限定）。结果按 Cookie 摘要短暂缓存。
 */
import { createHash } from 'node:crypto';

export interface SessionChecker {
  check(cookie: string | undefined): Promise<boolean>;
  /** 当前会话的登录邮箱（小写）；没登录或取不到返回 undefined */
  email?(cookie: string | undefined): Promise<string | undefined>;
}

export class LobeSessionChecker implements SessionChecker {
  readonly #cache = new Map<string, { ok: boolean; email?: string; until: number }>();

  constructor(
    private readonly lobe: URL,
    private readonly cacheMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async check(cookie: string | undefined): Promise<boolean> {
    return (await this.#lookup(cookie)).ok;
  }

  async email(cookie: string | undefined): Promise<string | undefined> {
    return (await this.#lookup(cookie)).email;
  }

  async #lookup(cookie: string | undefined): Promise<{ ok: boolean; email?: string }> {
    if (!cookie) return { ok: false };
    const key = createHash('sha256').update(cookie).digest('hex');
    const hit = this.#cache.get(key);
    const t = this.now();
    if (hit && hit.until > t) return hit;
    let ok = false;
    let email: string | undefined;
    try {
      const res = await this.fetchImpl(new URL('/api/auth/get-session', this.lobe), {
        headers: { cookie, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { user?: { id?: string; email?: string } } | null;
        ok = Boolean(body?.user?.id);
        email = body?.user?.email?.trim().toLowerCase() || undefined;
      }
    } catch {
      ok = false;
    }
    if (this.#cache.size > 200) this.#cache.clear();
    // 失败结果只缓存很短时间，登录后马上能用
    const entry = { ok, email, until: t + (ok ? this.cacheMs : 2000) };
    this.#cache.set(key, entry);
    return entry;
  }
}

export const allowAll: SessionChecker = { check: async () => true };
