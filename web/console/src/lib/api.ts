/**
 * 控制台只调用 Core（同源）：POST /auth/login 拿会话令牌，之后 /api/* 带 Bearer。
 * 令牌只放 sessionStorage（关掉标签页即失效）；Core 支持 HttpOnly Cookie 后改用 Cookie（已登记在 PROGRESS「控制台需要的 API」）。
 * 改动类请求一律带 X-Aroomo-Request: 1（与 Shell 的同源校验一致）。
 */
const TOKEN_KEY = 'aroomo.console.session';

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

export async function api<T>(method: string, path: string, body?: unknown, fetchImpl: typeof fetch = fetch): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = session.token;
  if (token) headers.authorization = `Bearer ${token}`;
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

export async function login(email: string, password: string, fetchImpl: typeof fetch = fetch): Promise<User> {
  const r = await api<{ token: string; user: User }>('POST', '/auth/login', { email, password }, fetchImpl);
  session.set(r.token);
  return r.user;
}

export async function logout(fetchImpl: typeof fetch = fetch): Promise<void> {
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
}
