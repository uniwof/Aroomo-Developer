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
  const now = () => new Date('Mon 2026-11-02 8:00 AM CST (UTC+08:00)');
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
    expect(t.audits.some((a) => a.startsWith('confirm.denied'))).toBe(true);
  });

  it('网关里其他工具不能经任务入口调用', async () => {
    const t = setup();
    expect(await denied(t.gw.callTask(A, 'read_webpage', { url: 'https://example.com' }, t.audit))).toBe(403);
  });
});
