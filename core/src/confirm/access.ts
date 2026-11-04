/**
 * Cloudflare Access 重新验证（DECISIONS D63：涉及凭据的重要确认要重新验证一次 Cloudflare Access）。
 *
 * Cloudflare Access 在每个经过它的请求上加 `Cf-Access-Jwt-Assertion` 头（RS256 JWT）。
 * 用户重新登录 Access 后会拿到一个新的令牌，其 `iat`（签发时间）就是重新验证的时间。
 * 我们校验：签名（团队公钥 https://<team>/cdn-cgi/access/certs）、aud、iss、exp/nbf，
 * 然后把 iat 交给确认服务判断「够不够新」。
 * 依据：https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
import { createPublicKey, type JsonWebKey, verify as cryptoVerify } from 'node:crypto';

export interface AccessAssertion {
  /** 签发时间（秒） */
  iat: number;
  email?: string;
}

export interface AccessVerifier {
  /** 校验通过返回断言内容；任何不合法（签名、aud、过期…）返回 null。 */
  verify(jwt: string): Promise<AccessAssertion | null>;
}

export interface CfAccessOptions {
  /** 例如 myteam.cloudflareaccess.com */
  teamDomain: string;
  /** Access 应用的 AUD 标签 */
  aud: string;
  now?: () => Date;
  /** 测试注入；默认 fetch https://<team>/cdn-cgi/access/certs */
  fetchCerts?: () => Promise<{ keys: Array<JsonWebKey & { kid?: string }> }>;
  /** 公钥缓存时间，默认 10 分钟 */
  cacheMs?: number;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class CfAccessVerifier implements AccessVerifier {
  readonly #opts: Required<Omit<CfAccessOptions, 'fetchCerts'>> & Pick<CfAccessOptions, 'fetchCerts'>;
  #keys: Map<string, ReturnType<typeof createPublicKey>> = new Map();
  #fetchedAt = 0;

  constructor(opts: CfAccessOptions) {
    this.#opts = { now: () => new Date(), cacheMs: 10 * 60 * 1000, ...opts };
  }

  async #loadKeys(force: boolean): Promise<void> {
    const now = this.#opts.now().getTime();
    if (!force && this.#keys.size > 0 && now - this.#fetchedAt < this.#opts.cacheMs) return;
    const fetchCerts =
      this.#opts.fetchCerts ??
      (async () => {
        const r = await fetch(`https://${this.#opts.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) throw new Error(`certs ${r.status}`);
        return (await r.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
      });
    const body = await fetchCerts();
    const next = new Map<string, ReturnType<typeof createPublicKey>>();
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== 'RSA') continue;
      next.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    }
    this.#keys = next;
    this.#fetchedAt = now;
  }

  async verify(jwt: string): Promise<AccessAssertion | null> {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts as [string, string, string];
    const header = b64urlJson(h);
    const payload = b64urlJson(p);
    if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    try {
      await this.#loadKeys(false);
      if (!this.#keys.has(header.kid)) await this.#loadKeys(true);
    } catch {
      return null;
    }
    const key = this.#keys.get(header.kid);
    if (!key) return null;
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) return null;

    const nowS = Math.floor(this.#opts.now().getTime() / 1000);
    const aud = payload.aud;
    const audOk = typeof aud === 'string' ? aud === this.#opts.aud : Array.isArray(aud) && aud.includes(this.#opts.aud);
    if (!audOk) return null;
    if (payload.iss !== `https://${this.#opts.teamDomain}`) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= nowS) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > nowS + 30) return null;
    if (typeof payload.iat !== 'number') return null;
    return { iat: payload.iat, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) };
  }
}
