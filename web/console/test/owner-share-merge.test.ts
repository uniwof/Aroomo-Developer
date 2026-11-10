/**
 * #293（负责人 #288 裁定）：从 Shell 打开时直接问 Core「是谁」（同源 GET /api/auth/me，Shell 白名单直通，只带会话 Cookie），
 * 拿到账号自己的 id；以前存在 'owner' 那份的本机会话一次性并进所有者账号那份（按会话 id 去重，'owner' 那份保留）。
 * 假 fetch，占位数据。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConversations, mergeOwnerShare, saveConversations, type Conversation } from '@/chat/store';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const OWNER = 'u-owner-1';
const KID = 'u-kid-2';
const conv = (id: string, title: string, at = 2, texts = 2): Conversation => ({
  id,
  title,
  model: 'aroomo',
  messages: [{ role: 'user', text: `${title}的问题`, at: 1 }, ...(texts > 1 ? [{ role: 'assistant' as const, text: '回答' }] : [])],
  updatedAt: at,
});

describe('#293 mergeOwnerShare：owner 那份并进账号那份', () => {
  beforeEach(() => localStorage.clear());

  it('按会话 id 去重并入；owner 那份保留不删；账号那份已有的 id 不动', () => {
    saveConversations([conv('a', 'A-owner', 5), conv('b', 'B-owner', 4)], 'owner');
    saveConversations([conv('b', 'B-mine', 9), conv('c', 'C-mine', 3)], OWNER);
    expect(mergeOwnerShare(OWNER)).toBe(1);
    const mine = loadConversations(OWNER);
    expect(mine.map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
    expect(mine.find((c) => c.id === 'b')!.title).toBe('B-mine');
    expect(loadConversations('owner').map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('只并一次：并完再有新的 owner 会话也不再并（记号按账号）', () => {
    saveConversations([conv('a', 'A', 5)], 'owner');
    expect(mergeOwnerShare(OWNER)).toBe(1);
    saveConversations([conv('a', 'A', 5), conv('z', 'Z', 6)], 'owner');
    expect(mergeOwnerShare(OWNER)).toBe(0);
    expect(loadConversations(OWNER).map((c) => c.id)).toEqual(['a']);
  });

  it('不把别的账号那份并进来；也不会并进 owner 自己或非法账号', () => {
    saveConversations([conv('k', 'K', 5)], KID);
    saveConversations([conv('a', 'A', 5)], 'owner');
    expect(mergeOwnerShare('owner')).toBe(0);
    expect(mergeOwnerShare('bad id/..')).toBe(0);
    expect(loadConversations(OWNER)).toEqual([]);
    expect(loadConversations(KID).map((c) => c.id)).toEqual(['k']);
  });

  it('没有 owner 那份（或只有空会话）：什么都不并，不报错', () => {
    saveConversations([{ ...conv('e', '空', 5), messages: [] }], 'owner');
    expect(mergeOwnerShare(OWNER)).toBe(0);
    expect(loadConversations(OWNER)).toEqual([]);
  });

  it('放不下（超过 200 段上限）：不写、不记号，owner 那份原样', () => {
    const many = Array.from({ length: 200 }, (_, i) => conv(`m${i}`, `M${i}`, i + 1));
    saveConversations(many, OWNER);
    saveConversations([conv('a', 'A', 999)], 'owner');
    expect(mergeOwnerShare(OWNER)).toBe(0);
    expect(loadConversations(OWNER)).toHaveLength(200);
    expect(loadConversations(OWNER).some((c) => c.id === 'a')).toBe(false);
    // 腾出位置后下次能并（没记号）
    saveConversations(many.slice(0, 10), OWNER);
    expect(mergeOwnerShare(OWNER)).toBe(1);
  });

  it('存满写不进：返回 0、不记号、不抛', () => {
    saveConversations([conv('a', 'A', 5)], 'owner');
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(mergeOwnerShare(OWNER)).toBe(0);
    vi.restoreAllMocks();
    Storage.prototype.setItem = real;
    expect(loadConversations(OWNER)).toEqual([]);
    expect(mergeOwnerShare(OWNER)).toBe(1);
  });
});

describe('#293 从 Shell 打开：fetchAccount 先直接问 Core', () => {
  let meta: HTMLMetaElement;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    meta = document.createElement('meta');
    meta.name = 'aroomo-shell';
    meta.content = '1';
    document.head.appendChild(meta);
    vi.resetModules();
  });
  afterEach(() => {
    meta.remove();
    vi.unstubAllGlobals();
  });

  const load = async () => import('@/lib/api');

  it('所有者：拿到自己的账号 id + owner=true，请求走同源 /api/auth/me、不带 Authorization', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return url === '/api/auth/me' ? json({ kind: 'user', ownerAccount: true, user: { id: OWNER, email: 'o@example.test', role: 'owner' } }) : json({ kind: 'owner', id: 'owner' });
    });
    const { fetchAccount, viaShell } = await load();
    expect(viaShell).toBe(true);
    expect(await fetchAccount(f as unknown as typeof fetch)).toEqual({ id: OWNER, owner: true });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('/api/auth/me');
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
    expect(init!.method).toBe('GET');
  });

  it('家人：回家人自己的 id，owner=false，不会得到 owner 那份', async () => {
    const f = vi.fn(async () => json({ kind: 'user', ownerAccount: false, user: { id: KID, email: 'k@example.test', role: 'user' } }));
    const { fetchAccount } = await load();
    expect(await fetchAccount(f as unknown as typeof fetch)).toEqual({ id: KID, owner: false });
  });

  it('直通问不到（401 / 404 / 不是 JSON）：退回主人令牌那条老路，得到 owner；401 不把人踢出登录', async () => {
    for (const direct of [() => json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401), () => json({ error: 'nope' }, 404), () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })]) {
      vi.resetModules();
      const f = vi.fn(async (url: string) => (url === '/api/auth/me' ? direct() : json({ kind: 'owner', id: 'owner' })));
      const { fetchAccount, session, COOKIE_SESSION } = await load();
      session.set(COOKIE_SESSION);
      expect(await fetchAccount(f as unknown as typeof fetch)).toEqual({ id: 'owner', owner: true });
      expect(f.mock.calls.map((c) => c[0])).toEqual(['/api/auth/me', '/aroomo/api/auth/me']);
      expect(session.token).toBe(COOKIE_SESSION);
    }
  });

  it('直通回了别的形状（kind=owner / 没有账号 id）：不当账号用', async () => {
    const f = vi.fn(async (url: string) => (url === '/api/auth/me' ? json({ kind: 'user', user: {} }) : json({ error: { code: 'X', message: 'x' } }, 500)));
    const { fetchAccount } = await load();
    expect(await fetchAccount(f as unknown as typeof fetch)).toBeNull();
  });
});
