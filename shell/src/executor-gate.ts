/**
 * 执行员公网通路（#365 负责人裁定方向 1a）：Shell 白名单直通 /api/executor/* → Core。
 * 两道闸：边缘 Cloudflare Access（Service Token，按路径单独的应用）+ Core 设备令牌；Shell 自己再验一遍 Access JWT（失败即关闭）。
 *  - 路径：原始路径必须以 /api/executor/ 开头；含点段、%2e/%2f/%5c、\、//、控制字符的一律拒绝，不做「规整后放行」。
 *  - 鉴权前按 IP 限速；请求体上限 1 MiB（同 Core 默认）；上游超时。
 *  - 转发头精确白名单：只放 Authorization 和内容类头，来源 IP 由 Shell 自己填；Cookie、CF 两个头、JWT、客户端的 X-Forwarded-* 全部去掉；响应去 Set-Cookie。
 *  - 不记任何凭据的值（这里没有日志；错误消息里也不带）。
 */
import { createPublicKey, verify as verifySig, type KeyObject } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const EXECUTOR_PREFIX = '/api/executor/';
/** 和 Core（Fastify 默认 bodyLimit）一致 */
export const EXECUTOR_BODY_MAX = 1024 * 1024;
/** 长轮询最长 30 秒（claim / takeover waitSec ≤ 30），留足余量 */
export const EXECUTOR_UPSTREAM_TIMEOUT_MS = 60_000;
/** 读请求体阶段的空闲上限（防慢速攻击）；读完后放宽到上游超时之外，否则 30 秒长轮询会被自己掐断 → 隧道 502 */
export const EXECUTOR_BODY_IDLE_MS = 30_000;
export const EXECUTOR_WAIT_IDLE_MS = EXECUTOR_UPSTREAM_TIMEOUT_MS + 5_000;

/** 转给 Core 的客户端请求头（精确白名单）；host、x-forwarded-for、x-real-ip 由 Shell 自己填 */
export const EXECUTOR_FORWARD_HEADERS = ['authorization', 'content-type', 'content-length', 'accept'] as const;

/**
 * 这个请求是否「看起来想去执行员接口」：是就交给闸门（要么严格放行，要么拒绝），不落到 LobeHub。
 * 按路径段判断（#376 M1）：某个 `api` 段后面紧跟的一段恰好是 `executor`（原始、解码后、规整后任一形式，不分大小写）。
 * `/api/executors`、`/api/executor-allowlist`、`/aroomo/api/executors` 这些人用的接口不算，照原分支走。
 */
export function isExecutorCandidate(rawUrl: string, normalizedPath: string): boolean {
  const raw = (rawUrl.split('?')[0] ?? '').toLowerCase();
  let dec = raw;
  try {
    dec = decodeURIComponent(raw);
  } catch {
    /* 解码失败也按原样判断 */
  }
  return [raw, dec, normalizedPath.toLowerCase()].some((s) => {
    const seg = s.split(/[\\/]+/);
    return seg.some((x, i) => x === 'api' && seg[i + 1] === 'executor');
  });
}

/** 严格检查原始请求目标：不规整、不解码，看到可疑写法就拒绝 */
export function executorPathOk(rawUrl: string): boolean {
  // 控制字符（含编码形式）与非 ASCII：整条 URL 都不许
  for (let i = 0; i < rawUrl.length; i++) {
    const c = rawUrl.charCodeAt(i);
    if (c < 0x20 || c >= 0x7f) return false;
  }
  if (/%(?:[01][0-9a-f]|7f)/i.test(rawUrl)) return false;
  const q = rawUrl.indexOf('?');
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  if (!path.startsWith(EXECUTOR_PREFIX)) return false;
  if (path.includes('\\') || path.includes('//') || /%(?:2e|2f|5c)/i.test(path)) return false;
  if (path.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  return true;
}

/** 按 IP 的固定窗口限速（鉴权前）；超出返回 false */
export class IpRateLimiter {
  readonly #hits = new Map<string, { n: number; reset: number }>();
  constructor(
    readonly perMin: number,
    readonly now: () => number = Date.now,
  ) {}

  take(ip: string): boolean {
    const t = this.now();
    if (this.#hits.size > 10_000) for (const [k, v] of this.#hits) if (v.reset <= t) this.#hits.delete(k);
    const e = this.#hits.get(ip);
    if (!e || e.reset <= t) {
      this.#hits.set(ip, { n: 1, reset: t + 60_000 });
      return true;
    }
    e.n += 1;
    return e.n <= this.perMin;
  }
}

export interface AccessJwtConfig {
  /** Access 团队域名，如 aroomo.cloudflareaccess.com；iss = https://<它>，公钥 = https://<它>/cdn-cgi/access/certs */
  teamDomain: string;
  /** 这条路径的 Access 应用的 AUD 标签 */
  aud: string;
  /** 预期的 Service Token Client ID（JWT 里的 common_name） */
  clientId: string;
}

export type JwksFetcher = (url: string) => Promise<unknown>;

const defaultFetchJwks: JwksFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!r.ok) throw new Error(`JWKS HTTP ${r.status}`);
  return r.json();
};

const b64json = (s: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * 校验 Cf-Access-Jwt-Assertion：RS256 签名（团队 JWKS）、iss、aud、exp（nbf/iat 如有也查）、common_name。
 * 任何一步不对返回 false（失败即关闭）；公钥缓存 10 分钟，遇到不认识的 kid 最多每 30 秒刷新一次。
 */
export class AccessJwtVerifier {
  readonly #iss: string;
  readonly #certsUrl: string;
  #keys = new Map<string, KeyObject>();
  #fetchedAt = 0;
  #inflight: Promise<void> | undefined;

  constructor(
    readonly cfg: AccessJwtConfig,
    readonly fetchJwks: JwksFetcher = defaultFetchJwks,
    readonly now: () => number = Date.now,
  ) {
    this.#iss = `https://${cfg.teamDomain}`;
    this.#certsUrl = `${this.#iss}/cdn-cgi/access/certs`;
  }

  async #refresh(): Promise<void> {
    this.#inflight ??= (async () => {
      try {
        const j = (await this.fetchJwks(this.#certsUrl)) as { keys?: unknown };
        const next = new Map<string, KeyObject>();
        for (const k of Array.isArray(j?.keys) ? (j.keys as Record<string, unknown>[]) : []) {
          if (k?.kty !== 'RSA' || typeof k.kid !== 'string') continue;
          try {
            next.set(k.kid, createPublicKey({ key: k as import('node:crypto').JsonWebKey, format: 'jwk' }));
          } catch {
            /* 坏的公钥跳过 */
          }
        }
        this.#keys = next;
      } catch {
        /* 取不到公钥：保留旧的；没有就全部拒绝 */
      } finally {
        this.#fetchedAt = this.now();
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }

  async #key(kid: string): Promise<KeyObject | undefined> {
    const age = this.now() - this.#fetchedAt;
    if (age > 10 * 60_000 || (!this.#keys.has(kid) && age > 30_000)) await this.#refresh();
    return this.#keys.get(kid);
  }

  async verify(token: string | string[] | undefined): Promise<boolean> {
    if (typeof token !== 'string' || token.length > 8192) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const header = b64json(h);
    const claims = b64json(p);
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string') return false;
    const key = await this.#key(header.kid);
    if (!key) return false;
    let sigOk: boolean;
    try {
      sigOk = verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return false;
    const nowSec = Math.floor(this.now() / 1000);
    const skew = 30;
    if (claims.iss !== this.#iss) return false;
    const aud = claims.aud;
    if (!(aud === this.cfg.aud || (Array.isArray(aud) && aud.includes(this.cfg.aud)))) return false;
    if (typeof claims.exp !== 'number' || claims.exp <= nowSec) return false;
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowSec + skew)) return false;
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat > nowSec + skew)) return false;
    if (claims.common_name !== this.cfg.clientId) return false;
    return true;
  }
}

/** 转给 Core 的请求头：只取白名单里的，再由 Shell 填 host 与来源 IP */
export function executorForwardHeaders(req: IncomingMessage, host: string, ip: string): Record<string, string> {
  const h: Record<string, string> = { host, 'x-forwarded-for': ip, 'x-real-ip': ip };
  for (const k of EXECUTOR_FORWARD_HEADERS) {
    const v = req.headers[k];
    if (typeof v === 'string') h[k] = v;
  }
  return h;
}
