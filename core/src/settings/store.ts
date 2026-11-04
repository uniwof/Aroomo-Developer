/**
 * Core 设置（键值，不放密钥）。P0：负责人 lead。
 */
import type { Db } from '../db/db.js';

export interface SettingsStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, at: Date): Promise<void>;
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

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly db: Db) {}
  async get<T>(key: string): Promise<T | null> {
    const { rows } = await this.db.query<{ value: T }>('SELECT value FROM core_settings WHERE key = $1', [key]);
    return rows[0] ? rows[0].value : null;
  }
  async set(key: string, value: unknown, at: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO core_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), at],
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
  return {
    get: <T>(key: string) => store.get<T>(k(key)),
    set: (key: string, value: unknown, at: Date) => store.set(k(key), value, at),
  };
}
