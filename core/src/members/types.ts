/**
 * 成员（PRODUCT §9.1、§12 Member、§8.3 成员页、§8.4 列表操作）。
 * 成员以模型为单位；name 是英文原名（例如 "Gemini 2.5 Pro"）。
 */

export const CAPABILITY_TAGS = ['text', 'long-context', 'image', 'video', 'multimodal', 'voice', 'code', 'reasoning'] as const;
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface Member {
  id: string;
  name: string;
  aliases: string[];
  capabilityTags: CapabilityTag[];
  enabled: boolean;
  pinned: boolean;
  sortOrder: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 回收站保留天数（PRODUCT §8.4：删除可撤销，回收站 30 天）。 */
export const RECYCLE_DAYS = 30;
export const RECYCLE_MS = RECYCLE_DAYS * 24 * 60 * 60 * 1000;

export const MEMBER_ID_RE = /^[a-z0-9-]{1,64}$/;

export class DuplicateIdError extends Error {
  constructor() {
    super('成员 id 已存在');
    this.name = 'DuplicateIdError';
  }
}
export class DuplicateNameError extends Error {
  constructor() {
    super('成员名字已存在');
    this.name = 'DuplicateNameError';
  }
}
export class InvalidOrderError extends Error {
  constructor() {
    super('排序列表必须恰好包含全部未删除成员');
    this.name = 'InvalidOrderError';
  }
}

/**
 * 存储接口：只做持久化与原子性保证（名字唯一、重排原子），业务规则在 MembersService。
 * 名字唯一：大小写不敏感，只在未删除成员之间。
 */
export interface MemberStore {
  listAll(): Promise<Member[]>;
  get(id: string): Promise<Member | null>;
  /** @throws DuplicateIdError | DuplicateNameError */
  insert(m: Member): Promise<void>;
  /** 按 id 整行覆盖。@throws DuplicateNameError */
  update(m: Member): Promise<void>;
  /** 彻底删除，返回是否删到了。 */
  delete(id: string): Promise<boolean>;
  /** 原子重排：ids 必须与当前未删除成员集合完全一致，否则不改任何数据。@throws InvalidOrderError */
  reorder(ids: string[], now: Date): Promise<void>;
}
