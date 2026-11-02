/** #226 复审必改：MCP 只读放行边界的反向测试（直接对 GatewayService，注入假 fetch / 假时钟）。 */
import { describe, expect, it, vi } from 'vitest';
import type { AuditFn } from '../src/audit/types.js';
import { GatewayService, MCP_READ_ONLY_CTX } from '../src/gateway/service.js';
import { WEB_PER_DAY } from '../src/gateway/webfetch.js';
import { MemorySettingsStore, scopedSettings } from '../src/settings/store.js';

const httpTool = (toolId: string, risk = 'read') => ({
  toolId,
  name: toolId,
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'none' },
  allowedHosts: ['api.example.com'],
  risk,
  perDayLimit: 10,
  enabled: true,
});

function setup() {
  const settings = new MemorySettingsStore();
  const fetchImpl = vi.fn(async (_u: unknown) => new Response('hello world', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const confirm = { require: vi.fn(async () => undefined) };
  const tasks = { create: vi.fn() };
  const gw = new GatewayService(
    settings,
    confirm as never,
    () => new Date('2026-11-02T00:00:00Z'),
    tasks as never,
    async () => false,
    async () => null,
    fetchImpl as unknown as typeof fetch,
    async () => ['93.184.216.34'],
  );
  const audits: string[] = [];
  const audit: AuditFn = async (action, _t, outcome, detail) => {
    audits.push(`${action} ${outcome} ${detail ?? ''}`);
  };
  const put = (user: string, defs: unknown[]) => scopedSettings(settings, user).set('gateway.http_tools', defs, new Date());
  return { gw, fetchImpl, confirm, audit, audits, put };
}

describe('MCP 只读放行边界', () => {
  it('★3/4 直接写入的 read 级 HTTP 工具：A 看不到，A 与 B 调用都得到和「不存在」逐字相同的错，HTTP 0 次请求', async () => {
    const t = setup();
    await t.put('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [httpTool('my_read_tool')]);
    expect((await t.gw.listMcpReadable('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).map((x) => x.name)).toEqual(['read_webpage']);
    const grab = async (u: string, tool: string) => {
      try {
        await t.gw.callRead(u, tool, {}, t.audit);
        return 'no-error';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const missing = await grab('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'no_such_tool');
    expect(missing).not.toBe('no-error');
    expect(await grab('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'my_read_tool')).toBe(missing);
    expect(await grab('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'my_read_tool')).toBe(missing);
    expect(t.fetchImpl).not.toHaveBeenCalled();
    expect(t.audits.join('\n')).toContain('mcp: not_exposed');
    expect(t.audits.join('\n')).not.toContain('gateway.call ok');
  });

  it('★1 补：非只读内置工具被拦在 call() 之前（无 gateway.call ok、不建任务）', async () => {
    const t = setup();
    await expect(t.gw.callRead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'browser_task_create', { url: 'https://example.com' }, t.audit)).rejects.toThrow();
    expect(t.audits.join('\n')).toContain('mcp: not_read');
    expect(t.audits.join('\n')).not.toContain('gateway.call ok');
  });

  it('★5 read_webpage 日限额按用户分开：A 用满被拒，B 仍可用', async () => {
    const t = setup();
    for (let i = 0; i < WEB_PER_DAY; i++) {
      const r = await t.gw.callRead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'read_webpage', { url: 'https://example.com/' }, t.audit);
      expect(r.isError).not.toBe(true);
    }
    const over = await t.gw.callRead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'read_webpage', { url: 'https://example.com/' }, t.audit);
    expect(over.isError).toBe(true);
    expect(over.content[0]?.text).toContain('上限');
    const b = await t.gw.callRead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'read_webpage', { url: 'https://example.com/' }, t.audit);
    expect(b.isError).not.toBe(true);
  });

  it('★10 重名 HTTP 工具：list 只出现一次，实际走 WebFetch，HTTP 工具主机 0 次请求', async () => {
    const t = setup();
    await t.put('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [httpTool('read_webpage')]);
    const list = await t.gw.listMcpReadable('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(list.filter((x) => x.name === 'read_webpage')).toHaveLength(1);
    expect((await t.gw.list('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).filter((x) => x.name === 'read_webpage')).toHaveLength(1);
    const r = await t.gw.callRead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'read_webpage', { url: 'https://example.com/page' }, t.audit);
    expect(r.isError).not.toBe(true);
    const urls = t.fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith('https://example.com/'))).toBe(true);
    expect(urls.some((u) => u.includes('api.example.com'))).toBe(false);
  });

  it('★6 MCP 上下文遇到 important 工具：不执行、不生成确认', async () => {
    const t = setup();
    await t.put('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', [httpTool('pay_tool', 'spend')]);
    await expect(t.gw.callRead('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pay_tool', {}, t.audit)).rejects.toThrow();
    expect(MCP_READ_ONLY_CTX.canConfirmImportant).toBe(false);
    expect(t.confirm.require).not.toHaveBeenCalled();
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });
});
