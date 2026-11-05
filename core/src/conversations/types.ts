/**
 * 会话存库（#250 integrate/stage2；checklist F-036 / X-21 / X-27 / X-04b）。
 * 只管聊天会话（conversations.kind = 'chat'）；助手的固定会话（kind = 'assistant'）仍由 /api/assistants 管，这里看不到也写不进。
 * 消息只追加（X-21）：重试 / 编辑都是新增一行，表上的触发器拒绝 UPDATE；会话只归档不删除（删除要所有者定）。
 */

export interface ChatConversation {
  id: string;
  userId: string;
  title: string;
  /** 'aroomo' = 交给负责人（可 @ 点名）；'aroomo/<成员 id>' = 单独和这位成员对话 */
  model: string;
  /** 群聊挑的成员（名字，前端按名字存）；空 = 不是群聊 */
  groupNames: string[];
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Core 生成的结构化部件（目前只有 X-15 助手草稿卡）；imported = 从浏览器本机导入的旧消息 */
export interface ChatMessageMeta {
  draft?: { id: string; data: unknown };
  imported?: true;
}

export interface ChatMessage {
  id: string;
  /** 库里生成（全局自增）：会话内顺序与分页游标；写入时不用填 */
  seq?: number;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  meta: ChatMessageMeta | null;
  createdAt: Date;
}

export interface ConversationSummary {
  conversation: ChatConversation;
  /** 有 read_at 之后的回复（不算自己说的话） */
  unread: boolean;
  messageCount: number;
  last: { role: ChatMessage['role']; content: string; createdAt: Date } | null;
}

export interface ListQuery {
  archived: boolean;
  unreadOnly: boolean;
  /** 只要这些 id（「进行中」筛选）；不给 = 不限 */
  ids?: string[];
  limit: number;
  /** 游标：上一页最后一行的 (updatedAt, id) */
  before?: { updatedAt: Date; id: string };
}

export type CreateResult = 'ok' | 'exists' | 'conflict';

/**
 * 存储：每个方法都带 userId，只读写这个账号的行（PG 实现每个事务开头设 app.user_id，D206 RLS）。
 * 只认 kind = 'chat' 的会话：助手会话的 id 当作不存在。
 */
export interface ConversationStore {
  list(userId: string, q: ListQuery): Promise<ConversationSummary[]>;
  get(userId: string, id: string): Promise<ChatConversation | null>;
  /** 同一账号已有同 id 的聊天会话 → 'exists'（不改）；id 被别的会话占用（别的账号 / 助手会话）→ 'conflict' */
  create(userId: string, c: ChatConversation, messages?: ChatMessage[]): Promise<CreateResult>;
  update(userId: string, id: string, patch: Partial<Pick<ChatConversation, 'title' | 'archivedAt' | 'readAt'>>): Promise<ChatConversation | null>;
  /** 追加一条消息并把会话的 updated_at 设成消息时间；会话不存在 / 不是本账号的聊天会话 → null */
  append(userId: string, m: ChatMessage): Promise<ChatMessage | null>;
  /** 按 seq 分页：afterSeq = 往后（升序）；beforeSeq = 往前（取最近的 limit 条，仍按升序返回）；都不给 = 最近的 limit 条 */
  messages(userId: string, conversationId: string, q: { limit: number; afterSeq?: number; beforeSeq?: number }): Promise<ChatMessage[]>;
}

export const TITLE_MAX = 200;
export const CONTENT_MAX = 50_000;
