/**
 * Core 的依赖装配：有数据库就用 PostgreSQL 实现，否则用内存实现（开发 / 演示 / 测试）。
 * 每类数据只有一个权威来源（DECISIONS D45）：Core 的业务数据在 aroomo_core 库。
 */
import { MemoryAuditLog } from './audit/memory.js';
import { PgAuditLog } from './audit/pg.js';
import type { AuditLog } from './audit/types.js';
import { MemoryOperatorTokenStore, type OperatorTokenStore } from './auth/tokens.js';
import type { CoreConfig } from './config.js';
import type { LiteLLMAdmin } from './keys/litellm.js';
import { createPgDb, type Db } from './db/db.js';
import { migrate } from './db/migrate.js';
import type { AccessVerifier } from './confirm/access.js';
import { type ChallengeStore, MemoryChallengeStore, PgChallengeStore } from './confirm/confirm.js';
import { MemoryInboxStore } from './inbox/memory.js';
import { PgInboxStore } from './inbox/pg.js';
import type { InboxStore } from './inbox/types.js';
import { MemoryKeyStore, PgKeyStore } from './keys/stores.js';
import type { KeyStore } from './keys/types.js';
import { MemoryMemberStore } from './members/memory.js';
import { PgMemberStore } from './members/pg.js';
import type { MemberStore } from './members/types.js';
import { MemoryUserStore } from './users/memory.js';
import { PgUserStore } from './users/pg.js';
import type { UserStore } from './users/types.js';
import { MemorySettingsStore, PgSettingsStore, type SettingsStore } from './settings/store.js';

export interface CoreDeps {
  now: () => Date;
  auditLog: AuditLog;
  operatorTokens: OperatorTokenStore;
  members: MemberStore;
  inbox: InboxStore;
  confirmChallenges: ChallengeStore;
  /** 测试时注入假的 Cloudflare Access 校验；不传则按配置创建 */
  access?: AccessVerifier;
  keys: KeyStore;
  settings: SettingsStore;
  users: UserStore;
  /** 测试时注入：对话入口调用 LiteLLM 用的 fetch */
  chatFetch?: typeof fetch;
  /** 测试时注入；不传则按配置连接 LiteLLM */
  litellm?: LiteLLMAdmin;
  /** 有数据库时才有；关闭服务时一并关闭 */
  db?: Db;
}

export function memoryDeps(now: () => Date = () => new Date()): CoreDeps {
  return {
    now,
    auditLog: new MemoryAuditLog(now),
    operatorTokens: new MemoryOperatorTokenStore(),
    members: new MemoryMemberStore(),
    inbox: new MemoryInboxStore(),
    confirmChallenges: new MemoryChallengeStore(),
    keys: new MemoryKeyStore(),
    settings: new MemorySettingsStore(),
    users: new MemoryUserStore(),
  };
}

/** 基于已连接（且已迁移）的数据库装配依赖。 */
export function pgDeps(db: Db, now: () => Date = () => new Date()): CoreDeps {
  return {
    now,
    db,
    auditLog: new PgAuditLog(db, now),
    members: new PgMemberStore(db),
    inbox: new PgInboxStore(db),
    confirmChallenges: new PgChallengeStore(db),
    keys: new PgKeyStore(db),
    settings: new PgSettingsStore(db),
    users: new PgUserStore(db),
    // 操作员令牌的签发 / 持久化属于负责人体系，后续 Issue 再落库
    operatorTokens: new MemoryOperatorTokenStore(),
  };
}

export async function createDeps(cfg: CoreConfig): Promise<{ deps: CoreDeps; migrated: string[]; storage: 'postgres' | 'memory' }> {
  if (!cfg.databaseUrl) return { deps: memoryDeps(), migrated: [], storage: 'memory' };
  const db = createPgDb(cfg.databaseUrl);
  const migrated = cfg.autoMigrate ? await migrate(db) : [];
  return { deps: pgDeps(db), migrated, storage: 'postgres' };
}
