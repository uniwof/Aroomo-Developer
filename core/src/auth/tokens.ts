/**
 * 令牌校验（PRODUCT §9.3：操作员令牌只存 HMAC）。
 *
 * - 主人令牌：来自环境变量 CORE_OWNER_TOKEN，用 SHA-256 后定长比较（timingSafeEqual）。
 * - 操作员令牌：存储里只有 HMAC-SHA256(CORE_TOKEN_SECRET, token)，不存明文。
 *   令牌的签发 / 吊销 API 属于「负责人体系」（PRODUCT §9.3、§11.2 第 4 条），本期只提供校验与内存存储。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type Capability, operatorMayHave } from './capabilities.js';

export type Principal =
  | { type: 'owner'; id: 'owner' }
  | { type: 'operator'; id: string; capabilities: ReadonlySet<Capability> };

export interface OperatorTokenRecord {
  id: string;
  /** hex(HMAC-SHA256(secret, token)) */
  hmac: string;
  capabilities: Capability[];
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export interface OperatorTokenStore {
  findByHmac(hmac: string): Promise<OperatorTokenRecord | null>;
}

export class MemoryOperatorTokenStore implements OperatorTokenStore {
  readonly #byHmac = new Map<string, OperatorTokenRecord>();
  add(rec: OperatorTokenRecord): void {
    this.#byHmac.set(rec.hmac, rec);
  }
  async findByHmac(hmac: string): Promise<OperatorTokenRecord | null> {
    return this.#byHmac.get(hmac) ?? null;
  }
}

export function hmacToken(secret: string, token: string): string {
  return createHmac('sha256', secret).update(token, 'utf8').digest('hex');
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

export interface TokenVerifierOptions {
  ownerToken: string | undefined;
  tokenSecret: string | undefined;
  operatorTokens: OperatorTokenStore;
  now: () => Date;
}

export function createTokenVerifier(opts: TokenVerifierOptions) {
  const ownerDigest = opts.ownerToken ? sha256(opts.ownerToken) : null;
  return async function verify(token: string): Promise<Principal | null> {
    if (!token) return null;
    if (ownerDigest && timingSafeEqual(sha256(token), ownerDigest)) return { type: 'owner', id: 'owner' };
    if (!opts.tokenSecret) return null;
    const rec = await opts.operatorTokens.findByHmac(hmacToken(opts.tokenSecret, token));
    if (!rec) return null;
    const now = opts.now().getTime();
    if (rec.revokedAt && rec.revokedAt.getTime() <= now) return null;
    if (rec.expiresAt && rec.expiresAt.getTime() <= now) return null;
    // 白名单与令牌授权取交集，再去掉禁止项（D62）：令牌里写了白名单外 / 禁止的能力也不生效
    const caps = new Set(rec.capabilities.filter((c) => operatorMayHave(c)));
    return { type: 'operator', id: rec.id, capabilities: caps };
  };
}

export function principalCan(p: Principal, cap: Capability): boolean {
  if (p.type === 'owner') return true;
  return operatorMayHave(cap) && p.capabilities.has(cap);
}

/** 审计 / 确认令牌里用来标识操作者的字符串 */
export function actorKey(p: Principal): string {
  return p.type === 'owner' ? 'owner' : `operator:${p.id}`;
}
