/**
 * 登录校验：Aroomo 页面和 /aroomo/api 只对已登录 LobeHub 的用户开放。
 * 做法：把浏览器的 Cookie 原样带给 LobeHub 的 Better Auth `GET /api/auth/get-session`，
 * 有 user 就算登录（单用户，登录邮箱由 LobeHub 的 AUTH_ALLOWED_EMAILS 限定）。结果按 Cookie 摘要短暂缓存。
 */
import { createHash } from 'node:crypto';

/** 会话缓存最多条数；满了只淘汰最旧的一条（乱发 Cookie 冲不掉别人的缓存，#259 可选项） */
export const SESSION_CACHE_MAX = 200;

/** 写入缓存：先删再插（Map 按插入顺序，最旧的在最前），满了从最前淘汰 */
export function cachePut<V>(cache: Map<string, V>, key: string, value: V, max = SESSION_CACHE_MAX): void {
  cache.delete(key);
  while (cache.size >= max) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
}

export interface SessionChecker {
  check(cookie: string | undefined): Promise<boolean>;
  /** 当前会话的登录邮箱（小写）；没登录或取不到返回 undefined */
  email?(cookie: string | undefined): Promise<string | undefined>;
  /** 当前会话的 LobeHub 用户 id；没登录或取不到返回 undefined（#245：所有者按 id 比对） */
  userId?(cookie: string | undefined): Promise<string | undefined>;
  /** core-session：当前账号的角色（admin / user）；没登录返回 undefined */
  role?(cookie: string | undefined): Promise<string | undefined>;
  /** 退出后立刻丢掉这个 Cookie 的缓存 */
  forget?(cookie: string | undefined): void;
}

export class LobeSessionChecker implements SessionChecker {
  readonly #cache = new Map<string, { ok: boolean; email?: string; userId?: string; until: number }>();

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

  async userId(cookie: string | undefined): Promise<string | undefined> {
    return (await this.#lookup(cookie)).userId;
  }

  async #lookup(cookie: string | undefined): Promise<{ ok: boolean; email?: string; userId?: string }> {
    if (!cookie) return { ok: false };
    const key = createHash('sha256').update(cookie).digest('hex');
    const hit = this.#cache.get(key);
    const t = this.now();
    if (hit && hit.until > t) return hit;
    let ok = false;
    let email: string | undefined;
    let userId: string | undefined;
    try {
      const res = await this.fetchImpl(new URL('/api/auth/get-session', this.lobe), {
        headers: { cookie, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { user?: { id?: string; email?: string } } | null;
        userId = typeof body?.user?.id === 'string' && body.user.id ? body.user.id : undefined;
        ok = Boolean(userId);
        email = ok ? body?.user?.email?.trim().toLowerCase() || undefined : undefined;
      }
    } catch {
      ok = false;
    }
    // 失败结果只缓存很短时间，登录后马上能用
    const entry = { ok, email, userId, until: t + (ok ? this.cacheMs : 2000) };
    cachePut(this.#cache, key, entry);
    return entry;
  }
}

export const allowAll: SessionChecker = { check: async () => true };

/** Core 的控制台会话 Cookie 名（core/src/auth/session-cookie.ts）：https 用 __Host- 前缀；http 和过渡期读取用旧名 */
export const CORE_SESSION_COOKIE = '__Host-aroomo_session';
export const CORE_LEGACY_SESSION_COOKIE = 'aroomo_session';
export const CORE_SESSION_COOKIES = [CORE_SESSION_COOKIE, CORE_LEGACY_SESSION_COOKIE] as const;

/** 从浏览器 Cookie 头里只取 Core 会话 Cookie（先认 __Host- 名，没有再认旧名；与 Core 的读取顺序一致），其他 Cookie 一律不往 Core 发 */
export function coreSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const found = new Map<string, string>();
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if ((CORE_SESSION_COOKIES as readonly string[]).includes(name) && !found.has(name)) found.set(name, part.slice(i + 1).trim());
  }
  const name = found.has(CORE_SESSION_COOKIE) ? CORE_SESSION_COOKIE : CORE_LEGACY_SESSION_COOKIE;
  const v = found.get(name);
  return v !== undefined && /^[A-Za-z0-9_-]{8,200}$/.test(v) ? `${name}=${v}` : undefined;
}

interface CoreEntry {
  ok: boolean;
  email?: string;
  userId?: string;
  role?: string;
  until: number;
}

/**
 * core-session：把 aroomo_session 带给 Core `GET /api/auth/me`（Core 对 Cookie 会话只认账号，停用的账号返回 401）。
 * 只有 kind=user 且 status=active 才算登录。结果按 Cookie 摘要缓存（成功 cacheMs，失败 2 秒）。
 * 失效时间（D254）：退出立刻生效（forget）；停用账号、改密码最多 cacheMs（30 秒）后生效。要立刻生效再加 Core 推送失效。
 */
export class CoreSessionChecker implements SessionChecker {
  readonly #cache = new Map<string, CoreEntry>();

  constructor(
    private readonly core: URL,
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
  async userId(cookie: string | undefined): Promise<string | undefined> {
    return (await this.#lookup(cookie)).userId;
  }
  async role(cookie: string | undefined): Promise<string | undefined> {
    return (await this.#lookup(cookie)).role;
  }
  forget(cookie: string | undefined): void {
    const c = coreSessionCookie(cookie);
    if (c) this.#cache.delete(createHash('sha256').update(c).digest('hex'));
  }

  async #lookup(cookie: string | undefined): Promise<Omit<CoreEntry, 'until'>> {
    const c = coreSessionCookie(cookie);
    if (!c) return { ok: false };
    const key = createHash('sha256').update(c).digest('hex');
    const t = this.now();
    const hit = this.#cache.get(key);
    if (hit && hit.until > t) return hit;
    let entry: Omit<CoreEntry, 'until'> = { ok: false };
    try {
      const res = await this.fetchImpl(new URL('/api/auth/me', this.core), {
        headers: { cookie: c, accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { kind?: string; user?: { id?: string; email?: string; role?: string; status?: string } } | null;
        const u = body?.kind === 'user' ? body.user : undefined;
        if (u && typeof u.id === 'string' && u.id && u.status === 'active') {
          entry = { ok: true, userId: u.id, email: u.email?.trim().toLowerCase() || undefined, role: u.role };
        }
      } else await res.body?.cancel().catch(() => undefined);
    } catch {
      entry = { ok: false };
    }
    const stored = { ...entry, until: t + (entry.ok ? this.cacheMs : 2000) };
    cachePut(this.#cache, key, stored);
    return stored;
  }
}
