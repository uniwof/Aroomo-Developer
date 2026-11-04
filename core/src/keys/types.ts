/**
 * Key 管理的本地元数据（DECISIONS D34、D45：Key 的唯一权威存储是 LiteLLM 数据库）。
 * Core 本地**只存非敏感元数据**：名称、获取网址、末 4 位、LiteLLM 部署 id、状态。完整 Key 永不落 Core 的库。
 */

export type KeyStatus = 'active' | 'sync_failed';

export interface KeyRecord {
  id: string;
  /** 所属账号；缺省 = 所有者 */
  userId?: string;
  name: string;
  /** 获取网址（在哪里申请到的这个 Key） */
  sourceUrl: string;
  last4: string;
  /** LiteLLM 模型串，例如 openai/gpt-4o-mini */
  model: string;
  /** 在 LiteLLM 里对外的模型名 */
  modelName: string;
  apiBase: string | null;
  litellmModelId: string;
  status: KeyStatus;
  modelsSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KeyStore {
  /** userId 缺省 = 所有者的 Key；只返回该账号自己的 */
  list(userId?: string): Promise<KeyRecord[]>;
  /** 只取该账号自己的 Key（所有者传 'owner'）；别人的 id 一律 null（D206：不再按 id 裸取）。 */
  get(userId: string, id: string): Promise<KeyRecord | null>;
  insert(k: KeyRecord): Promise<void>;
  /** 只改该账号自己的 Key；不是它的返回 false，什么都不改。 */
  update(userId: string, k: KeyRecord): Promise<boolean>;
  /** 只删该账号自己的 Key；不是它的返回 false。 */
  delete(userId: string, id: string): Promise<boolean>;
}
