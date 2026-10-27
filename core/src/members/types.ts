export const CAPABILITY_TAGS = [
  'text',
  'long-context',
  'image',
  'video',
  'multimodal',
  'voice',
  'code',
  'reasoning',
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface Member {
  id: string;
  name: string;
  aliases: string[];
  capabilityTags: CapabilityTag[];
  enabled: boolean;
  pinned: boolean;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemberInput {
  id: string;
  name: string;
  aliases?: string[];
  capabilityTags?: CapabilityTag[];
  enabled?: boolean;
  pinned?: boolean;
  sortOrder?: number;
}

export interface UpdateMemberInput {
  name?: string;
  aliases?: string[];
  capabilityTags?: CapabilityTag[];
  enabled?: boolean;
  pinned?: boolean;
  sortOrder?: number;
}

export type AuditAction =
  | 'member.create'
  | 'member.update'
  | 'member.delete'
  | 'member.restore'
  | 'member.purge'
  | 'member.pin'
  | 'member.unpin'
  | 'member.reorder';

export type AuditFn = (
  action: AuditAction | string,
  target: string,
  result: 'success' | 'failure',
  details?: Record<string, unknown>,
) => void | Promise<void>;

export interface MemberStoreOptions {
  getNow?: () => Date;
}

export interface MemberStore {
  list(options?: { includeDeleted?: boolean }): Promise<Member[]>;
  findById(id: string): Promise<Member | null>;
  findByName(name: string): Promise<Member | null>;
  create(input: CreateMemberInput): Promise<Member>;
  update(id: string, input: UpdateMemberInput): Promise<Member | null>;
  softDelete(id: string): Promise<Member | null>;
  restore(id: string): Promise<Member | null>;
  purge(id: string): Promise<boolean>;
  setPinned(id: string, pinned: boolean): Promise<Member | null>;
  reorder(ids: string[]): Promise<Member[]>;
}
