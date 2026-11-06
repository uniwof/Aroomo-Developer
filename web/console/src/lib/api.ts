/**
 * 控制台只调用 Core（同源）：POST /auth/login（cookie:true）→ HttpOnly 会话 Cookie；只认 Cookie，响应里出现令牌当出错处理（#264 必改 2）。
 * 令牌只放 sessionStorage（关掉标签页即失效）；Core 支持 HttpOnly Cookie 后改用 Cookie（已登记在 PROGRESS「控制台需要的 API」）。
 * 改动类请求一律带 X-Aroomo-Request: 1（与 Shell 的同源校验一致）。
 */
const TOKEN_KEY = 'aroomo.console.session';
/**
 * Cookie 会话的占位标记（#250 spike）：登录时请 Core 把会话放进 HttpOnly Cookie（https 上 __Host-aroomo_session），
 * 页面脚本拿不到真令牌，sessionStorage 里只记「已用 Cookie 登录」。这时请求不带 Authorization，靠 Cookie + X-Aroomo-Request。
 */
export const COOKIE_SESSION = 'cookie-session';

export interface User {
  id: string;
  email: string;
  displayName?: string;
  role: string;
  status?: string;
}

/**
 * 从 Shell（/console，已登录 LobeHub）打开时，页面带 aroomo-shell 标记：API 走同源 /aroomo/api（Shell 附加令牌），不再单独登录。
 * 直接从 Core 打开时仍用 Core 的会话令牌。
 */
export const viaShell = typeof document !== 'undefined' && document.querySelector('meta[name="aroomo-shell"]') !== null;

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path : `/api/${path}`;
  return viaShell && p.startsWith('/api/') ? '/aroomo' + p : p;
}

export interface Challenge {
  id: string;
  level: 'important';
  kind: 'irreversible' | 'payment' | 'credential';
  title: string;
  consequences: string[];
  confirmLabel: string;
  nextStep: 0 | 1 | 2;
  minDelayMs: number;
  step2NotBefore: string | null;
  requiresAccessReauth: boolean;
  expiresAt: string;
  stepUrl: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** 428 CONFIRM_REQUIRED 时带上的确认挑战（见 docs/architecture/CONFIRM-CARD.md） */
    readonly confirm?: Challenge,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

export const session = {
  get token(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token: string | null) {
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* 隐私模式下不可用：本次会话内存里也没有，等于未登录 */
    }
    for (const l of listeners) l();
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; confirm?: Challenge; retryAfterMs?: number } } | undefined)?.error;
    // 重新验证身份的 401 不是会话失效，别把人踢出登录
    if (res.status === 401 && err?.code !== 'ACCESS_REAUTH_REQUIRED') session.set(null);
    throw new ApiError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? '请求失败，请稍后再试', err?.confirm, err?.retryAfterMs);
  }
  return body as T;
}

/** extraHeaders：调用方要加的头（如 Idempotency-Key）；不能覆盖鉴权、CSRF 和内容类型 */
export async function api<T>(method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  for (const [k, v] of Object.entries(extraHeaders)) if (!/^(authorization|cookie|accept|content-type|x-aroomo-request)$/i.test(k)) headers[k.toLowerCase()] = v;
  const token = session.token;
  if (token && token !== COOKIE_SESSION) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET' && method !== 'HEAD') headers['x-aroomo-request'] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetchImpl(apiUrl(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  return parse<T>(res);
}

const USER_KEY = 'aroomo.console.user';

/** 登录时记下的名字和邮箱；没有就返回 null */
export function currentUser(): { id: string; email: string; displayName: string; role: string } | null {
  try {
    const j = JSON.parse(sessionStorage.getItem(USER_KEY) ?? 'null') as { id?: unknown; email?: unknown; displayName?: unknown; role?: unknown } | null;
    return j && typeof j.email === 'string'
      ? { id: typeof j.id === 'string' ? j.id : '', email: j.email, displayName: typeof j.displayName === 'string' ? j.displayName : '', role: typeof j.role === 'string' ? j.role : '' }
      : null;
  } catch {
    return null;
  }
}

/**
 * 当前账号 id，以 Core 为准（GET /api/auth/me）。账号登录（kind=user）返回账号 id；
 * 从 Shell 打开时 /aroomo/api 带的是主人令牌（kind=owner，Shell 只把它给所有者），返回 'owner'；问不到或别的返回 null。
 * 用在：本机会话导入 Core 前确认「这份本机会话是谁的」（#287），页面里记的那份可能过期，不能当证据。
 */
export async function fetchAccountId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  return (await fetchAccount(fetchImpl))?.id ?? null;
}

/**
 * 同 fetchAccountId，另带「是不是所有者」（#290 认领旧会话只给所有者）：主人令牌（kind=owner）或 Core 角色 admin 的账号是；
 * 家人（role=user）不是。以 Core 为准，不认标签页里记的角色。
 * shortcut: admin 账号都算所有者（1.5 只有所有者一个 admin）；以后有第二个 admin 时改成看 Core 的所有者映射。
 */
export async function fetchAccount(fetchImpl: typeof fetch = fetch): Promise<{ id: string; owner: boolean } | null> {
  try {
    const r = await api<{ kind?: unknown; user?: { id?: unknown; role?: unknown } }>('GET', '/api/auth/me', undefined, fetchImpl);
    if (r.kind === 'user' && typeof r.user?.id === 'string' && r.user.id) return { id: r.user.id, owner: r.user.role === 'admin' };
    return r.kind === 'owner' ? { id: 'owner', owner: true } : null;
  } catch {
    return null;
  }
}

/** 家人账号（Core 角色 user）：只看对话、成员、收件箱和自己的偏好/安全；资源库、工具、API、负责人、外部接入只给所有者/管理员（落地文档 0.5） */
export function isFamily(): boolean {
  return currentUser()?.role === 'user';
}

export async function login(email: string, password: string, fetchImpl: typeof fetch = fetch): Promise<User> {
  // cookie:true：Core 把会话放进 HttpOnly Cookie，不在响应里给令牌（原生对话 /api/chat/stream 只认 Cookie）
  const r = await api<{ token?: unknown; user: User }>('POST', '/auth/login', { email, password, cookie: true }, fetchImpl);
  // 只认 Cookie：响应里带了令牌说明 Core 没按 cookie:true 走（旧版或配置错），不收下、不放进页面能读到的地方
  if (r.token !== undefined) {
    session.set(null);
    throw new ApiError(502, 'LOGIN_TOKEN_IN_BODY', '登录没有成功：后台版本不对，请联系管理员');
  }
  session.set(COOKIE_SESSION);
  try {
    // 只记账号 id（本机会话按账号分开存，#287）、显示用的名字和邮箱（侧栏底部的账号行），不记令牌
    sessionStorage.setItem(USER_KEY, JSON.stringify({ id: r.user.id, email: r.user.email, displayName: r.user.displayName ?? '', role: r.user.role }));
  } catch {
    /* 忽略 */
  }
  return r.user;
}

/**
 * 从 Shell 打开时退出：POST /aroomo/logout（Shell 作废 Core 会话、清 Cookie，返回下一步地址），再整页跳过去。
 * 只跳同站相对地址（/ 开头、不是 //），防止被带去别的网站；没拿到地址就回 /aroomo/login。失败时抛出给人看的话，不跳。
 */
/**
 * 只认同站路径：/ 开头，第二个字符不是 / 或 \（浏览器把 /\evil.com 当成 //evil.com），解析后同源，且不含控制字符。
 * 返回规范化后的路径；不合格返回 null。
 */
export function sameSitePath(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\/(?![/\\])/.test(v) || /[\u0000-\u001f\\]/.test(v)) return null;
  try {
    const u = new URL(v, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : null;
  } catch {
    return null;
  }
}

export async function shellLogout(fetchImpl: typeof fetch = fetch, go: (url: string) => void = (u) => window.location.assign(u)): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl('/aroomo/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-aroomo-request': '1', accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'NETWORK', '退出失败，请检查网络后再试');
  }
  if (!res.ok) throw new ApiError(res.status, 'HTTP_' + res.status, '退出失败，请稍后再试');
  const j = (await res.json().catch(() => null)) as { location?: unknown } | null;
  const loc = sameSitePath(j?.location) ?? '/aroomo/login';
  session.set(null);
  try {
    sessionStorage.removeItem(USER_KEY);
  } catch {
    /* 忽略 */
  }
  go(loc);
}

export async function logout(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (viaShell) return shellLogout(fetchImpl);
  try {
    await api('POST', '/api/auth/logout', undefined, fetchImpl);
  } finally {
    session.set(null);
  }
}

export interface Member {
  id: string;
  name: string;
  aliases: string[];
  capabilityTags: string[];
  enabled: boolean;
  pinned: boolean;
  status: string;
  leadEligible: boolean;
  /** 后台线补上后才有（PROGRESS「控制台需要的 API」）；没有时按 enabled 显示 */
  online?: boolean;
  /** 此刻状态（Poke §5，Core 只从真实信号推出）：没有这个字段 = 老 Core，照旧按 online 显示 */
  activity?: MemberActivity;
  /** Poke §4（老 Core 没有这几个字段） */
  role?: string | null;
  systemPrompt?: string | null;
  avatar?: string | null;
}

export interface MemberActivity {
  state: 'working' | 'cooldown' | 'depleted' | 'ready' | 'unknown';
  reason?: string;
  since?: string;
}

const ACTIVITY_LABEL: Record<MemberActivity['state'], string> = { working: '工作中', cooldown: '冷却', depleted: '耗尽', ready: '就绪', unknown: '状态未知' };

/** 状态的字（只说状态，不给数字）；未知时带上原因（已停用、候选、没有 Key…），不冒充「就绪」 */
export function activityLabel(a: MemberActivity): string {
  return a.state === 'unknown' && a.reason ? `状态未知：${a.reason}` : ACTIVITY_LABEL[a.state];
}
