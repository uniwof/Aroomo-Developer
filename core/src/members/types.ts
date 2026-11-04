/**
 * 成员（PRODUCT §9.1、§12 Member、§8.3 成员页、§8.4 列表操作）。
 * 成员以模型为单位；name 是英文原名（例如 "Gemini 2.5 Pro"）。
 */

export const CAPABILITY_TAGS = ['text', 'long-context', 'image', 'video', 'multimodal', 'voice', 'code', 'reasoning'] as const;
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

/** 成员状态（PRODUCT §9.1 入职流程）：candidate = 候选，等用户一键入职；active = 在职。 */
export const MEMBER_STATUSES = ['candidate', 'active'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * 后端从 LiteLLM 模型信息判定的模型事实（PRODUCT §9.1「负责人资格……由后端统一判定」）。
 * 某项为 null 表示 LiteLLM 没有给出（未知）。
 */
export interface ModelCaps {
  /** LiteLLM 的 mode：chat、responses、embedding、image_generation、audio_speech… */
  mode: string | null;
  /** 最大输入 token（上下文长度） */
  maxInputTokens: number | null;
  /** 支持工具调用（function calling） */
  supportsTools: boolean | null;
  checkedAt: string;
}

export interface Member {
  id: string;
  name: string;
  aliases: string[];
  capabilityTags: CapabilityTag[];
  enabled: boolean;
  pinned: boolean;
  sortOrder: number;
  status: MemberStatus;
  modelCaps: ModelCaps | null;
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
  /** 同一份数据里属于另一个用户的视图（D111：互相看不见）。所有方法只读写这个用户的行。 */
  forUser(userId: string): MemberStore;
  /** 有成员数据的全部用户（后台任务逐个用户处理用；不含成员内容） */
  userIds(): Promise<string[]>;
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
