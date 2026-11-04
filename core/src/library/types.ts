/** 资源库（D163，M2 最小版）：文章、技能、方法、素材、工具线索、链接、点子。 */
export const LIBRARY_KINDS = ['article', 'skill', 'method', 'material', 'tool', 'link', 'idea'] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
export const BODY_MAX = 20_000;
export const TITLE_MAX = 200;

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  title: string;
  url: string | null;
  body: string;
  /** 标签，逗号分隔存储，对外是数组 */
  tags: string[];
  /** manual 手动 · mcp 外部客户端 submit_resource · import 导入 */
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LibraryStore {
  /** 同一用户同一链接已存在时返回已有条目（existed=true），不重复入库 */
  add(userId: string, item: LibraryItem): Promise<{ item: LibraryItem; existed: boolean }>;
  get(userId: string, id: string): Promise<LibraryItem | null>;
  list(userId: string, opts: { kind?: LibraryKind; limit: number }): Promise<LibraryItem[]>;
  /** 关键词检索：标题 > 标签 > 链接 > 正文，多个词都要命中（大小写不敏感） */
  search(userId: string, terms: string[], opts: { kind?: LibraryKind; limit: number }): Promise<LibraryItem[]>;
  delete(userId: string, id: string): Promise<boolean>;
}

/** 检索词切分：按空白切，最多 8 个词，去重 */
export function splitTerms(q: string): string[] {
  return [...new Set(q.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/** 命中打分（内存实现和测试用；PG 实现用同样的权重） */
export function scoreItem(it: Pick<LibraryItem, 'title' | 'tags' | 'url' | 'body'>, terms: string[]): number {
  const t = it.title.toLowerCase();
  const g = it.tags.join(',').toLowerCase();
  const u = (it.url ?? '').toLowerCase();
  const b = it.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const s = (t.includes(term) ? 8 : 0) + (g.includes(term) ? 4 : 0) + (u.includes(term) ? 2 : 0) + (b.includes(term) ? 1 : 0);
    if (s === 0) return 0; // 每个词都要命中
    score += s;
  }
  return score;
}
