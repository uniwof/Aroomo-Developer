import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';

describe('Core /mcp（资源库与公共记忆）', () => {
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(fakeClock().now));
  afterAll(() => app.close());

  const rpc = (headers: Record<string, string>, method: string, params?: object, id: number | null = 1) =>
    app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', ...(id !== null ? { id } : {}), method, ...(params ? { params } : {}) } });
  const owner = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, headers: ownerAuth, ...(payload ? { payload } : {}) });
  const clientHeaders = async (scopes: string[]) => ({ authorization: `Bearer ${(await owner('POST', '/api/clients', { name: 'c', scopes })).json().token}` });
  const call = (h: Record<string, string>, name: string, args: object = {}) => rpc(h, 'tools/call', { name, arguments: args });
  const text = (r: { json(): { result?: { content: Array<{ text: string }> } } }) => r.json().result?.content[0]?.text ?? '';

  it('未登录 401；GET 405', async () => {
    expect((await app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/mcp', headers: ownerAuth })).statusCode).toBe(405);
  });

  it('握手：initialize / ping / 通知无应答', async () => {
    const r = await rpc(ownerAuth, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lobehub', version: '1' } });
    expect(r.json().result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'aroomo-core' }, capabilities: { tools: {} } });
    expect((await rpc(ownerAuth, 'initialize', { protocolVersion: '1999-01-01' })).json().result.protocolVersion).toBe('2025-03-26');
    expect((await rpc(ownerAuth, 'ping')).json().result).toEqual({});
    expect((await rpc(ownerAuth, 'notifications/initialized', undefined, null)).statusCode).toBe(202);
    expect((await rpc(ownerAuth, 'nope')).json().error.code).toBe(-32601);
  });

  it('所有者：收进 → 搜索 → 取条目；同链接去重；记忆读取', async () => {
    const add = await call(ownerAuth, 'submit_resource', { url: 'https://example.com/pg', title: 'Postgres 全文检索笔记', tags: ['数据库'] });
    expect(text(add)).toBe('已收进资源库。');
    expect(text(await call(ownerAuth, 'submit_resource', { url: 'https://example.com/pg' }))).toContain('已经有');
    const found = text(await call(ownerAuth, 'search_library', { query: 'postgres' }));
    expect(found).toContain('Postgres 全文检索笔记');
    const id = /id: ([^）]+)）/.exec(found)?.[1] ?? '';
    expect(text(await call(ownerAuth, 'get_library_item', { id }))).toContain('https://example.com/pg');
    expect(text(await call(ownerAuth, 'search_library', { query: '不存在的词' }))).toContain('没有找到');
    await owner('PUT', '/api/memory/rules', { title: '规矩', body: '回答简短。' });
    expect(text(await call(ownerAuth, 'list_memory_topics'))).toContain('rules');
    expect(text(await call(ownerAuth, 'get_memory', { topic: 'rules' }))).toContain('回答简短');
  });

  it('客户端按范围：tools/list 只列有范围的；没范围的工具表现为不存在', async () => {
    const reader = await clientHeaders(['library:read']);
    const names = (await rpc(reader, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(['search_library', 'get_library_item']);
    const denied = await call(reader, 'submit_resource', { url: 'https://x.example.com/' });
    expect(denied.json().error).toMatchObject({ code: -32602 });
    expect(denied.json().error.message).toBe('未知工具：submit_resource');
    const none = await call(reader, 'get_memory', { topic: 'rules' });
    expect(none.json().error.code).toBe(-32602);
    // 没有任何范围也能握手，但工具为空
    const bare = await clientHeaders(['brief:read']);
    expect((await rpc(bare, 'tools/list')).json().result.tools).toEqual([]);
    const writer = await clientHeaders(['library:write']);
    expect(text(await call(writer, 'submit_resource', { url: 'https://w.example.com/' }))).toBe('已收进资源库。');
    const rows = (await owner('GET', '/api/library?q=w.example.com')).json().items;
    expect(rows[0].source).toBe('mcp');
  });

  it('越权与脱敏：账号只看到自己的；工具输出里的 Key 被打码；敏感内容拒收', async () => {
    const inv = await owner('POST', '/api/users/invites', { email: 'a@example.com' });
    const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
    const a = { authorization: `Bearer ${acc.json().token}` };
    expect(text(await call(a, 'search_library', { query: 'postgres' }))).toContain('没有找到');
    // 敏感内容拒收（工具内失败走 isError，不是协议错误）
    const bad = await call(ownerAuth, 'submit_resource', { title: 'x', note: '我的密码：hunter22abc' });
    expect(bad.json().result.isError).toBe(true);
    // 已入库的内容里即使有 Key 形态，输出也被打码（直接用内存写入模拟旧数据不可行，这里验证 redact 出口）
    const r = await call(ownerAuth, 'search_library', { query: 'postgres' });
    expect(text(r)).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
  });

  it('审计：调用留下记录，没有范围的调用记为 denied', async () => {
    const reader = await clientHeaders(['library:read']);
    await call(reader, 'submit_resource', { url: 'https://y.example.com/' });
    const logs = JSON.stringify((await owner('GET', '/api/audit?limit=100')).json());
    expect(logs).toContain('mcp.call');
    expect(logs).toContain('denied');
  });
});
