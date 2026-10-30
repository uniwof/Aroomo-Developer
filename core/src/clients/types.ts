/**
 * 外部客户端令牌（HUB.md 1.1）。一个客户端一枚令牌；scope 白名单；可随时吊销；每次调用都审计。
 */

/** 目前可授予的范围。B5 的 tools:call:<id> 随工具网关一起加入，这里不预留（宁可不能授予，也不要悄悄放宽）。 */
export const CLIENT_SCOPES = ['bookmarks:read', 'library:read', 'library:write', 'memory:read', 'brief:read', 'tools:list', 'models:chat', 'tasks:pull', 'tasks:secret', 'tasks:create', 'tasks:read', 'tools:call'] as const;
export type ClientScope = (typeof CLIENT_SCOPES)[number];

export interface ClientTokenRecord {
  id: string;
  /** 归属：'owner' 或 users.id（B1b） */
  userId: string;
  name: string;
  tokenHash: string;
  scopes: ClientScope[];
  rateLimitPerMin: number;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** 返回给人的列表项（没有 tokenHash） */
export interface PublicClient {
  id: string;
  name: string;
  scopes: ClientScope[];
  rateLimitPerMin: number;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ClientPrincipal {
  type: 'client';
  id: string;
  clientId: string;
  /** 令牌创建者的归属键：这个客户端只能看到这个用户的数据 */
  userId: string;
  name: string;
  scopes: ReadonlySet<ClientScope>;
}

export interface ClientTokenStore {
  insert(r: ClientTokenRecord): Promise<void>;
  getByHash(tokenHash: string): Promise<ClientTokenRecord | null>;
  /** 只列这个用户的（含已吊销，方便看历史） */
  listByUser(userId: string): Promise<ClientTokenRecord[]>;
  /** 吊销这个用户的一枚令牌；不是他的或不存在返回 false（对别人的令牌表现为「不存在」） */
  revoke(userId: string, id: string, at: Date): Promise<boolean>;
  revokeAll(userId: string, at: Date): Promise<number>;
  touch(id: string, at: Date): Promise<void>;
}
