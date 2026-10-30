import { describe, expect, it } from 'vitest';
import { ExecutorAgentAdapter } from '../../src/adapters/executor-agent.js';
import { AdapterRegistry } from '../../src/adapters/registry.js';
import type { ToolCtx } from '../../src/adapters/types.js';
import { ExecutorService } from '../../src/executor/service.js';
import { MemoryExecutorStore } from '../../src/executor/memory.js';

const audits: string[] = [];
const ctxOf = (userId: string): ToolCtx => ({
  userId,
  audit: async (a, _t, r) => {
    audits.push(`${a}|${r}`);
  },
});
const mk = () => {
  const svc = new ExecutorService(new MemoryExecutorStore(), () => new Date('2026-10-30T00:00:00Z'));
  const a = new ExecutorAgentAdapter(svc, async (u, id) => u === 'u1' && id === 'sec1');
  return { svc, a };
};
const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]?.text ?? '{}') as Record<string, unknown>;

describe('本机执行员适配器', () => {
  it('派任务→查状态→取消；摘要里不含凭据引用', async () => {
    const { a } = mk();
    const r = await a.call('browser_task_create', { kind: 'checkin', site: 'https://example.com', secrets: [{ secretId: 'sec1', field: 'password' }] }, ctxOf('u1'));
    const t = parse(r);
    expect(t.status).toBe('queued');
    expect(JSON.stringify(t)).not.toContain('sec1');
    const s = parse(await a.call('browser_task_status', { taskId: t.taskId }, ctxOf('u1')));
    expect(s.status).toBe('queued');
    const c = parse(await a.call('browser_task_cancel', { taskId: t.taskId }, ctxOf('u1')));
    expect(c.status).toBe('cancelled');
  });

  it('越权：不能引用别人的凭据，也查不到别人的任务', async () => {
    const { a } = mk();
    const bad = await a.call('browser_task_create', { kind: 'login', site: 'https://example.com', secrets: [{ secretId: 'sec1', field: 'password' }] }, ctxOf('u2'));
    expect(bad.isError).toBe(true);
    const t = parse(await a.call('browser_task_create', { kind: 'browse', site: 'https://example.com' }, ctxOf('u1')));
    await expect(a.call('browser_task_status', { taskId: t.taskId }, ctxOf('u2'))).rejects.toThrow();
  });

  it('坏参数：未知类型、坏网址、残缺 secrets 都被拒', async () => {
    const { a } = mk();
    await expect(a.call('browser_task_create', { kind: 'hack', site: 'https://example.com' }, ctxOf('u1'))).rejects.toThrow();
    await expect(a.call('browser_task_create', { kind: 'browse', site: 'file:///etc/passwd' }, ctxOf('u1'))).rejects.toThrow();
    expect((await a.call('browser_task_create', { kind: 'login', site: 'https://example.com', secrets: [{ secretId: 'sec1' }] }, ctxOf('u1'))).isError).toBe(true);
    expect((await a.call('nope', {}, ctxOf('u1'))).isError).toBe(true);
  });

  it('风险分级：带凭据 / 登录 / 注册 = danger（每次确认），普通浏览 = write，查状态 = read', () => {
    const { a } = mk();
    const reg = new AdapterRegistry().add(a);
    expect(reg.riskOf('browser_task_create', { kind: 'browse', site: 'https://x.com' })).toBe('write');
    expect(reg.riskOf('browser_task_create', { kind: 'checkin', secrets: [{ secretId: 'a', field: 'b' }] })).toBe('danger');
    expect(reg.riskOf('browser_task_create', { kind: 'signup' })).toBe('danger');
    expect(reg.riskOf('browser_task_create', { kind: 'login' })).toBe('danger');
    expect(reg.riskOf('browser_task_status', {})).toBe('read');
    expect(reg.riskOf('browser_task_cancel', {})).toBe('write');
  });
});
