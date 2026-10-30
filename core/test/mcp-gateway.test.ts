/** Core /mcp 暴露工具网关（A 类：外部入口只放 read / write 级；spend / danger 一律拒绝并指向 Aroomo 确认）。 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

const VAULT_KEY = randomBytes(32).toString('base64');

describe('MCP × 工具网关', () => {
  const clock = fakeClock();
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', VAULT_KEY }), memoryDeps(clock.now));
  afterAll(() => app.close());

  const owner = (method: string, url: string, payload?: object) => app.inject({ method: method as 'POST', url, headers: ownerAuth, ...(payload ? { payload } : {}) });
  const rpc = (headers: Record<string, string>, method: string, params?: object) =>
    app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) } });
  const clientHeaders = async (scopes: string[]) => ({ authorization: `Bearer ${(await owner('POST', '/api/clients', { name: 'c', scopes })).json().token}` });
  const names = async (h: Record<string, string>) => (await rpc(h, 'tools/list')).json().result.tools.map((t: { name: string }) => t.name) as string[];
  const taskCount = async () => (await owner('GET', '/api/tasks')).json().tasks.length as number;

  async function registerSpendTool() {
    const def = {
      def: { toolId: 'paid_search', name: '付费搜索', baseUrl: 'https://api.example.com/v1', auth: { type: 'none' }, allowedHosts: ['api.example.com'], risk: 'spend', perDayLimit: 10, enabled: true },
    };
    const send = (confirmToken?: string) => owner('PUT', '/api/gateway/http-tools', { ...def, ...(confirmToken ? { confirmToken } : {}) });
    const first = await send();
    expect(first.statusCode).toBe(428);
    const ch = first.json().error.confirm;
    await owner('POST', ch.stepUrl, { step: 1 });
    clock.advance(3000);
    const s2 = await owner('POST', ch.stepUrl, { step: 2 });
    expect((await send(s2.json().confirmToken)).statusCode).toBe(200);
  }

  it('没有 tools:call 范围：看不到网关工具，调用表现为不存在', async () => {
    const lib = await clientHeaders(['library:read']);
    expect((await names(lib)).some((n) => n === 'read_webpage' || n.startsWith('browser_task'))).toBe(false);
    const r = await rpc(lib, 'tools/call', { name: 'browser_task_create', arguments: { kind: 'checkin', site: 'https://example.com/' } });
    expect(r.json().error.code).toBe(-32602);
    expect(await taskCount()).toBe(0);
  });

  it('有 tools:call：列出 read / write 级工具并能调用（派任务）', async () => {
    const h = await clientHeaders(['tools:call']);
    const n = await names(h);
    expect(n).toEqual(expect.arrayContaining(['read_webpage', 'browser_task_create', 'browser_task_status', 'browser_task_cancel']));
    const r = await rpc(h, 'tools/call', { name: 'browser_task_create', arguments: { kind: 'checkin', site: 'https://example.com/' } });
    expect(r.json().result.isError).toBeFalsy();
    expect(await taskCount()).toBe(1);
  });

  it('带凭据的任务（danger）从 MCP 调用被拒，不建任务、不产生确认挑战', async () => {
    for (const h of [ownerAuth, await clientHeaders(['tools:call'])]) {
      const r = await rpc(h, 'tools/call', {
        name: 'browser_task_create',
        arguments: { kind: 'login', site: 'https://example.com/', secrets: [{ secretId: '11111111-1111-4111-8111-111111111111', field: 'password' }] },
      });
      const res = r.json().result;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('控制台');
    }
    expect(await taskCount()).toBe(1);
  });

  it('花钱的 HTTP 工具：不出现在 MCP 列表，调用被拒（所有者也一样）；网关接口里仍在', async () => {
    await registerSpendTool();
    const h = await clientHeaders(['tools:call']);
    expect(await names(h)).not.toContain('paid_search');
    expect(await names(ownerAuth)).not.toContain('paid_search');
    const r = await rpc(ownerAuth, 'tools/call', { name: 'paid_search', arguments: {} });
    expect(r.json().result.isError).toBe(true);
    expect(r.json().result.content[0].text).toContain('控制台');
    const gw = (await owner('GET', '/api/gateway/tools')).json().tools.map((t: { name: string }) => t.name);
    expect(gw).toContain('paid_search');
    const audit = JSON.stringify((await owner('GET', '/api/audit?limit=50')).json());
    expect(audit).toContain('mcp.call');
  });
});
