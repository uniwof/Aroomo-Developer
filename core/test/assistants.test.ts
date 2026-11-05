/**
 * 助手 v1（docs/api/design-assistants-v1.md）：接口、立即运行、结果回会话与收件箱（X-01）、步骤（X-03）、
 * 超时 / 额度 / 付费确认（X-13、附录 C）、只给所有者、越权两条（X-23）、重启中途（X-21）。memory + PGlite（+ CI 真 PG）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, ownerAuth } from './helpers/db.js';
import { confirmOverHttp } from './helpers/confirm.js';
import { assistantEnv, type AssistantEnv, baseBody, LEAD, PAID, WORKER } from './helpers/assistants.js';
import { twoAccountEnvs } from './helpers/two-accounts.js';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.each(twoAccountEnvs)('助手 [$name]', (env) => {
  let e: AssistantEnv;
  beforeAll(async () => {
    e = await assistantEnv(env);
  });
  afterAll(async () => {
    await e.closeAll();
  });

  const run = async (id: string, headers?: Record<string, string>) => {
    const r = await e.owner('POST', `/api/assistants/${id}/runs`, undefined, headers);
    expect([200, 202], r.body).toContain(r.statusCode);
    await e.app.assistants.runner.idle();
    return (await e.owner('GET', `/api/assistants/${id}/runs/${r.json().run.id}`)).json().run as J;
  };
  const inbox = async () => {
    const g = (await e.owner('GET', '/api/inbox')).json().groups as Record<string, J[]>;
    return Object.values(g).flat();
  };

  it('建助手：201，开场白写进固定会话，计划写成人话，下次运行已算好；预览返回草稿数据块', async () => {
    const p = await e.owner('POST', '/api/assistants/preview', baseBody());
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().part.type).toBe('data-aroomo-assistant-draft');
    expect(p.json().scheduleText).toBe('每周一 09:00');
    expect(p.json().nextRunText).toMatch(/^下次运行：\d\d-\d\d 周一 09:00$/);

    const id = await e.create();
    const a = (await e.owner('GET', `/api/assistants/${id}`)).json().assistant as J;
    expect(a).toMatchObject({ name: '资源周报', leadMemberId: LEAD.id, budgetLevel: 'low', catchUp: 'skip', maxRuntimeSec: 600, status: 'normal', unread: true });
    expect(a.schedule.text).toBe('每周一 09:00');
    expect(new Date(a.nextRunAt).getTime()).toBeGreaterThan(e.clock.now().getTime());
    const msgs = (await e.owner('GET', `/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'member', memberId: LEAD.id });
    expect(msgs[0]!.content).toMatch(/^我是 资源周报，每周一 09:00开始，下次 /);
    expect((await e.owner('POST', `/api/assistants/${id}/read`)).statusCode).toBe(204);
    expect((await e.owner('GET', `/api/assistants/${id}`)).json().assistant.unread).toBe(false);
  });

  it('校验：任务说明太短、组长不在成员里、别人的成员（看起来与不存在一样）、间隔不足 1 小时都 400', async () => {
    expect((await e.owner('POST', '/api/assistants', baseBody({ instructions: '太短' }))).json().error.code).toBe('INVALID_INSTRUCTIONS');
    expect((await e.owner('POST', '/api/assistants', baseBody({ leadMemberId: PAID.id }))).json().error.code).toBe('INVALID_LEAD');
    await e.xiao('POST', '/api/members', { name: 'XiaoOnly' });
    const other = await e.owner('POST', '/api/assistants', baseBody({ members: ['xiaoonly'] }));
    const missing = await e.owner('POST', '/api/assistants', baseBody({ members: ['nobody'] }));
    expect(other.statusCode).toBe(400);
    expect(other.body).toBe(missing.body);
    expect((await e.owner('POST', '/api/assistants', baseBody({ schedule: { kind: 'interval', everyHours: 0 } }))).json().error.code).toBe('INVALID_SCHEDULE');
  });

  it('建助手幂等：同键同内容返回原助手（200），同键不同内容 409', async () => {
    const h = { 'idempotency-key': 'create-1' };
    const a = await e.owner('POST', '/api/assistants', baseBody({ name: '幂等' }), h);
    expect(a.statusCode).toBe(201);
    const b = await e.owner('POST', '/api/assistants', baseBody({ name: '幂等' }), h);
    expect(b.statusCode).toBe(200);
    expect(b.json().assistant.id).toBe(a.json().assistant.id);
    expect((await e.owner('POST', '/api/assistants', baseBody({ name: '幂等2' }), h)).json().error.code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('立即运行：组长分工 → 成员各做 → 组长汇总；结果进会话（组长署名）、进收件箱、写审计；低额度跳过付费成员；工具标记被清理', async () => {
    const id = await e.create({ name: '跑一次', members: [LEAD.id, WORKER.id, PAID.id] });
    e.gw.calls.length = 0;
    const r = await run(id);
    expect(r).toMatchObject({ status: 'succeeded', trigger: 'manual', summary: '汇总完成：找到 3 条', usageState: 'ample' });
    expect(e.gw.calls).toEqual([LEAD.name, WORKER.name, LEAD.name]); // 付费成员一次都没调
    const steps = (r.steps as J[]).map((s) => [s.memberId, s.action, s.status]);
    expect(steps).toEqual([
      [PAID.id, 'work', 'skipped'],
      [LEAD.id, 'plan', 'done'],
      [WORKER.id, 'work', 'done'],
      [LEAD.id, 'summarize', 'done'],
    ]);
    expect((r.steps as J[])[2]!.detail).not.toContain('tool_call');
    const msgs = (await e.owner('GET', `/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs.at(-1)).toMatchObject({ role: 'member', memberId: LEAD.id, runId: r.id, content: '汇总完成：找到 3 条' });
    expect(r.messageIds).toEqual([msgs.at(-1)!.id]);
    const card = (await inbox()).find((i) => i.related?.id === r.id);
    expect(card).toMatchObject({ group: 'brief', kind: 'assistant.run.done', title: '跑一次 运行完成' });
    const audit = await e.deps.auditLog.query({ action: 'assistant.run', target: { id: r.id } });
    expect(audit.entries[0]).toMatchObject({ actor: { type: 'system', id: 'assistants' }, result: 'ok' });
    expect(audit.entries[0]!.note).toContain(`members=${LEAD.id},${WORKER.id}`);
    const list = (await e.owner('GET', '/api/assistants')).json().assistants as J[];
    expect(list.find((x) => x.id === id)).toMatchObject({ unread: true, lastRun: { status: 'succeeded' } });
  });

  it('只有组长一位：组长直接做；notify 关掉时成功不进收件箱', async () => {
    const id = await e.create({ name: '单人', members: [LEAD.id], notify: false });
    const r = await run(id);
    expect(r.status).toBe('succeeded');
    expect(r.summary).toBe(`结果-${LEAD.name}`);
    expect((await inbox()).some((i) => i.related?.id === r.id)).toBe(false);
  });

  it('运行幂等：同一个 Idempotency-Key 返回同一条（200）；没带键而正在跑 → 409；取消 → cancelled', async () => {
    const id = await e.create({ name: '慢的', members: [LEAD.id] });
    e.gw.slow.add(LEAD.name);
    const h = { 'idempotency-key': 'run-1' };
    const a = await e.owner('POST', `/api/assistants/${id}/runs`, undefined, h);
    expect(a.statusCode).toBe(202);
    const b = await e.owner('POST', `/api/assistants/${id}/runs`, undefined, h);
    expect(b.statusCode).toBe(200);
    expect(b.json().run.id).toBe(a.json().run.id);
    expect((await e.owner('POST', `/api/assistants/${id}/runs`)).json().error.code).toBe('RUN_IN_PROGRESS');
    const c = await e.owner('POST', `/api/assistants/${id}/runs/${a.json().run.id}/cancel`);
    expect(c.json().run.status).toBe('cancelled');
    e.gw.slow.delete(LEAD.name);
    await e.app.assistants.runner.idle();
    expect((await e.owner('GET', `/api/assistants/${id}/runs/${a.json().run.id}`)).json().run.status).toBe('cancelled');
    const runs = (await e.owner('GET', `/api/assistants/${id}/runs?limit=20`)).json().runs as J[];
    expect(runs).toHaveLength(1);
  });

  it('组长的 Key 无效 → failed/key_invalid，会话里写一行失败原因，失败一律进收件箱', async () => {
    const id = await e.create({ name: '坏 Key', members: [LEAD.id], notify: false });
    e.gw.failStatus.set(LEAD.name, 401);
    const r = await run(id);
    e.gw.failStatus.delete(LEAD.name);
    expect(r).toMatchObject({ status: 'failed', failureCode: 'key_invalid' });
    const msgs = (await e.owner('GET', `/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs.at(-1)!.role).toBe('system');
    expect(msgs.at(-1)!.content).toMatch(/^这次运行失败：/);
    expect((await inbox()).find((i) => i.related?.id === r.id)).toMatchObject({ group: 'decision', kind: 'assistant.run.failed' });
  });

  it('低额度：组长不是免费模型 → failed/budget，一次都不调', async () => {
    const id = await e.create({ name: '付费组长', members: [PAID.id] });
    e.gw.calls.length = 0;
    const r = await run(id);
    expect(r).toMatchObject({ status: 'failed', failureCode: 'budget' });
    expect(e.gw.calls).toEqual([]);
  });

  it('中额度有付费成员：先停在 waiting_confirmation，不自动调付费模型；收件箱重要确认（payment）同意后同一条运行继续', async () => {
    const id = await e.create({ name: '要确认', members: [LEAD.id, PAID.id], budgetLevel: 'mid' });
    e.gw.calls.length = 0;
    const r = await run(id);
    expect(r.status).toBe('waiting_confirmation');
    expect(e.gw.calls).toEqual([]);
    const card = (await inbox()).find((i) => i.related?.id === r.id)!;
    expect(card).toMatchObject({ group: 'decision', kind: 'assistant.run.confirm' });
    expect((await e.owner('GET', '/api/assistants')).json().assistants.find((x: J) => x.id === id).status).toBe('waiting');
    const ok = await confirmOverHttp(e.app, e.clock, ownerAuth, (token) => e.owner('POST', `/api/inbox/${card.id}/actions/approve`, token ? { confirmToken: token } : undefined));
    expect(ok.statusCode, ok.body).toBe(200);
    await e.app.assistants.runner.idle();
    const after = (await e.owner('GET', `/api/assistants/${id}/runs/${r.id}`)).json().run as J;
    expect(after.status).toBe('succeeded');
    expect(e.gw.calls).toContain(PAID.name);
    expect((after.steps as J[]).find((s) => s.action === 'confirm')).toMatchObject({ status: 'done' });
  });

  it('中额度：拒绝 → cancelled，付费模型一次都没调', async () => {
    const id = await e.create({ name: '拒绝', members: [PAID.id], budgetLevel: 'high' });
    e.gw.calls.length = 0;
    const r = await run(id);
    const card = (await inbox()).find((i) => i.related?.id === r.id)!;
    expect((await e.owner('POST', `/api/inbox/${card.id}/actions/reject`)).statusCode).toBe(200);
    expect((await e.owner('GET', `/api/assistants/${id}/runs/${r.id}`)).json().run.status).toBe('cancelled');
    expect(e.gw.calls).toEqual([]);
  });

  it('暂停 / 继续：暂停后没有下次运行，继续后重新算；暂停时仍能手动运行', async () => {
    const id = await e.create({ name: '暂停', members: [LEAD.id], schedule: { kind: 'daily', time: '09:00' } });
    const p = await e.owner('POST', `/api/assistants/${id}/pause`);
    expect(p.json().assistant).toMatchObject({ nextRunAt: null });
    expect(p.json().assistant.pausedAt).not.toBeNull();
    expect((await run(id)).status).toBe('succeeded');
    const r = await e.owner('POST', `/api/assistants/${id}/resume`);
    expect(r.json().assistant.pausedAt).toBeNull();
    expect(r.json().assistant.nextRunAt).not.toBeNull();
  });

  it('改助手：换成员组保留原组长；改计划重算下次运行', async () => {
    const id = await e.create({ name: '改', members: [LEAD.id, WORKER.id], leadMemberId: WORKER.id });
    const r = await e.owner('PATCH', `/api/assistants/${id}`, { members: [LEAD.id, WORKER.id, PAID.id], schedule: { kind: 'manual' } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().assistant).toMatchObject({ leadMemberId: WORKER.id, nextRunAt: null, schedule: { kind: 'manual', text: '手动' } });
    expect(r.json().assistant.members).toHaveLength(3);
  });

  it('删除：不可逆，走重要确认（428 → 两步 → 令牌），之后 404', async () => {
    const id = await e.create({ name: '删掉', members: [LEAD.id] });
    const del = await confirmOverHttp(e.app, e.clock, ownerAuth, (token) => e.owner('DELETE', `/api/assistants/${id}`, token ? { confirmToken: token } : undefined));
    expect(del.statusCode, del.body).toBe(204);
    expect((await e.owner('GET', `/api/assistants/${id}`)).statusCode).toBe(404);
    expect((await e.owner('GET', `/api/assistants/${id}/messages`)).statusCode).toBe(404);
  });

  it('只给所有者：家人账号（小号）调任何助手接口都 403，访问所有者的助手也是 403（看不出存在）', async () => {
    const id = await e.create({ name: '所有者的', members: [LEAD.id] });
    for (const [m, u] of [
      ['GET', '/api/assistants'],
      ['POST', '/api/assistants'],
      ['GET', `/api/assistants/${id}`],
      ['GET', `/api/assistants/${id}/runs`],
      ['POST', `/api/assistants/${id}/runs`],
      ['GET', `/api/assistants/${id}/messages`],
      ['GET', '/api/assistants/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const r = await e.xiao(m, u, m === 'POST' ? baseBody() : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(403);
      expect(r.body).not.toContain('所有者的');
    }
  });

  it('X-23 ①：助手 A 的执行流写不进助手 B 的会话（403），也不能冒充非成员发言', async () => {
    const a = await e.create({ name: 'A', members: [LEAD.id] });
    const b = await e.create({ name: 'B', members: [WORKER.id] });
    const bConv = (await e.owner('GET', `/api/assistants/${b}`)).json().assistant.conversationId as string;
    const aConv = (await e.owner('GET', `/api/assistants/${a}`)).json().assistant.conversationId as string;
    const svc = e.app.assistants.service;
    await expect(svc.postAsAssistant('owner', a, bConv, { role: 'member', memberId: LEAD.id, runId: null, content: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.postAsAssistant('owner', a, aConv, { role: 'member', memberId: WORKER.id, runId: null, content: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    // 别的账号拿着所有者助手的 id：查不到（404，与不存在一样）
    await expect(svc.postAsAssistant(e.xiaoId, a, aConv, { role: 'system', memberId: null, runId: null, content: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    expect((await e.owner('GET', `/api/assistants/${b}/messages`)).json().messages).toHaveLength(1);
  });

  it('X-23 ②：请求里自带的作者 / 成员字段一律拒绝（400），成员消息只能由 Core 写', async () => {
    const id = await e.create({ name: '作者', members: [LEAD.id] });
    expect((await e.owner('POST', '/api/assistants', { ...baseBody(), author: LEAD.id })).statusCode).toBe(400);
    expect((await e.owner('POST', `/api/assistants/${id}/runs`, { memberId: LEAD.id, content: '我是组长' })).statusCode).toBe(400);
    expect((await e.owner('PATCH', `/api/assistants/${id}`, { role: 'member' })).statusCode).toBe(400);
    const msgs = (await e.owner('GET', `/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs.every((m) => m.content !== '我是组长')).toBe(true);
  });
});

describe.each(twoAccountEnvs)('助手：超时与重启 [$name]', (env) => {
  it('超过每次最长运行时间 → failed/timeout，停下不再调用', async () => {
    const e = await assistantEnv(env, { timeoutMs: 50 });
    try {
      const id = await e.create({ name: '超时', members: [LEAD.id, WORKER.id] });
      e.gw.slow.add(LEAD.name);
      e.gw.calls.length = 0;
      const r = await e.owner('POST', `/api/assistants/${id}/runs`);
      await e.app.assistants.runner.idle();
      const run = (await e.owner('GET', `/api/assistants/${id}/runs/${r.json().run.id}`)).json().run as J;
      expect(run).toMatchObject({ status: 'failed', failureCode: 'timeout' });
      expect(e.gw.calls).toEqual([LEAD.name]);
    } finally {
      await e.closeAll();
    }
  });

  it('X-21：运行到一半重启 Core → 那次运行变成「失败：服务重启」，已经写下的消息一条不少', async () => {
    const e = await assistantEnv(env);
    const id = await e.create({ name: '重启', members: [LEAD.id] });
    e.gw.slow.add(LEAD.name);
    const r = await e.owner('POST', `/api/assistants/${id}/runs`);
    const runId = r.json().run.id as string;
    await new Promise((res) => setTimeout(res, 50));
    expect((await e.owner('GET', `/api/assistants/${id}/runs/${runId}`)).json().run.status).toBe('running');
    // 新进程：同一份数据（同一个库 / 同一组内存存储）
    const app2 = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), e.deps);
    await app2.ready();
    const get = (u: string) => app2.inject({ method: 'GET', url: u, headers: ownerAuth });
    const run = (await get(`/api/assistants/${id}/runs/${runId}`)).json().run as J;
    expect(run).toMatchObject({ status: 'failed', failureCode: 'server_restart' });
    const msgs = (await get(`/api/assistants/${id}/messages`)).json().messages as J[];
    expect(msgs.map((m) => m.role)).toEqual(['member', 'system']);
    expect(msgs[1]!.content).toBe('这次运行失败：服务重启，这次运行中断了。');
    // 旧进程关掉：它手里那次运行不会再把状态改回来
    e.gw.slow.delete(LEAD.name);
    await e.app.assistants.runner.shutdown();
    expect((await get(`/api/assistants/${id}/runs/${runId}`)).json().run.status).toBe('failed');
    await e.mock.close();
    await e.app.close(); // 一并关闭共享的数据库
  });
});
