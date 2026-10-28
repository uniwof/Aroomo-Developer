/**
 * 统一确认服务（DECISIONS D63，取代 D50 时期的 `confirm: true` 参数和收件箱一次性令牌）。
 *
 * 两级：
 * - 普通确认（kind = normal）：用户在确认卡上点一下即可。服务端不另设令牌，记一条审计。
 * - 重要确认（kind = irreversible | payment | credential）：
 *   1. 第一次调用原接口（不带 confirmToken）→ 不执行，返回 428 CONFIRM_REQUIRED + challenge（含后果文字）；
 *   2. POST /api/confirm/:id/steps {step:1}（第一次点击）；
 *   3. 至少 3 秒后 POST /api/confirm/:id/steps {step:2}（第二次点击）——不满 3 秒服务端直接拒绝（425）；
 *      credential 还必须带一个新的 Cloudflare Access 令牌（iat 不早于 challenge 创建、且不超过配置的时限）；
 *      → 返回一次性 confirmToken；
 *   4. 带 confirmToken 重新调用原接口 → 执行。令牌绑定 scope + 操作者 + 请求体加盐摘要，用过即作废，默认 5 分钟过期。
 * - 重要确认只能由主人本人完成（操作员没有 confirm:important，D62）。
 * - 令牌只存 SHA-256；请求体只存加盐 SHA-256（可能含 Key，不存原文）。
 * 前端组件约定见 docs/architecture/CONFIRM-CARD.md。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import { conflict, HttpError, notFound } from '../http/errors.js';
import type { AccessVerifier } from './access.js';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
/** D63：第二次点击至少在第一次之后 3 秒。固定值，不可配置得更短。 */
export const IMPORTANT_MIN_DELAY_MS = 3000;
/** Cloudflare Access 令牌与服务器之间允许的时钟偏差 */
const CLOCK_SKEW_MS = 30_000;

export const CONFIRM_KINDS = ['normal', 'irreversible', 'payment', 'credential'] as const;
export type ConfirmKind = (typeof CONFIRM_KINDS)[number];
export type ImportantKind = Exclude<ConfirmKind, 'normal'>;
export type ConfirmLevel = 'normal' | 'important';

export const levelOf = (kind: ConfirmKind): ConfirmLevel => (kind === 'normal' ? 'normal' : 'important');

export interface ConfirmSpec {
  /** 操作范围，例如 members:purge:<id>、inbox:<id>:<actionId> */
  scope: string;
  kind: ConfirmKind;
  /** 卡片标题：要做什么 */
  title: string;
  /** 后果（重要确认必填，每条一句） */
  consequences?: string[];
  /** 第二次点击按钮上的字，默认「确认」 */
  confirmLabel?: string;
  /** 绑定到令牌的请求内容（例如新增 Key 的请求体）；只存加盐摘要 */
  payload?: unknown;
}

export interface ConfirmCtx {
  /** 操作者，例如 owner / operator:<id> */
  actor: string;
  confirmToken?: string;
  canConfirmImportant: boolean;
}

export interface ChallengeRow {
  id: string;
  scope: string;
  actor: string;
  kind: ImportantKind;
  title: string;
  consequences: string[];
  confirmLabel: string;
  payloadSalt: string | null;
  payloadDigest: string | null;
  requiresReauth: boolean;
  createdAt: Date;
  expiresAt: Date;
  step1At: Date | null;
  tokenHash: string | null;
  tokenIssuedAt: Date | null;
  usedAt: Date | null;
}

export interface ChallengeStore {
  insert(row: ChallengeRow): Promise<void>;
  get(id: string): Promise<ChallengeRow | null>;
  findByTokenHash(hash: string): Promise<ChallengeRow | null>;
  /** 原子：只有 step1_at 为空时写入，返回是否写入 */
  markStep1(id: string, at: Date): Promise<boolean>;
  /** 原子：只有已完成第一步、尚未签发令牌时写入 */
  issueToken(id: string, tokenHash: string, at: Date): Promise<boolean>;
  /** 原子：只有未用过、未过期时写入 used_at；并发只有一个成功 */
  consume(id: string, at: Date): Promise<boolean>;
}

export class MemoryChallengeStore implements ChallengeStore {
  readonly #rows = new Map<string, ChallengeRow>();
  async insert(row: ChallengeRow): Promise<void> {
    this.#rows.set(row.id, structuredClone(row));
  }
  async get(id: string): Promise<ChallengeRow | null> {
    const r = this.#rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async findByTokenHash(hash: string): Promise<ChallengeRow | null> {
    for (const r of this.#rows.values()) if (r.tokenHash === hash) return structuredClone(r);
    return null;
  }
  async markStep1(id: string, at: Date): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || r.step1At) return false;
    r.step1At = new Date(at);
    return true;
  }
  async issueToken(id: string, tokenHash: string, at: Date): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || !r.step1At || r.tokenHash) return false;
    r.tokenHash = tokenHash;
    r.tokenIssuedAt = new Date(at);
    return true;
  }
  async consume(id: string, at: Date): Promise<boolean> {
    const r = this.#rows.get(id);
    if (!r || r.usedAt || r.expiresAt.getTime() <= at.getTime()) return false;
    r.usedAt = new Date(at);
    return true;
  }
}

interface PgRow {
  id: string;
  scope: string;
  actor: string;
  kind: ImportantKind;
  title: string;
  consequences: string[] | string;
  confirm_label: string;
  payload_salt: string | null;
  payload_digest: string | null;
  requires_reauth: boolean;
  created_at: Date | string;
  expires_at: Date | string;
  step1_at: Date | string | null;
  token_hash: string | null;
  token_issued_at: Date | string | null;
  used_at: Date | string | null;
}

const PG_COLS =
  'id, scope, actor, kind, title, consequences, confirm_label, payload_salt, payload_digest, requires_reauth, created_at, expires_at, step1_at, token_hash, token_issued_at, used_at';

function fromPg(r: PgRow): ChallengeRow {
  return {
    id: r.id,
    scope: r.scope,
    actor: r.actor,
    kind: r.kind,
    title: r.title,
    consequences: typeof r.consequences === 'string' ? (JSON.parse(r.consequences) as string[]) : r.consequences,
    confirmLabel: r.confirm_label,
    payloadSalt: r.payload_salt,
    payloadDigest: r.payload_digest,
    requiresReauth: r.requires_reauth,
    createdAt: toDate(r.created_at),
    expiresAt: toDate(r.expires_at),
    step1At: toDateOrNull(r.step1_at),
    tokenHash: r.token_hash,
    tokenIssuedAt: toDateOrNull(r.token_issued_at),
    usedAt: toDateOrNull(r.used_at),
  };
}

export class PgChallengeStore implements ChallengeStore {
  constructor(private readonly db: Db) {}
  async insert(r: ChallengeRow): Promise<void> {
    await this.db.query(
      `INSERT INTO confirm_challenges (${PG_COLS}) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        r.id, r.scope, r.actor, r.kind, r.title, JSON.stringify(r.consequences), r.confirmLabel, r.payloadSalt, r.payloadDigest,
        r.requiresReauth, r.createdAt, r.expiresAt, r.step1At, r.tokenHash, r.tokenIssuedAt, r.usedAt,
      ],
    );
  }
  async get(id: string): Promise<ChallengeRow | null> {
    const { rows } = await this.db.query<PgRow>(`SELECT ${PG_COLS} FROM confirm_challenges WHERE id = $1`, [id]);
    return rows[0] ? fromPg(rows[0]) : null;
  }
  async findByTokenHash(hash: string): Promise<ChallengeRow | null> {
    const { rows } = await this.db.query<PgRow>(`SELECT ${PG_COLS} FROM confirm_challenges WHERE token_hash = $1`, [hash]);
    return rows[0] ? fromPg(rows[0]) : null;
  }
  async markStep1(id: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query('UPDATE confirm_challenges SET step1_at = $2 WHERE id = $1 AND step1_at IS NULL RETURNING id', [id, at]);
    return rows.length > 0;
  }
  async issueToken(id: string, tokenHash: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE confirm_challenges SET token_hash = $2, token_issued_at = $3
        WHERE id = $1 AND step1_at IS NOT NULL AND token_hash IS NULL RETURNING id`,
      [id, tokenHash, at],
    );
    return rows.length > 0;
  }
  async consume(id: string, at: Date): Promise<boolean> {
    const { rows } = await this.db.query(
      'UPDATE confirm_challenges SET used_at = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $2 RETURNING id',
      [id, at],
    );
    return rows.length > 0;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** 键排序后的 JSON，保证同一请求体得到同一摘要。 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

function digestEq(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

export type ReauthMode = 'required' | 'off';

export interface ConfirmServiceOptions {
  now: () => Date;
  /** 不传 = 没有配置 Cloudflare Access */
  access?: AccessVerifier;
  /** required（默认）：凭据操作必须重新验证，没配置 Access 时拒绝；off：本地版没有 Access，跳过并审计 */
  reauth?: ReauthMode;
  /** 重新验证的有效时限（秒），默认 300 */
  reauthMaxAgeS?: number;
  ttlMs?: number;
}

export interface ChallengeJson {
  id: string;
  level: 'important';
  kind: ImportantKind;
  title: string;
  consequences: string[];
  confirmLabel: string;
  steps: 2;
  /** 下一步该点第几次：1、2；0 = 两步都完成（令牌已签发） */
  nextStep: 0 | 1 | 2;
  minDelayMs: number;
  /** 第二次点击最早什么时候可以点（第一步完成后才有） */
  step2NotBefore: string | null;
  requiresAccessReauth: boolean;
  expiresAt: string;
  stepUrl: string;
}

export class ConfirmService {
  readonly #o: Required<Omit<ConfirmServiceOptions, 'access'>> & Pick<ConfirmServiceOptions, 'access'>;

  constructor(
    private readonly store: ChallengeStore,
    opts: ConfirmServiceOptions,
  ) {
    this.#o = { reauth: 'required', reauthMaxAgeS: 300, ttlMs: CONFIRM_TTL_MS, ...opts };
  }

  toJson(r: ChallengeRow): ChallengeJson {
    return {
      id: r.id,
      level: 'important',
      kind: r.kind,
      title: r.title,
      consequences: r.consequences,
      confirmLabel: r.confirmLabel,
      steps: 2,
      nextStep: r.tokenHash ? 0 : r.step1At ? 2 : 1,
      minDelayMs: IMPORTANT_MIN_DELAY_MS,
      step2NotBefore: r.step1At ? new Date(r.step1At.getTime() + IMPORTANT_MIN_DELAY_MS).toISOString() : null,
      requiresAccessReauth: r.requiresReauth,
      expiresAt: r.expiresAt.toISOString(),
      stepUrl: `/api/confirm/${r.id}/steps`,
    };
  }

  /**
   * 在执行操作之前调用。普通确认：记审计后放行。重要确认：没有令牌 → 抛 428（带 challenge）；
   * 有令牌 → 校验并消费，失败抛 409；成功放行。
   */
  async require(spec: ConfirmSpec, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    const target = { type: 'confirm', id: spec.scope };
    if (spec.kind === 'normal') {
      await audit('confirm.normal', target, 'ok');
      return;
    }
    if (!ctx.canConfirmImportant) {
      await audit('confirm.denied', target, 'denied', spec.kind);
      throw new HttpError(403, 'FORBIDDEN', '这个操作需要主人本人确认');
    }
    if (!ctx.confirmToken) {
      const ch = await this.#create(spec, ctx.actor);
      await audit('confirm.requested', target, 'ok', `${spec.kind} ${ch.id}`);
      throw new HttpError(428, 'CONFIRM_REQUIRED', '这个操作需要确认', { confirm: this.toJson(ch) });
    }
    const now = this.#o.now();
    const r = await this.store.findByTokenHash(sha256(ctx.confirmToken));
    const fail = async (code: string, message: string): Promise<never> => {
      await audit('confirm.rejected', target, 'failed', code);
      throw conflict(message, code);
    };
    if (!r || r.scope !== spec.scope || r.actor !== ctx.actor) return fail('CONFIRM_INVALID', '确认无效，请重新操作');
    if (r.payloadSalt && r.payloadDigest) {
      if (!digestEq(sha256(r.payloadSalt + stableStringify(spec.payload)), r.payloadDigest)) {
        return fail('CONFIRM_INVALID', '确认的内容和这次请求不一致，请重新操作');
      }
    }
    if (r.usedAt) return fail('CONFIRM_USED', '这个确认已经用过了');
    if (r.expiresAt.getTime() <= now.getTime()) return fail('CONFIRM_EXPIRED', '确认已过期，请重新操作');
    if (!(await this.store.consume(r.id, now))) return fail('CONFIRM_USED', '这个确认已经用过了');
    await audit('confirm.consumed', target, 'ok', `${r.kind} ${r.id}`);
  }

  async #create(spec: ConfirmSpec, actor: string): Promise<ChallengeRow> {
    const kind = spec.kind as ImportantKind;
    const consequences = (spec.consequences ?? []).map((c) => c.trim()).filter(Boolean);
    if (consequences.length === 0) throw new Error(`重要确认必须写明后果（scope=${spec.scope}）`);
    let requiresReauth = false;
    if (kind === 'credential') {
      if (this.#o.reauth === 'required') {
        if (!this.#o.access) {
          throw new HttpError(503, 'ACCESS_REAUTH_NOT_CONFIGURED', '涉及凭据的操作需要重新验证身份，但服务器还没有配置 Cloudflare Access');
        }
        requiresReauth = true;
      }
    }
    const now = this.#o.now();
    const salt = spec.payload !== undefined ? randomBytes(16).toString('hex') : null;
    const row: ChallengeRow = {
      id: randomUUID(),
      scope: spec.scope,
      actor,
      kind,
      title: spec.title,
      consequences,
      confirmLabel: spec.confirmLabel ?? '确认',
      payloadSalt: salt,
      payloadDigest: salt ? sha256(salt + stableStringify(spec.payload)) : null,
      requiresReauth,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#o.ttlMs),
      step1At: null,
      tokenHash: null,
      tokenIssuedAt: null,
      usedAt: null,
    };
    await this.store.insert(row);
    return row;
  }

  async get(id: string, actor: string): Promise<ChallengeJson> {
    const r = await this.store.get(id);
    if (!r || r.actor !== actor) throw notFound('找不到这个确认');
    return this.toJson(r);
  }

  /**
   * 确认卡上的一次点击。step 1：记录第一次点击；step 2：≥3 秒后，凭据操作校验 Access 令牌，签发一次性令牌。
   */
  async step(
    id: string,
    step: 1 | 2,
    ctx: { actor: string; accessJwt?: string },
    audit: AuditFn,
  ): Promise<{ challenge: ChallengeJson; confirmToken?: string }> {
    const now = this.#o.now();
    const r = await this.store.get(id);
    const target = { type: 'confirm', id: r?.scope ?? id };
    const reject = async (status: number, code: string, message: string, extra?: Record<string, unknown>): Promise<never> => {
      await audit(`confirm.step${step}`, target, status === 403 ? 'denied' : 'failed', code);
      throw new HttpError(status, code, message, extra);
    };
    if (!r || r.actor !== ctx.actor) return reject(404, 'NOT_FOUND', '找不到这个确认');
    if (r.usedAt || r.tokenHash) return reject(409, 'CONFIRM_USED', '这个确认已经完成了');
    if (r.expiresAt.getTime() <= now.getTime()) return reject(409, 'CONFIRM_EXPIRED', '确认已过期，请重新操作');

    if (step === 1) {
      if (!r.step1At) await this.store.markStep1(id, now);
      const fresh = (await this.store.get(id)) as ChallengeRow;
      await audit('confirm.step1', target, 'ok', r.id);
      return { challenge: this.toJson(fresh) };
    }

    if (!r.step1At) return reject(409, 'CONFIRM_STEP1_REQUIRED', '请先点第一次');
    const wait = r.step1At.getTime() + IMPORTANT_MIN_DELAY_MS - now.getTime();
    if (wait > 0) return reject(425, 'CONFIRM_TOO_EARLY', '请稍等几秒再点', { retryAfterMs: wait });

    let reauthNote = '';
    if (r.kind === 'credential') {
      if (r.requiresReauth) {
        const a = ctx.accessJwt && this.#o.access ? await this.#o.access.verify(ctx.accessJwt) : null;
        if (!a) return reject(401, 'ACCESS_REAUTH_REQUIRED', '请重新验证身份（Cloudflare Access）后再点');
        const iatMs = a.iat * 1000;
        const tooOld = now.getTime() - iatMs > this.#o.reauthMaxAgeS * 1000;
        const beforeChallenge = iatMs < r.createdAt.getTime() - CLOCK_SKEW_MS;
        if (tooOld || beforeChallenge) return reject(401, 'ACCESS_REAUTH_REQUIRED', '身份验证不是刚刚做的，请重新验证身份后再点');
        reauthNote = ' reauth=ok';
      } else {
        reauthNote = ' reauth=off';
      }
    }

    const token = randomBytes(24).toString('base64url');
    if (!(await this.store.issueToken(id, sha256(token), now))) return reject(409, 'CONFIRM_USED', '这个确认已经完成了');
    await audit('confirm.step2', target, 'ok', `${r.id}${reauthNote}`);
    const fresh = (await this.store.get(id)) as ChallengeRow;
    return { challenge: this.toJson(fresh), confirmToken: token };
  }
}
