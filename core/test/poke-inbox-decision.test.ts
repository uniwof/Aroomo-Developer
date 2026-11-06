/** Poke §8 决定卡：发起者（Core 填，不能冒充）、影响范围、拒绝理由（docs/api/design-poke-data-v1.md）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { openPglite } from './helpers/db.js';
import { type TwoAccounts, twoAccountEnvs, twoAccounts } from './helpers/two-accounts.js';

const DOWN = fileURLToPath(new URL('../migrations/down/', import.meta.url));

describe.each(twoAccountEnvs)('收件箱决定卡字段（$name）', (env) => {
  let t: TwoAccounts;
  beforeEach(async () => {
    t = await twoAccounts(env);
  });
  afterEach(async () => {
    await t.close();
  });

  const post = (body: Record<string, unknown>) =>
    t.owner('POST', '/api/inbox', { group: 'decision', kind: 'test.decide', title: '删掉旧配置', related: { type: 'cfg', id: 'c1' }, actions: [{ id: 'approve', label: '同意' }, { id: 'reject', label: '拒绝' }], ...body });

  it('发卡：发起者按调用者令牌填（请求体里的 actor 被拒），影响范围原样存', async () => {
    expect((await post({ actor: { type: 'assistant', name: '冒充' } })).statusCode).toBe(400);
    const r = await post({ impact: ['配置：旧的 MCP 地址', '  ', '影响：家人账号'] });
    expect(r.statusCode).toBe(201);
    expect(r.json().item).toMatchObject({ actor: { type: 'owner', name: '所有者' }, impact: ['配置：旧的 MCP 地址', '影响：家人账号'] });
    const listed = (await t.owner('GET', '/api/inbox?group=decision')).json().items[0];
    expect(listed).toMatchObject({ actor: { type: 'owner' }, impact: ['配置：旧的 MCP 地址', '影响：家人账号'] });
    expect((await post({ related: { type: 'cfg', id: 'c2' }, impact: Array.from({ length: 11 }, (_, i) => `第${i}条`) })).statusCode).toBe(400);
  });

  it('拒绝可带理由，处理后读得到；空理由不记；忽略也能带理由', async () => {
    const id = (await post({})).json().item.id as string;
    const r = await t.owner('POST', `/api/inbox/${id}/actions/reject`, { reason: '  还要用  ' });
    expect(r.statusCode).toBe(200);
    expect(r.json().item).toMatchObject({ status: 'done', resolvedAction: 'reject', resolvedNote: '还要用' });
    const all = (await t.owner('GET', '/api/inbox?group=decision&status=done')).json().items as Array<{ id: string; resolvedNote?: string }>;
    expect(all.find((i) => i.id === id)?.resolvedNote).toBe('还要用');
    const id2 = (await post({ related: { type: 'cfg', id: 'c3' } })).json().item.id as string;
    expect((await t.owner('POST', `/api/inbox/${id2}/actions/approve`, { reason: '   ' })).json().item.resolvedNote).toBeUndefined();
    const id3 = (await post({ related: { type: 'cfg', id: 'c4' } })).json().item.id as string;
    expect((await t.owner('POST', `/api/inbox/${id3}/dismiss`, { reason: '不相关' })).json().item).toMatchObject({ status: 'dismissed', resolvedNote: '不相关' });
    const id4 = (await post({ related: { type: 'cfg', id: 'c5' } })).json().item.id as string;
    expect((await t.owner('POST', `/api/inbox/${id4}/actions/reject`, { reason: 'x'.repeat(501) })).json().error.code).toBe('INVALID_REASON');
  });

  it('小号看不到所有者卡片的发起者 / 影响范围 / 理由', async () => {
    const id = (await post({ impact: ['owner-impact-marker'] })).json().item.id as string;
    await t.owner('POST', `/api/inbox/${id}/actions/reject`, { reason: 'owner-reason-marker' });
    const xs = await t.xiao('GET', '/api/inbox');
    expect(xs.body).not.toContain('owner-impact-marker');
    expect(xs.body).not.toContain('owner-reason-marker');
  });
});

describe('0032 迁移', () => {
  it('up → down → up', async () => {
    const db = await openPglite();
    const cols = async () =>
      (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'inbox_items' AND column_name IN ('actor','impact','resolved_note') ORDER BY 1`)).rows.map((r) => r.c);
    expect(await cols()).toEqual(['actor', 'impact', 'resolved_note']);
    await db.exec(readFileSync(`${DOWN}/0032_inbox_decision.down.sql`, 'utf8'));
    expect(await cols()).toEqual([]);
    expect(await migrate(db)).toEqual(['0032_inbox_decision.sql']);
    expect(await cols()).toEqual(['actor', 'impact', 'resolved_note']);
    await db.close();
  });
});
