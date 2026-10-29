import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { CLIENT_SCOPES, type ClientPrincipal, type ClientScope, type ClientTokenRecord, type ClientTokenStore, type PublicClient } from './types.js';

export const CLIENT_PREFIX = 'arc_';
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const MAX_CLIENTS_PER_USER = 50;

export const publicClient = (r: ClientTokenRecord): PublicClient => ({
  id: r.id,
  name: r.name,
  scopes: r.scopes,
  rateLimitPerMin: r.rateLimitPerMin,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
  revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
});

export class ClientTokenService {
  /** 每令牌每分钟计数（进程内；多实例部署时换共享计数，目前只有一个 Core） */
  readonly #hits = new Map<string, { minute: number; n: number }>();

  constructor(
    private readonly store: ClientTokenStore,
    private readonly now: () => Date,
  ) {}

  async create(
    userId: string,
    input: { name: string; scopes: string[]; expiresInDays?: number; rateLimitPerMin?: number },
    audit: AuditFn,
  ): Promise<{ token: string; client: PublicClient }> {
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 64) throw badRequest('客户端名字需要 1–64 个字');
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0) throw badRequest('至少选一个权限范围', 'NO_SCOPES');
    const bad = scopes.find((s) => !(CLIENT_SCOPES as readonly string[]).includes(s));
    if (bad) throw badRequest(`不认识的权限范围：${bad}`, 'UNKNOWN_SCOPE');
    if ((await this.store.listByUser(userId)).filter((r) => !r.revokedAt).length >= MAX_CLIENTS_PER_USER) {
      throw new HttpError(409, 'TOO_MANY_CLIENTS', '客户端令牌太多了，先吊销不用的');
    }
    const token = CLIENT_PREFIX + randomBytes(32).toString('base64url');
    const at = this.now();
    const rec: ClientTokenRecord = {
      id: randomUUID(),
      userId,
      name,
      tokenHash: sha256(token),
      scopes: scopes as ClientScope[],
      rateLimitPerMin: input.rateLimitPerMin ?? 60,
      createdAt: at,
      expiresAt: input.expiresInDays ? new Date(at.getTime() + input.expiresInDays * 24 * 3600_000) : null,
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.store.insert(rec);
    await audit('clients.create', { type: 'client', id: rec.id }, 'ok', `${name} [${scopes.join(',')}]`);
    return { token, client: publicClient(rec) };
  }

  async list(userId: string): Promise<PublicClient[]> {
    return (await this.store.listByUser(userId)).map(publicClient);
  }

  async revoke(userId: string, id: string, audit: AuditFn): Promise<void> {
    if (!(await this.store.revoke(userId, id, this.now()))) throw notFound('找不到这个客户端');
    await audit('clients.revoke', { type: 'client', id }, 'ok');
  }

  async revokeAll(userId: string, audit: AuditFn): Promise<number> {
    const n = await this.store.revokeAll(userId, this.now());
    await audit('clients.revoke-all', { type: 'user', id: userId }, 'ok', `n=${n}`);
    return n;
  }

  /** 校验令牌 → 客户端身份。吊销 / 过期立即失效（每次都查库，不缓存）。超速抛 429。 */
  async verify(token: string): Promise<ClientPrincipal | null> {
    if (!token.startsWith(CLIENT_PREFIX)) return null;
    const r = await this.store.getByHash(sha256(token));
    if (!r) return null;
    const t = this.now();
    if (r.revokedAt || (r.expiresAt && r.expiresAt.getTime() <= t.getTime())) return null;
    const minute = Math.floor(t.getTime() / 60_000);
    const h = this.#hits.get(r.id);
    if (h && h.minute === minute) {
      h.n += 1;
      if (h.n > r.rateLimitPerMin) throw new HttpError(429, 'RATE_LIMITED', '请求太频繁，请稍后再试');
    } else {
      this.#hits.set(r.id, { minute, n: 1 });
    }
    await this.store.touch(r.id, t);
    return { type: 'client', id: r.id, clientId: r.id, userId: r.userId, name: r.name, scopes: new Set(r.scopes) };
  }
}
