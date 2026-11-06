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
import { assertAppRoleSafe, grantAppRole } from './db/app-role.js';
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
import { MemoryVaultStore } from './vault/memory.js';
import { PgVaultStore } from './vault/pg.js';
import type { VaultStore } from './vault/types.js';
import { MemoryClientTokenStore } from './clients/memory.js';
import { PgClientTokenStore } from './clients/pg.js';
import type { ClientTokenStore } from './clients/types.js';
import { MemoryExecutorStore } from './executor/memory.js';
import { PgExecutorStore } from './executor/pg.js';
import type { ExecutorStore } from './executor/types.js';
import { MemoryLibraryStore } from './library/memory.js';
import { PgLibraryStore } from './library/pg.js';
import type { LibraryStore } from './library/types.js';
import { MemoryPubMemStore } from './pubmem/memory.js';
import { PgPubMemStore } from './pubmem/pg.js';
import type { PubMemStore } from './pubmem/types.js';
import { MemoryUserStore } from './users/memory.js';
import { PgUserStore } from './users/pg.js';
import type { UserStore } from './users/types.js';
import { MemoryAssistantStore } from './assistants/memory.js';
import { PgAssistantStore } from './assistants/pg.js';
import type { AssistantStore, BudgetLevel } from './assistants/types.js';
import { MemoryConversationStore } from './conversations/memory.js';
import { PgConversationStore } from './conversations/pg.js';
import type { ConversationStore } from './conversations/types.js';
import { MemoryPushStore, PgPushStore, type PushStore } from './push/store.js';
import { MemoryWorkStore, PgWorkStore, type WorkStore } from './work/store.js';
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
  vault: VaultStore;
  clients: ClientTokenStore;
  executor: ExecutorStore;
  pubmem: PubMemStore;
  library: LibraryStore;
  assistants: AssistantStore;
  /** 会话存库（聊天会话，kind = 'chat'） */
  conversations: ConversationStore;
  /** X-08 推送订阅 */
  push: PushStore;
  /** 测试时注入：推送服务的 fetch */
  pushFetch?: typeof fetch;
  /** /work 项目与版本（0033） */
  work: WorkStore;
  /** 测试时注入：/work 同步 GitHub 用的 fetch */
  workFetch?: typeof fetch;
  /** 测试时注入：对话入口调用 LiteLLM 用的 fetch */
  chatFetch?: typeof fetch;
  /** 测试时注入：/api/chat/stream 的每账号频率 / 并发限制（默认 20 次/分钟、同时 2 条） */
  chatStreamLimits?: { perMinute?: number; concurrent?: number };
  /** 测试时注入；不传则按配置连接 LiteLLM */
  litellm?: LiteLLMAdmin;
  /** 测试时注入：助手每次最长运行时间（秒 → 毫秒）的换算，和「是否免费模型」的判定 */
  assistantTimeoutMs?: (sec: number) => number;
  /** 按真实模型串（Key 的 model）判断免费；不传 = 能力种子清单 */
  assistantIsFree?: (model: string) => boolean;
  /** 测试用：换掉 X-19 长会话压缩的字数上限 / 每天次数 */
  compactLimits?: Partial<import('./conversations/compact.js').CompactLimits>;
  /** 测试用：每次 / 每天调用上限 */
  assistantBudgets?: Record<BudgetLevel, { perRun: number; perDay: number }>;
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
    vault: new MemoryVaultStore(),
    clients: new MemoryClientTokenStore(),
    executor: new MemoryExecutorStore(),
    pubmem: new MemoryPubMemStore(),
    library: new MemoryLibraryStore(),
    assistants: new MemoryAssistantStore(),
    conversations: new MemoryConversationStore(),
    push: new MemoryPushStore(),
    work: new MemoryWorkStore(),
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
    vault: new PgVaultStore(db),
    clients: new PgClientTokenStore(db),
    executor: new PgExecutorStore(db),
    pubmem: new PgPubMemStore(db),
    library: new PgLibraryStore(db),
    assistants: new PgAssistantStore(db),
    conversations: new PgConversationStore(db),
    push: new PgPushStore(db),
    work: new PgWorkStore(db),
    // 操作员令牌的签发 / 持久化属于负责人体系，后续 Issue 再落库
    operatorTokens: new MemoryOperatorTokenStore(),
  };
}

/**
 * 打开业务连接池。D206：迁移与授权用登录角色（表所有者）；业务连接用应用角色，并确认它受 RLS 约束。
 * 设了 CORE_APP_DB_PASSWORD → 应用角色自己登录（D213 第 13 项，会话里 SET ROLE 回不到所有者）；否则旧做法 SET ROLE。
 */
export async function openAppDb(cfg: CoreConfig): Promise<{ db: Db; migrated: string[] }> {
  if (!cfg.databaseUrl) throw new Error('openAppDb 需要 CORE_DATABASE_URL');
  if (!cfg.dbAppRole) {
    const db = createPgDb(cfg.databaseUrl);
    return { db, migrated: cfg.autoMigrate ? await migrate(db) : [] };
  }
  const owner = createPgDb(cfg.databaseUrl, { max: 1 });
  let migrated: string[] = [];
  try {
    migrated = cfg.autoMigrate ? await migrate(owner) : [];
    await grantAppRole(owner, cfg.dbAppRole);
  } finally {
    await owner.close();
  }
  const db = cfg.appDatabaseUrl ? createPgDb(cfg.appDatabaseUrl) : createPgDb(cfg.databaseUrl, { role: cfg.dbAppRole });
  try {
    await db.tx((q) => assertAppRoleSafe(q, { expectRole: cfg.dbAppRole, requireLogin: cfg.requireAppRole || cfg.appDatabaseUrl !== undefined }));
  } catch (err) {
    await db.close();
    throw err;
  }
  return { db, migrated };
}

export async function createDeps(cfg: CoreConfig): Promise<{ deps: CoreDeps; migrated: string[]; storage: 'postgres' | 'memory' }> {
  if (!cfg.databaseUrl) return { deps: memoryDeps(), migrated: [], storage: 'memory' };
  const { db, migrated } = await openAppDb(cfg);
  return { deps: pgDeps(db), migrated, storage: 'postgres' };
}
