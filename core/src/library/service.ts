import { randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { badRequest, notFound } from '../http/errors.js';
import { looksSensitive } from '../settings/security.js';
import { BODY_MAX, LIBRARY_KINDS, type LibraryItem, type LibraryKind, type LibraryStore, splitTerms, TITLE_MAX } from './types.js';

export interface AddInput {
  kind?: LibraryKind;
  title?: string;
  url?: string;
  body?: string;
  tags?: string[];
  source?: string;
}

function cleanUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw badRequest('链接格式不对（要以 http:// 或 https:// 开头）', 'INVALID_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('只收 http / https 链接', 'INVALID_URL');
  if (u.username || u.password) throw badRequest('链接里不能带账号密码', 'INVALID_URL');
  u.hash = '';
  return u.toString();
}

export class LibraryService {
  constructor(
    private readonly store: LibraryStore,
    private readonly now: () => Date,
  ) {}

  /** 丢链接：只给 url 也行（标题默认用域名）；用途不明默认归为 link（D163） */
  async add(userId: string, input: AddInput, audit: AuditFn): Promise<{ item: LibraryItem; existed: boolean }> {
    const url = input.url ? cleanUrl(input.url) : null;
    const body = input.body ?? '';
    if (!url && !body.trim() && !input.title?.trim()) throw badRequest('至少给一个链接、标题或内容', 'EMPTY_ITEM');
    if (body.length > BODY_MAX) throw badRequest(`内容太长（最多 ${BODY_MAX} 字）`, 'BODY_TOO_LONG');
    const title = (input.title?.trim() || (url ? new URL(url).hostname : body.trim().slice(0, 40))).slice(0, TITLE_MAX);
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim().replace(/,/g, '，')).filter(Boolean))].slice(0, 10);
    if (tags.some((t) => t.length > 40)) throw badRequest('单个标签最多 40 字', 'INVALID_TAG');
    const kind = input.kind ?? (url ? 'link' : 'idea');
    if (!LIBRARY_KINDS.includes(kind)) throw badRequest('不认识的类型', 'INVALID_KIND');
    // 资源库会被成员和外部客户端检索：像密码 / Key / 卡号的内容不让存（D199 红线 1）
    if ([title, body, url ?? '', ...tags].some(looksSensitive)) {
      await audit('library.add', { type: 'library', id: '-' }, 'denied', '疑似敏感信息');
      throw badRequest('内容里像是有密码、Key 或证件号，资源库不能存这些', 'SENSITIVE_CONTENT');
    }
    const at = this.now();
    const res = await this.store.add(userId, { id: randomUUID(), kind, title, url, body, tags, source: input.source ?? 'manual', createdAt: at, updatedAt: at });
    await audit('library.add', { type: 'library', id: res.item.id }, 'ok', res.existed ? '已存在' : kind);
    return res;
  }

  async get(userId: string, id: string): Promise<LibraryItem> {
    const it = await this.store.get(userId, id);
    if (!it) throw notFound('找不到这条资源');
    return it;
  }

  /** q 为空 = 最近收的；否则关键词检索（多个词都要命中） */
  list(userId: string, opts: { q?: string; kind?: LibraryKind; limit?: number }): Promise<LibraryItem[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const terms = splitTerms(opts.q ?? '');
    const o = { ...(opts.kind ? { kind: opts.kind } : {}), limit };
    return terms.length ? this.store.search(userId, terms, o) : this.store.list(userId, o);
  }

  async delete(userId: string, id: string, audit: AuditFn): Promise<void> {
    if (!(await this.store.delete(userId, id))) throw notFound('找不到这条资源');
    await audit('library.delete', { type: 'library', id }, 'ok');
  }
}
