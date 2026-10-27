/**
 * Core Key 非敏感元数据存储接口与内存实现（PRODUCT §8.3、DECISIONS v4.3）
 * 供应商 Key 只在 LiteLLM 中加密存储，Core 本地绝不保存完整 Key。
 */

export type KeyStatus = 'active' | 'error' | 'disabled';

export interface KeyMetadata {
  id: string;
  name: string;
  sourceUrl: string;
  last4: string;
  litellmDeploymentId: string;
  status: KeyStatus;
  createdAt: string;
  updatedAt: string;
}

export interface KeyStore {
  create(data: Omit<KeyMetadata, 'createdAt' | 'updatedAt'>): Promise<KeyMetadata>;
  get(id: string): Promise<KeyMetadata | null>;
  list(): Promise<KeyMetadata[]>;
  update(
    id: string,
    patch: Partial<Pick<KeyMetadata, 'name' | 'sourceUrl' | 'last4' | 'litellmDeploymentId' | 'status'>>,
  ): Promise<KeyMetadata | null>;
  delete(id: string): Promise<boolean>;
}

export class MemoryKeyStore implements KeyStore {
  private keys: Map<string, KeyMetadata> = new Map();

  async create(data: Omit<KeyMetadata, 'createdAt' | 'updatedAt'>): Promise<KeyMetadata> {
    const now = new Date().toISOString();
    const item: KeyMetadata = {
      ...data,
      createdAt: now,
      updatedAt: now,
    };
    this.keys.set(item.id, item);
    return { ...item };
  }

  async get(id: string): Promise<KeyMetadata | null> {
    const item = this.keys.get(id);
    return item ? { ...item } : null;
  }

  async list(): Promise<KeyMetadata[]> {
    return Array.from(this.keys.values()).map((item) => ({ ...item }));
  }

  async update(
    id: string,
    patch: Partial<Pick<KeyMetadata, 'name' | 'sourceUrl' | 'last4' | 'litellmDeploymentId' | 'status'>>,
  ): Promise<KeyMetadata | null> {
    const item = this.keys.get(id);
    if (!item) return null;

    const updated: KeyMetadata = {
      ...item,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.keys.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<boolean> {
    return this.keys.delete(id);
  }
}
