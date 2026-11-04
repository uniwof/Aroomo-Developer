/** 公共记忆（B6，HUB.md 第 5 节）：用户明确允许共享给成员 / 外部客户端的事实。 */
export const TOPIC_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const BODY_MAX = 20_000;
export const KEEP_VERSIONS = 50;

export interface MemoryEntry {
  topic: string;
  title: string;
  body: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemoryVersion {
  topic: string;
  version: number;
  title: string;
  body: string;
  createdAt: Date;
}

export interface PubMemStore {
  list(userId: string): Promise<MemoryEntry[]>;
  get(userId: string, topic: string): Promise<MemoryEntry | null>;
  /** 写入新版本（原子）：当前版本进历史，version+1；不存在则 version=1。返回新条目。 */
  put(userId: string, topic: string, title: string, body: string, at: Date): Promise<MemoryEntry>;
  versions(userId: string, topic: string): Promise<MemoryVersion[]>;
  delete(userId: string, topic: string): Promise<boolean>;
}
