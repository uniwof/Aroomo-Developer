/**
 * Core 设置（键值，不放密钥）。P0：负责人 lead。
 */
import type { Db } from '../db/db.js';
import { userScoped } from '../db/scope.js';

export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, at: Date): Promise<void>;
  /** 同一存储、改为声明归属账号 userId 的视图（PgSettingsStore 用它绑定 RLS 范围；内存版无 RLS，不实现） */
  forAccount?(userId: string): SettingsStore;
}

export class MemorySettingsStore implements SettingsStore {
  readonly #m = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return this.#m.has(key) ? (structuredClone(this.#m.get(key)) as T) : null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.#m.set(key, structuredClone(value));
  }
}

/** 键名前缀 u<32 位十六进制>.（scopedSettings 加的），迁移 0037 按同一规则回填 core_settings.user_id */
const USER_PREFIX = /^u([a-f0-9]{32})\./;

/** core_settings 的归属键（RLS 的 user_id）：带前缀的键 → 标准 UUID 写法；其余（所有者、全局设置）→ 'owner' */
export function settingsOwnerOf(key: string): string {
  const m = USER_PREFIX.exec(key);
  if (!m) return 'owner';
  const h = m[1]!;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * RLS（0037，#345 P1）：调用方在构造时显式声明归属账号（'owner' 或标准 UUID），每次读写先断言
 * 键名换算出的账号 = 声明的账号，不一致就抛错（负责人第 1 轮 M1：不能由键名决定去谁的范围）；
 * 断言过了才在该账号的 userScoped 里读写，并带 WHERE user_id。没有跨账号枚举，所以不需要 systemScoped。
 */
export class PgSettingsStore implements SettingsStore {
  constructor(
    private readonly db: Db,
    private readonly account: string,
  ) {}
  forAccount(userId: string): SettingsStore {
    return new PgSettingsStore(this.db, userId);
  }
  #uid(key: string): string {
    const uid = settingsOwnerOf(key);
    if (uid !== this.account) throw new Error(`设置键不属于声明的账号（声明 ${this.account}，键名换算 ${uid}）`);
    return uid;
  }
  async get<T>(key: string): Promise<T | null> {
    const uid = this.#uid(key);
    const { rows } = await userScoped(this.db, uid).query<{ value: T }>(
      'SELECT value FROM core_settings WHERE user_id = $1 AND key = $2',
      [uid, key],
    );
    return rows[0] ? rows[0].value : null;
  }
  async set(key: string, value: unknown, at: Date): Promise<void> {
    const uid = this.#uid(key);
    await userScoped(this.db, uid).query(
      `INSERT INTO core_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
       WHERE core_settings.user_id = EXCLUDED.user_id`,
      [uid, key, JSON.stringify(value), at],
    );
  }
}

/**
 * 某个用户的设置视图（D111）：键加用户前缀。'owner'（所有者令牌）用原来的键，保持既有数据可读。
 * 前缀 = 'u' + 去掉连字符的用户 id（32 位十六进制），仍满足 core_settings 的键格式（小写字母开头，≤64）。
 */
export function scopedSettings(store: SettingsStore, userId: string): SettingsStore {
  if (userId === 'owner') return store;
  const hex = userId.toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!/^[a-f0-9]{32}$/.test(hex)) throw new Error('非法 user id');
  const k = (key: string) => `u${hex}.${key}`;
  const base = store.forAccount ? store.forAccount(settingsOwnerOf(k(''))) : store;
  return {
    get: <T>(key: string) => base.get<T>(k(key)),
    set: (key: string, value: unknown, at: Date) => base.set(k(key), value, at),
  };
}
