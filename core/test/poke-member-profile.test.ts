/** Poke §4 New Member：角色、系统提示词、头像（docs/api/design-poke-data-v1.md）。存得住、跨账号看不见、系统提示词真的进这位成员的对话。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService, withMemberPrompt } from '../src/chat/service.js';
import { migrate } from '../src/db/migrate.js';
import type { Member } from '../src/members/types.js';
import type { LeadService } from '../src/settings/lead.js';
import { openPglite } from './helpers/db.js';
import { type TwoAccounts, twoAccountEnvs, twoAccounts } from './helpers/two-accounts.js';

const DOWN = fileURLToPath(new URL('../migrations/down/', import.meta.url));

describe.each(twoAccountEnvs)('成员资料字段（$name）', (env) => {
  let t: TwoAccounts;
  beforeEach(async () => {
    t = await twoAccounts(env);
  });
  afterEach(async () => {
    await t.close();
  });

  it('新建带 角色 / 系统提示词 / 头像，列表读得回；PATCH 能改能清；不合法 400', async () => {
    const r = await t.owner('POST', '/api/members', { name: 'Kimi K2', role: '  研究员 ', systemPrompt: '只用中文回答。', avatar: '🦊' });
    expect(r.statusCode).toBe(201);
    expect(r.json().member).toMatchObject({ role: '研究员', systemPrompt: '只用中文回答。', avatar: '🦊' });
    const id = r.json().member.id as string;
    const list = (await t.owner('GET', '/api/members')).json().members as Array<Record<string, unknown>>;
    expect(list.find((m) => m.id === id)).toMatchObject({ role: '研究员', avatar: '🦊' });
    const p = await t.owner('PATCH', `/api/members/${id}`, { role: null, avatar: '研', systemPrompt: '' });
    expect(p.json().member).toMatchObject({ role: null, avatar: '研', systemPrompt: null });
    expect((await t.owner('PATCH', `/api/members/${id}`, { avatar: '三个字' })).json().error.code).toBe('INVALID_AVATAR');
    expect((await t.owner('PATCH', `/api/members/${id}`, { role: 'x'.repeat(61) })).json().error.code).toBe('INVALID_ROLE');
    // 老成员（没填）照旧是 null
    const plain = await t.owner('POST', '/api/members', { name: 'Plain' });
    expect(plain.json().member).toMatchObject({ role: null, systemPrompt: null, avatar: null });
  });

  it('小号看不到所有者成员的资料，也改不了', async () => {
    const r = await t.owner('POST', '/api/members', { name: 'Secret Bot', role: 'owner-role-marker', systemPrompt: 'owner-prompt-marker' });
    const id = r.json().member.id as string;
    const xs = await t.xiao('GET', '/api/members');
    expect(xs.body).not.toContain('owner-prompt-marker');
    expect(xs.body).not.toContain('owner-role-marker');
    expect([403, 404]).toContain((await t.xiao('PATCH', `/api/members/${id}`, { role: 'hijack' })).statusCode);
    const again = (await t.owner('GET', '/api/members')).json().members.find((m: { id: string }) => m.id === id);
    expect(again.role).toBe('owner-role-marker');
  });
});

describe('0031 迁移', () => {
  it('up → down → up：三列删掉再加回', async () => {
    const db = await openPglite();
    const cols = async () =>
      (await db.query<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'members' AND column_name IN ('role','system_prompt','avatar') ORDER BY 1`)).rows.map((r) => r.c);
    expect(await cols()).toEqual(['avatar', 'role', 'system_prompt']);
    await db.exec(readFileSync(`${DOWN}/0031_member_profile.down.sql`, 'utf8'));
    expect(await cols()).toEqual([]);
    expect(await migrate(db)).toEqual(['0031_member_profile.sql']);
    expect(await cols()).toEqual(['avatar', 'role', 'system_prompt']);
    await db.close();
  });
});

describe('系统提示词进这位成员的对话', () => {
  const at = new Date('2026-11-06T02:00:00Z');
  const mk = (id: string, name: string, systemPrompt: string | null): Member => ({
    id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, sortOrder: 0, status: 'active', modelCaps: null, systemPrompt, deletedAt: null, createdAt: at, updatedAt: at,
  });
  const members = [mk('alpha', 'Alpha', 'ALPHA-PROMPT'), mk('beta', 'Beta', null)];
  const seen: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
  const svc = new ChatService({
    litellmBaseUrl: 'http://gateway.test',
    litellmKey: 'placeholder-key-0001',
    listMembers: async () => members,
    lead: { get: async () => ({ leadId: null, effectiveLeadId: 'alpha', auto: true }) } as unknown as LeadService,
    rules: async () => '规矩一条',
    fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
      const b = JSON.parse(String(init?.body));
      seen.push(b);
      return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }) as typeof fetch,
  });
  const ask = async (model: string, text: string) => {
    seen.length = 0;
    await svc.complete({ model, stream: false, messages: [{ role: 'user', content: text }] }, new AbortController().signal);
    return seen;
  };
  const sys = (s: (typeof seen)[number]) => s.messages.filter((x) => x.role === 'system').map((x) => x.content);

  it('点名 / 交给负责人 / aroomo/<成员> / 多人：各自只带自己的提示词，排在规矩后面', async () => {
    const one = await ask('aroomo', '@Alpha 你好');
    expect(sys(one[0]!)).toEqual([expect.stringContaining('规矩一条'), 'ALPHA-PROMPT']);
    expect(sys((await ask('aroomo', '帮我看看'))[0]!)).toContain('ALPHA-PROMPT');
    expect(sys((await ask('aroomo/alpha', '你好'))[0]!)).toContain('ALPHA-PROMPT');
    const both = await ask('aroomo', '@Alpha @Beta 一起说说');
    expect(sys(both.find((s) => s.model === 'Alpha')!)).toContain('ALPHA-PROMPT');
    expect(sys(both.find((s) => s.model === 'Beta')!)).not.toContain('ALPHA-PROMPT');
  });

  it('没填就原样', () => {
    const msgs = [{ role: 'user', content: 'x' }];
    expect(withMemberPrompt(msgs, { systemPrompt: null })).toBe(msgs);
  });
});
