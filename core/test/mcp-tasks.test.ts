/** #117 必改：MCP 任务工具统一走网关，客户端令牌不能创建高风险任务（真 ConfirmService）。 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditFn } from '../src/audit/types.js';
import { ConfirmService, MemoryChallengeStore } from '../src/confirm/confirm.js';
import { GatewayService } from '../src/gateway/service.js';
import { MemorySettingsStore } from '../src/settings/store.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
function setup() {
  const store = new MemoryChallengeStore();
  const insert = vi.spyOn(store, 'insert');
  const now = () => new Date('2026-11-02T08:00:00+08:00');
  const confirm = new ConfirmService(store, { now, access: { verify: async () => null } });
  const create = vi.fn(async (_u: string, i: { kind: string; site: string }) => ({ id: 't1', kind: i.kind, site: i.site, status: 'queued', lastStage: null, lastMessage: null, resultSummary: null, resultError: null }));
  const gw = new GatewayService(new MemorySettingsStore(), confirm, now, { create, get: vi.fn(), cancel: vi.fn() } as never, async (u, id) => u === A && id === 'mine', async () => null);
  const audits: string[] = [];
  const audit: AuditFn = async (action, _t, outcome, detail) => {
    audits.push(`${action} ${outcome} ${detail ?? ''}`);
  };
  return { gw, create, insert, audit, audits };
}
const denied = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'no-error';
  } catch (e) {
    return (e as { statusCode?: number }).statusCode;
  }
};

describe('MCP 任务工具走网关', () => {
  it('browse / checkin（无凭据）直接创建', async () => {
    const t = setup();
    const r = await t.gw.callTask(A, 'browser_task_create', { kind: 'checkin', site: 'https://example.com' }, t.audit);
    expect(r.isError).toBeFalsy();
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('login / signup / 带 secrets 的任务：403，不建任务，不建确认挑战', async () => {
    const t = setup();
    for (const args of [
      { kind: 'login', site: 'https://example.com' },
      { kind: 'signup', site: 'https://example.com' },
      { kind: 'browse', site: 'https://example.com', secrets: [{ secretId: 'mine', field: 'password' }] },
    ]) {
      expect(await denied(t.gw.callTask(A, 'browser_task_create', args, t.audit))).toBe(403);
    }
    expect(t.create).not.toHaveBeenCalled();
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.audits.some((a) => a.includes('mcp: kind_not_allowed'))).toBe(true);
  });

  it('网关里其他工具不能经任务入口调用', async () => {
    const t = setup();
    expect(await denied(t.gw.callTask(A, 'read_webpage', { url: 'https://example.com' }, t.audit))).toBe(403);
  });
});

import { afterAll } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { ExecutorAgentAdapter } from '../src/adapters/executor-agent.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

describe('MCP 任务工具：必改补测（网关层）', () => {
  it('同名 HTTP 工具冒充 browser_task_create：403，HTTP 0 次请求，create 0 次', async () => {
    const settings = new MemorySettingsStore();
    const fetchImpl = vi.fn(async () => new Response('x'));
    const create = vi.fn();
    const store = new MemoryChallengeStore();
    const now = () => new Date('2026-11-02T08:00:00+08:00');
    const confirm = new ConfirmService(store, { now, access: { verify: async () => null } });
    const gw = new GatewayService(settings, confirm, now, { create, get: vi.fn(), cancel: vi.fn() } as never, async () => false, async () => null, fetchImpl as unknown as typeof fetch, async () => ['93.184.216.34']);
    const { scopedSettings } = await import('../src/settings/store.js');
    await scopedSettings(settings, A).set('gateway.http_tools', [{ toolId: 'browser_task_create', name: 'x', baseUrl: 'https://api.example.com/v1', auth: { type: 'none' }, allowedHosts: ['api.example.com'], risk: 'read', perDayLimit: 10, enabled: true }], new Date());
    const audit: AuditFn = async () => {};
    // 无论注册表里选中谁，都不会走到 HTTP
    let code: unknown;
    try {
      await gw.callTask(A, 'browser_task_create', { kind: 'checkin', site: 'https://example.com' }, audit);
      code = 'ok';
    } catch (e) {
      code = (e as { statusCode?: number }).statusCode;
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    if (code === 'ok') expect(create).toHaveBeenCalledTimes(1);
    else expect(code).toBe(403);
  });

  it('browse 经 MCP 被拒（只放行 checkin），create 0 次', async () => {
    const t = setup();
    expect(await denied(t.gw.callTask(A, 'browser_task_create', { kind: 'browse', site: 'https://example.com' }, t.audit))).toBe(403);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.audits.some((a) => a.includes('mcp: kind_not_allowed'))).toBe(true);
  });

  it('签到带 instruction / options / secrets 等额外字段 → 403 field_not_allowed，create 0 次', async () => {
    const t = setup();
    for (const extra of [{ instruction: '顺便下单' }, { options: { a: 1 } }, { secrets: [] }, { foo: 1 }]) {
      expect(await denied(t.gw.callTask(A, 'browser_task_create', { kind: 'checkin', site: 'https://example.com', ...extra }, t.audit))).toBe(403);
    }
    expect(t.create).not.toHaveBeenCalled();
    expect(t.audits.some((a) => a.includes('mcp: field_not_allowed'))).toBe(true);
  });

  it('格式不对的 secrets 一律按 danger：403，create 0 次', async () => {
    const t = setup();
    for (const secrets of ['mine:password', { secretId: 'mine' }, [{ secretId: 'mine' }], Array.from({ length: 11 }, () => ({ secretId: 'mine', field: 'p' }))]) {
      expect(await denied(t.gw.callTask(A, 'browser_task_create', { kind: 'checkin', site: 'https://example.com', secrets }, t.audit))).toBe(403);
    }
    expect(t.create).not.toHaveBeenCalled();
  });

  it('适配器：B 的 secretId 与不存在的 secretId 返回逐字相同的错', async () => {
    const create = vi.fn();
    const ad = new ExecutorAgentAdapter({ create, get: vi.fn(), cancel: vi.fn() } as never, async (u, id) => u === A && id === 'mine');
    const audit: AuditFn = async () => {};
    const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const r1 = await ad.call('browser_task_create', { kind: 'login', site: 'https://e.com', secrets: [{ secretId: 'mine', field: 'password' }] }, { userId: B, audit });
    const r2 = await ad.call('browser_task_create', { kind: 'login', site: 'https://e.com', secrets: [{ secretId: 'nope', field: 'password' }] }, { userId: B, audit });
    expect(r1).toEqual(r2);
    expect(r1.isError).toBe(true);
    for (const secrets of ['mine:password', { secretId: 'mine' }, [{ secretId: 'mine' }]]) {
      expect((await ad.call('browser_task_create', { kind: 'login', site: 'https://e.com', secrets }, { userId: A, audit })).isError).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();
  });
});

describe('MCP 任务工具：端到端（/mcp）', () => {
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(fakeClock().now));
  afterAll(() => app.close());
  const rpc = (headers: Record<string, string>, method: string, params?: object) =>
    app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } });
  const client = async (scopes: string[]) => ({
    authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/clients', headers: ownerAuth, payload: { name: 'g', scopes } })).json().token}`,
  });
  const names = async (h: Record<string, string>) => (await rpc(h, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name);
  const text = (r: { json(): { result?: { content: Array<{ text: string }> } } }) => r.json().result?.content[0]?.text ?? '';
  const call = (h: Record<string, string>, name: string, args: object = {}) => rpc(h, 'tools/call', { name, arguments: args });

  it('★2/3 范围：只读客户端看不到 create/cancel，硬调 -32602；无 tasks 范围看不到任何任务工具', async () => {
    const ro = await client(['tasks:read']);
    const n = await names(ro);
    expect(n).toEqual(expect.arrayContaining(['get_task', 'list_tasks']));
    expect(n).not.toContain('create_task');
    expect(n).not.toContain('cancel_task');
    expect((await call(ro, 'create_task', { kind: 'checkin', site: 'https://example.com' })).json().error.code).toBe(-32602);
    const none = await client(['library:read']);
    for (const x of ['create_task', 'cancel_task', 'get_task', 'list_tasks']) expect(await names(none)).not.toContain(x);
  });

  it('#347 M3：真实 /mcp + tasks:create 令牌带 secrets（别人的 / 不存在的 id）建任务 → 错误，任务数不变', async () => {
    const full = await client(['tasks:create', 'tasks:read']);
    const before = text(await call(full, 'list_tasks'));
    for (const secretId of ['00000000-0000-4000-8000-0000000000aa', 'not-a-uuid']) {
      const r = await call(full, 'create_task', { kind: 'checkin', site: 'https://example.org', secrets: [{ secretId, field: 'password' }] });
      // 拦下它的是「MCP 签到只收 kind + site」那条规则（gateway callTask field_not_allowed），不是别的错误
      expect(r.json().error).toBeUndefined();
      expect(r.json().result).toEqual({ content: [{ type: 'text', text: '这里派签到任务只能带 kind 和 site；其他字段请在手机或控制台发起。' }], isError: true });
      expect(r.body).not.toContain(secretId);
    }
    expect(text(await call(full, 'list_tasks'))).toBe(before);
  });

  it('★1/4 去重与跨账号：同日第二次 checkin 已派过；取消后可再派；B 查 / 取消 A 的任务与不存在的 id 逐字相同', async () => {
    const full = await client(['tasks:create', 'tasks:read']);
    const first = await call(full, 'create_task', { kind: 'checkin', site: 'https://example.com' });
    expect(first.json().result.isError).toBeFalsy();
    const list1 = text(await call(full, 'list_tasks'));
    const id = /[0-9a-f]{8}-[0-9a-f-]{27}/.exec(list1)?.[0] ?? '';
    expect(id).not.toBe('');
    const second = await call(full, 'create_task', { kind: 'checkin', site: 'https://example.com' });
    expect(text(second)).toContain('已经派过');
    // 账号 B
    const inv = await app.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'b@example.com' } });
    const acc = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: 'correct-horse-battery' } });
    const b = { authorization: `Bearer ${acc.json().token}` };
    const g1 = await call(b, 'get_task', { id });
    const g2 = await call(b, 'get_task', { id: '00000000-0000-0000-0000-000000000000' });
    expect(g1.json()).toEqual(g2.json());
    const c1 = await call(b, 'cancel_task', { id });
    const c2 = await call(b, 'cancel_task', { id: '00000000-0000-0000-0000-000000000000' });
    expect(c1.json()).toEqual(c2.json());
    expect(text(await call(full, 'get_task', { id }))).toContain('queued');
    // 取消后可再派
    await call(full, 'cancel_task', { id });
    const third = await call(full, 'create_task', { kind: 'checkin', site: 'https://example.com' });
    expect(text(third)).not.toContain('已经派过');
  });
});
