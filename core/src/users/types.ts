/**
 * 多用户账号（B1；DECISIONS D111、D117）。
 * 登录在 Core 层：邮箱 + 密码，凭邀请注册。不依赖任何界面（D118：界面只是接在中枢上的一层）。
 */
export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  /** scrypt$N$r$p$salt$hash；永远不返回给客户端 */
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** 返回给客户端的用户（没有密码哈希） */
export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface InviteRecord {
  tokenHash: string;
  kind: 'invite' | 'reset';
  email: string;
  userId: string | null;
  role: UserRole;
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export class EmailTakenError extends Error {
  constructor() {
    super('email taken');
    this.name = 'EmailTakenError';
  }
}

export interface UserPatch {
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  passwordHash?: string;
}

export interface UserStore {
  /** 邮箱（不分大小写）已存在则抛 EmailTakenError */
  insertUser(u: UserRecord): Promise<void>;
  getUser(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUser(id: string, patch: UserPatch, at: Date): Promise<UserRecord | null>;
  insertInvite(i: InviteRecord): Promise<void>;
  /** 原子地「用掉」一张未用、未过期的邀请；否则返回 null（一次性） */
  useInvite(tokenHash: string, at: Date): Promise<InviteRecord | null>;
  listOpenInvites(at: Date): Promise<InviteRecord[]>;
  insertSession(s: SessionRecord): Promise<void>;
  getSession(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(tokenHash: string, at: Date): Promise<void>;
  /** 吊销某用户的全部会话（可保留一个） */
  revokeUserSessions(userId: string, at: Date, exceptTokenHash?: string): Promise<void>;
}

/** 用会话令牌登录的账号身份（Principal 的一种）。userId 是所有业务数据的隔离键（D111）。 */
export interface UserPrincipal {
  type: 'user';
  id: string;
  userId: string;
  email: string;
  role: UserRole;
  /** 当前会话令牌的 SHA-256（用于「退出本设备」「改密码后保留本设备」） */
  sessionId: string;
}
