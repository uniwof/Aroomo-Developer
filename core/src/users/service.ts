/**
 * 账号服务（B1）：邀请制注册、登录、退出、退出所有设备、改密码、管理员停用 / 重置。
 * 令牌（会话、邀请）只存 SHA-256；明文只在创建时返回一次，不进审计、不进日志。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import { DUMMY_HASH, hashPassword, PASSWORD_MAX, PASSWORD_MIN, verifyPassword } from './password.js';
import { EmailTakenError, type UserPrincipal, type InviteRecord, type PublicUser, type UserRecord, type UserRole, type UserStore } from './types.js';

export const SESSION_PREFIX = 'ars_';
const INVITE_PREFIX = 'ari_';
const SESSION_TTL_MS = 30 * 24 * 3600_000; // 与 D67 的 30 天一致
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = (prefix: string) => prefix + randomBytes(32).toString('base64url');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const publicUser = (u: UserRecord): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  status: u.status,
  createdAt: u.createdAt.toISOString(),
});

export interface LoginResult {
  token: string;
  expiresAt: string;
  user: PublicUser;
}

export class UsersService {
  readonly #fails = new Map<string, { n: number; until: number }>();

  constructor(
    private readonly store: UserStore,
    private readonly now: () => Date,
  ) {}

  #checkPassword(pw: string): void {
    if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) throw badRequest(`密码至少 ${PASSWORD_MIN} 位`, 'WEAK_PASSWORD');
    if (pw.length > PASSWORD_MAX) throw badRequest('密码太长', 'WEAK_PASSWORD');
  }

  #normEmail(email: string): string {
    const e = String(email ?? '').trim();
    if (!EMAIL_RE.test(e)) throw badRequest('邮箱格式不对');
    return e;
  }

  async #newSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken(SESSION_PREFIX);
    const at = this.now();
    const expiresAt = new Date(at.getTime() + SESSION_TTL_MS);
    await this.store.insertSession({ tokenHash: sha256(token), userId, createdAt: at, expiresAt, revokedAt: null });
    return { token, expiresAt };
  }

  /** 校验会话令牌 → 用户身份；停用的账号立刻失效 */
  async verifySession(token: string): Promise<UserPrincipal | null> {
    if (!token.startsWith(SESSION_PREFIX)) return null;
    const hash = sha256(token);
    const s = await this.store.getSession(hash);
    if (!s || s.revokedAt || s.expiresAt.getTime() <= this.now().getTime()) return null;
    const u = await this.store.getUser(s.userId);
    if (!u || u.status !== 'active') return null;
    return { type: 'user', id: u.id, userId: u.id, email: u.email, role: u.role, sessionId: hash };
  }

  // ---- 邀请 / 重置（管理员） ----

  async invite(emailRaw: string, role: UserRole, createdBy: string, audit: AuditFn): Promise<{ token: string; expiresAt: string; email: string; role: UserRole }> {
    const email = this.#normEmail(emailRaw);
    if (await this.store.getUserByEmail(email)) throw conflict('这个邮箱已经注册了', 'EMAIL_TAKEN');
    const token = newToken(INVITE_PREFIX);
    const at = this.now();
    const expiresAt = new Date(at.getTime() + INVITE_TTL_MS);
    await this.store.insertInvite({ tokenHash: sha256(token), kind: 'invite', email, userId: null, role, createdBy, createdAt: at, expiresAt, usedAt: null });
    await audit('users.invite', { type: 'user-invite', id: email }, 'ok', `role=${role}`);
    return { token, expiresAt: expiresAt.toISOString(), email, role };
  }

  async issueReset(userId: string, createdBy: string, audit: AuditFn): Promise<{ token: string; expiresAt: string }> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('找不到这个用户');
    const token = newToken(INVITE_PREFIX);
    const at = this.now();
    const expiresAt = new Date(at.getTime() + 24 * 3600_000);
    await this.store.insertInvite({ tokenHash: sha256(token), kind: 'reset', email: u.email, userId: u.id, role: u.role, createdBy, createdAt: at, expiresAt, usedAt: null });
    await audit('users.reset-link', { type: 'user', id: u.id }, 'ok');
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async listOpenInvites(): Promise<Array<Omit<InviteRecord, 'tokenHash'>>> {
    return (await this.store.listOpenInvites(this.now())).map(({ tokenHash: _t, ...rest }) => rest);
  }

  /** 用邀请注册，或用重置链接设新密码；成功即登录 */
  async accept(token: string, password: string, displayName: string | undefined, audit: AuditFn): Promise<LoginResult> {
    this.#checkPassword(password);
    const inv = await this.store.useInvite(sha256(token), this.now());
    if (!inv) throw new HttpError(400, 'INVITE_INVALID', '邀请无效或已过期');
    const passwordHash = await hashPassword(password);
    const at = this.now();
    let user: UserRecord;
    if (inv.kind === 'invite') {
      user = {
        id: randomUUID(),
        email: inv.email,
        displayName: (displayName ?? '').trim().slice(0, 64),
        role: inv.role,
        status: 'active',
        passwordHash,
        createdAt: at,
        updatedAt: at,
      };
      try {
        await this.store.insertUser(user);
      } catch (err) {
        if (err instanceof EmailTakenError) throw conflict('这个邮箱已经注册了', 'EMAIL_TAKEN');
        throw err;
      }
      await audit('users.register', { type: 'user', id: user.id }, 'ok', inv.email);
    } else {
      const upd = await this.store.updateUser(inv.userId as string, { passwordHash }, at);
      if (!upd) throw new HttpError(400, 'INVITE_INVALID', '邀请无效或已过期');
      user = upd;
      await this.store.revokeUserSessions(user.id, at); // 重置密码后所有旧会话作废
      await audit('users.password-reset', { type: 'user', id: user.id }, 'ok');
    }
    if (user.status !== 'active') throw new HttpError(403, 'ACCOUNT_DISABLED', '账号已停用');
    const s = await this.#newSession(user.id);
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: publicUser(user) };
  }

  // ---- 登录 / 退出 ----

  async login(emailRaw: string, password: string, clientKey: string, audit: AuditFn): Promise<LoginResult> {
    const email = String(emailRaw ?? '').trim().toLowerCase();
    const key = `${email}|${clientKey}`;
    const t = this.now().getTime();
    const f = this.#fails.get(key);
    if (f && f.n >= MAX_FAILS && f.until > t) {
      await audit('auth.login', { type: 'user', id: email }, 'denied', '尝试次数过多');
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '尝试次数太多，请 15 分钟后再试');
    }
    const u = email ? await this.store.getUserByEmail(email) : null;
    const ok = await verifyPassword(String(password ?? ''), u ? u.passwordHash : DUMMY_HASH);
    if (!u || !ok || u.status !== 'active') {
      const prev = f && f.until > t ? f.n : 0;
      this.#fails.set(key, { n: prev + 1, until: t + LOCK_MS });
      await audit('auth.login', { type: 'user', id: email }, 'failed');
      throw new HttpError(401, 'BAD_CREDENTIALS', '邮箱或密码不对');
    }
    this.#fails.delete(key);
    const s = await this.#newSession(u.id);
    await audit('auth.login', { type: 'user', id: u.id }, 'ok');
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), user: publicUser(u) };
  }

  async logout(p: UserPrincipal, audit: AuditFn): Promise<void> {
    await this.store.revokeSession(p.sessionId, this.now());
    await audit('auth.logout', { type: 'user', id: p.userId }, 'ok');
  }

  async logoutAll(p: UserPrincipal, audit: AuditFn): Promise<void> {
    await this.store.revokeUserSessions(p.userId, this.now());
    await audit('auth.logout-all', { type: 'user', id: p.userId }, 'ok');
  }

  async changePassword(p: UserPrincipal, current: string, next: string, audit: AuditFn): Promise<void> {
    this.#checkPassword(next);
    const u = await this.store.getUser(p.userId);
    if (!u || !(await verifyPassword(current, u.passwordHash))) {
      await audit('users.password-change', { type: 'user', id: p.userId }, 'failed', '当前密码不对');
      throw new HttpError(403, 'BAD_CREDENTIALS', '当前密码不对');
    }
    const at = this.now();
    await this.store.updateUser(u.id, { passwordHash: await hashPassword(next) }, at);
    await this.store.revokeUserSessions(u.id, at, p.sessionId); // 改密码后其它设备全部退出
    await audit('users.password-change', { type: 'user', id: u.id }, 'ok');
  }

  // ---- 管理 ----

  async list(): Promise<PublicUser[]> {
    return (await this.store.listUsers()).map(publicUser);
  }

  async me(userId: string): Promise<PublicUser> {
    const u = await this.store.getUser(userId);
    if (!u) throw notFound('找不到这个用户');
    return publicUser(u);
  }

  async setStatus(id: string, status: 'active' | 'disabled', actorUserId: string | null, audit: AuditFn): Promise<PublicUser> {
    const u = await this.store.getUser(id);
    if (!u) throw notFound('找不到这个用户');
    if (status === 'disabled' && id === actorUserId) throw conflict('不能停用自己的账号', 'SELF_DISABLE');
    if (status === 'disabled' && u.role === 'admin') {
      const admins = (await this.store.listUsers()).filter((x) => x.role === 'admin' && x.status === 'active');
      if (admins.length <= 1 && admins[0]?.id === id) throw conflict('至少要保留一个可用的管理员', 'LAST_ADMIN');
    }
    const at = this.now();
    const upd = (await this.store.updateUser(id, { status }, at)) as UserRecord;
    if (status === 'disabled') await this.store.revokeUserSessions(id, at);
    await audit(status === 'disabled' ? 'users.disable' : 'users.enable', { type: 'user', id }, 'ok');
    return publicUser(upd);
  }
}
