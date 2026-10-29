/** 保险箱（B2，HUB.md 第 2 节）。 */
import type { SealedSecret } from './crypto.js';

export const SECRET_KINDS = ['api_key', 'token', 'password', 'note'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];
export const VALUE_MAX = 8192;
export const MAX_SECRETS_PER_USER = 500;

export interface SecretRecord extends SealedSecret {
  id: string;
  userId: string;
  name: string;
  kind: SecretKind;
  last4: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
  deletedAt: Date | null;
}

/** 对外可见的信息：永远没有明文、密文、DEK。 */
export interface PublicSecret {
  id: string;
  name: string;
  kind: SecretKind;
  last4: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
}

export interface VaultStore {
  /** 未删除的记录，按名字排序 */
  list(userId: string): Promise<SecretRecord[]>;
  get(userId: string, id: string): Promise<SecretRecord | null>;
  /** 名字（不分大小写）已被未删除记录占用 → 抛 NAME_TAKEN */
  insert(rec: SecretRecord): Promise<void>;
  replace(userId: string, id: string, sealed: SealedSecret, last4: string, at: Date): Promise<boolean>;
  /** 清空密文并记 deleted_at */
  erase(userId: string, id: string, at: Date): Promise<boolean>;
  /** 全部行数（含已删除），启动检查用 */
  countAll(): Promise<number>;
  /** 仍带密文的行数（未删除） */
  countLive(): Promise<number>;
}

export class NameTakenError extends Error {
  constructor() {
    super('NAME_TAKEN');
  }
}
