/**
 * /work 切片 2（docs/api/design-work-v1.md「数据从哪来」后两行）：公共记忆的每个版本、助手的每次成功运行也是版本来源。
 * - 只用真实数据：标题、时间、产出者都来自来源；拿不到就空着（公共记忆没有作者 → actor = null）；
 * - 来源要属于本账号（建项目时就核；同步时也只按本账号读）；
 * - 公共记忆的旧版本被清理 / 主题删了：版本快照留着，详情说「这个版本已被清理」；
 * - 删掉再重建的主题从第 1 版重新数，算新版本，不当成「已有」；
 * - 排序（负责人 #323 小事）：有来源时间的按来源时间排，不再拿 tag 的同步时间和别的版本的来源时间比；没有时间的 tag 排在后面，按 GitHub 给的先后。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Assistant, AssistantRun } from '../src/assistants/types.js';
import { RUNS_PER_SYNC } from '../src/work/sources.js';
import { migrate } from '../src/db/migrate.js';
import { openPglite } from './helpers/db.js';
import { twoAccountEnvs, twoAccounts, type DepsEnv, type TwoAccounts } from './helpers/two-accounts.js';

const MIN = 60 * 1000;

describe.each(twoAccountEnvs)('/work 切片 2：公共记忆、助手运行（$name）', (env: DepsEnv) => {
  let t: TwoAccounts;
  let routes: Record<string, unknown> = {};
  const start = async () => {
    routes = {};
    t = await twoAccounts({
      name: env.name,
      make: async (now) => {
        const deps = await env.make(now);
        deps.workFetch = (async (url: string) =>
          new Response(JSON.stringify(routes[url] ?? { message: 'Not Found' }), { status: url in routes ? 200 : 404, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
        return deps;
      },
    });
  };
  afterEach(async () => {
    await t?.close();
  });
  const sync = async (id: string) => {
    const r = await t.owner('POST', `/api/work/projects/${id}/sync`);
    expect(r.statusCode).toBe(200);
    t.clock.advance(21 * MIN); // 下一次同步不撞 10 分钟限频，也不撞每小时 3 次
    return r.json() as { added: number; changed: number; unchanged: number; failed: { source: string; reason: string }[] };
  };
  const timeline = async (id: string, cursor?: string) =>
    (await t.owner('GET', `/api/work/projects/${id}/versions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).json() as {
      versions: { id: string; label: string; title: string | null; actor: unknown; sourceState: string; sourceType: string; sourceAt: string | null; artifacts: unknown[] }[];
      nextCursor: string | null;
    };
  const putMemory = async (topic: string, title: string, body: string) => {
    const r = await t.owner('PUT', `/api/memory/${topic}`, { title, body });
    expect(r.statusCode).toBe(200);
    t.clock.advance(MIN);
  };
  const project = async (name: string, sources: unknown[]) => {
    const r = await t.owner('POST', '/api/work/projects', { name, sources });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().project as { id: string };
  };
  /** 直接往助手库里放一个助手和几次运行（运行由执行器产生，这里不跑模型） */
  const seedAssistant = async (userId: string, name: string) => {
    const caller = userId === 'owner' ? t.owner : t.xiao;
    const m = await caller('POST', '/api/members', { name: `成员${name}` });
    expect(m.statusCode, m.body).toBe(201);
    const memberId = m.json().member.id as string;
    const now = t.clock.now();
    const a: Assistant = {
      id: randomUUID(), userId, name, instructions: '每天整理一次本周的进展并写成摘要', leadMemberId: memberId, members: [{ memberId, role: 'lead', position: 0 }],
      enabled: true, schedule: { kind: 'manual' }, timezone: 'Asia/Shanghai', catchUp: 'skip', maxRuntimeSec: 600, budgetLevel: 'low', notify: true,
      conversationId: randomUUID(), nextRunAt: null, pausedAt: null, idempotencyKey: null, idempotencyHash: null, createdAt: now, updatedAt: now,
    };
    const opening = { id: randomUUID(), conversationId: a.conversationId, userId, role: 'member' as const, memberId, runId: null, content: '我来', createdAt: now };
    expect(await t.deps.assistants.createAssistant(userId, a, { id: a.conversationId, userId, kind: 'assistant', title: name, memberIds: [memberId], readAt: null, createdAt: now, updatedAt: now }, opening)).toBe('ok');
    return a;
  };
  const addRun = async (a: Assistant, status: AssistantRun['status'], summary: string | null) => {
    const at = t.clock.now();
    const run: AssistantRun = {
      id: randomUUID(), assistantId: a.id, userId: a.userId, trigger: 'manual', scheduledFor: null, idempotencyKey: null, requestedAt: at,
      startedAt: at, finishedAt: status === 'running' ? null : new Date(at.getTime() + 1000), status, failureCode: status === 'failed' ? 'timeout' : null,
      summary, usageState: null, calls: 1, messageIds: [],
    };
    expect(await t.deps.assistants.insertRun(a.userId, run)).toBe('ok');
    t.clock.advance(MIN);
    return run;
  };

  it('公共记忆：每个版本（含当前版）是一个版本；标题、时间来自记忆本身，没有作者就空着；来源状态 none；详情能看到那一版正文', async () => {
    await start();
    const t1 = t.clock.now().toISOString();
    await putMemory('family-plan', '家庭计划', '第一稿');
    await putMemory('family-plan', '家庭计划', '第二稿');
    const t3 = t.clock.now().toISOString();
    await putMemory('family-plan', '家庭计划（定稿）', '第三稿');
    const p = await project('家庭计划', [{ type: 'memory', topic: 'family-plan' }]);
    expect(await sync(p.id)).toEqual({ added: 3, changed: 0, unchanged: 0, failed: [] });
    const { versions } = await timeline(p.id);
    expect(versions.map((v) => v.label)).toEqual(['第 3 版', '第 2 版', '第 1 版']);
    expect(versions[0]).toMatchObject({ title: '家庭计划（定稿）', actor: null, sourceState: 'none', sourceType: 'memory', sourceAt: t3, artifacts: [] });
    expect(versions[2]!.sourceAt).toBe(t1);
    const d = (await t.owner('GET', `/api/work/versions/${versions[2]!.id}`)).json();
    expect(d.open).toEqual({ kind: 'memory', topic: 'family-plan', version: 1, body: '第一稿' });
    const cur = (await t.owner('GET', `/api/work/versions/${versions[0]!.id}`)).json();
    expect(cur.open).toEqual({ kind: 'memory', topic: 'family-plan', version: 3, body: '第三稿' });
    // 再同步：都已有，不重复
    expect(await sync(p.id)).toEqual({ added: 0, changed: 0, unchanged: 3, failed: [] });
  });

  it('公共记忆被删：快照留着，详情说已清理（body = null）；同步写进 failed；删了再建的同名主题从第 1 版算新版本', async () => {
    await start();
    await putMemory('notes', '笔记', '旧的第一版');
    const p = await project('笔记', [{ type: 'memory', topic: 'notes' }]);
    expect((await sync(p.id)).added).toBe(1);
    const [old] = (await timeline(p.id)).versions;
    expect((await t.owner('DELETE', '/api/memory/notes')).statusCode).toBeLessThan(300);
    expect((await t.owner('GET', `/api/work/versions/${old!.id}`)).json().open).toEqual({ kind: 'memory', topic: 'notes', version: 1, body: null });
    const gone = await sync(p.id);
    expect(gone.added).toBe(0);
    expect(gone.failed).toEqual([{ source: '公共记忆 notes', reason: '找不到这个公共记忆主题（可能已经删了）' }]);
    await putMemory('notes', '笔记', '新的第一版');
    const again = await sync(p.id);
    expect(again).toMatchObject({ added: 1, failed: [] });
    const vs = (await timeline(p.id)).versions;
    expect(vs.map((v) => v.label)).toEqual(['第 1 版', '第 1 版']);
    expect((await t.owner('GET', `/api/work/versions/${vs[0]!.id}`)).json().open.body).toBe('新的第一版');
    expect((await t.owner('GET', `/api/work/versions/${vs[1]!.id}`)).json().open.body).toBeNull();
  });

  it('助手：只收成功的运行；标签是助手名字，标题是结果摘要第一行，时间是完成时间，产出者是这个助手；详情给完整摘要和助手 id', async () => {
    await start();
    const a = await seedAssistant('owner', '周报助手');
    const ok1 = await addRun(a, 'succeeded', '本周完成 3 件事\n细节：……');
    await addRun(a, 'failed', null);
    const ok2 = await addRun(a, 'succeeded', '下周计划');
    await addRun(a, 'running', null);
    await addRun(a, 'succeeded', null); // 成功但没有摘要：标题空着，不编
    const p = await project('周报', [{ type: 'assistant', assistantId: a.id }]);
    expect(await sync(p.id)).toMatchObject({ added: 3, failed: [] });
    const { versions } = await timeline(p.id);
    expect(versions.map((v) => v.title)).toEqual([null, '下周计划', '本周完成 3 件事']);
    expect(versions[1]).toMatchObject({ label: '周报助手', sourceType: 'assistant_run', sourceState: 'none', actor: { type: 'assistant', name: '周报助手', id: a.id }, sourceAt: ok2.finishedAt!.toISOString() });
    const d = (await t.owner('GET', `/api/work/versions/${versions[2]!.id}`)).json();
    expect(d.open).toEqual({ kind: 'assistant', assistantId: a.id, runId: ok1.id, summary: '本周完成 3 件事\n细节：……' });
    expect(await sync(p.id)).toMatchObject({ added: 0, unchanged: 3 });
  });

  it('来源要属于本账号：别人的主题 / 助手、不存在的、格式不对都 400；同步只按本账号读', async () => {
    await start();
    await t.deps.pubmem.put(t.xiaoId, 'xiao-only', '小号的', '小号的秘密', t.clock.now());
    const xa = await seedAssistant(t.xiaoId, '小号助手');
    for (const sources of [
      [{ type: 'memory', topic: 'xiao-only' }],
      [{ type: 'memory', topic: 'nope' }],
      [{ type: 'memory', topic: 'Bad Topic' }],
      [{ type: 'assistant', assistantId: xa.id }],
      [{ type: 'assistant', assistantId: randomUUID() }],
      [{ type: 'assistant', assistantId: 'not-a-uuid' }],
      [{ type: 'memory', topic: 'x', repo: 'a/b' }],
    ]) {
      const r = await t.owner('POST', '/api/work/projects', { name: `项目${Math.random()}`, sources });
      expect(r.statusCode, JSON.stringify(sources)).toBe(400);
      expect(r.body).not.toContain('小号的秘密');
    }
    // 改来源也一样核
    const p = await project('空项目', []);
    expect((await t.owner('PATCH', `/api/work/projects/${p.id}`, { sources: [{ type: 'memory', topic: 'xiao-only' }] })).statusCode).toBe(400);
    // 三种来源混在一起、重复的去掉
    await putMemory('mine', '我的', '内容');
    const mine = await seedAssistant('owner', '我的助手');
    const ok = await t.owner('PATCH', `/api/work/projects/${p.id}`, {
      sources: [{ type: 'github', repo: 'acme/app' }, { type: 'memory', topic: 'mine' }, { type: 'memory', topic: 'mine' }, { type: 'assistant', assistantId: mine.id }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().project.sources).toEqual([{ type: 'github', repo: 'acme/app' }, { type: 'memory', topic: 'mine' }, { type: 'assistant', assistantId: mine.id }]);
    // 家人账号照旧 403
    expect((await t.xiao('POST', '/api/work/projects', { name: 'x', sources: [{ type: 'memory', topic: 'xiao-only' }] })).statusCode).toBe(403);
  });

  it('负责人 #342 必改 4：别人的主题 / 助手和不存在的完全一样（状态码、错误码、消息都相同），建项目和改来源都是', async () => {
    await start();
    const p = await project('探测', []);
    const attempt = async (sources: unknown[]) => {
      const c = await t.owner('POST', '/api/work/projects', { name: '探测新建', sources });
      const u = await t.owner('PATCH', `/api/work/projects/${p.id}`, { sources });
      return [c, u].map((r) => ({ status: r.statusCode, body: r.json() as { error: { code: string; message: string } } }));
    };
    // 同一个主题名：小号有它时 vs 谁都没有它时（删掉之后），回答必须一字不差
    await t.deps.pubmem.put(t.xiaoId, 'probe-topic', '小号的', '小号的秘密', t.clock.now());
    const otherTopic = await attempt([{ type: 'memory', topic: 'probe-topic' }]);
    expect(await t.deps.pubmem.delete(t.xiaoId, 'probe-topic')).toBe(true);
    const noTopic = await attempt([{ type: 'memory', topic: 'probe-topic' }]);
    expect(otherTopic).toEqual(noTopic);
    expect(noTopic[0]).toMatchObject({ status: 400, body: { error: { code: 'BAD_SOURCE' } } });
    // 助手：小号的助手 id（在 / 删了之后）和随便一个不存在的 id，回答一字不差
    const xa = await seedAssistant(t.xiaoId, '小号助手');
    const otherAssistant = await attempt([{ type: 'assistant', assistantId: xa.id }]);
    const noAssistant = await attempt([{ type: 'assistant', assistantId: randomUUID() }]);
    expect(await t.deps.assistants.deleteAssistant(t.xiaoId, xa.id)).toBeTruthy();
    const deletedAssistant = await attempt([{ type: 'assistant', assistantId: xa.id }]);
    expect(otherAssistant).toEqual(noAssistant);
    expect(deletedAssistant).toEqual(noAssistant);
    expect(noAssistant[0]).toMatchObject({ status: 400, body: { error: { code: 'BAD_SOURCE' } } });
    expect(JSON.stringify([otherTopic, otherAssistant])).not.toContain('小号');
  });

  it('负责人 #342 必改 2：写新版本、回滚之后再同步，每次 added 恰好 = 1（同一版从当前变成历史不换编号，不生重复快照）', async () => {
    await start();
    await putMemory('plan', '计划', '一');
    await putMemory('plan', '计划', '二');
    const p = await project('计划', [{ type: 'memory', topic: 'plan' }]);
    expect(await sync(p.id)).toEqual({ added: 2, changed: 0, unchanged: 0, failed: [] });
    await putMemory('plan', '计划', '三'); // 第 2 版从当前变成历史
    expect(await sync(p.id)).toEqual({ added: 1, changed: 0, unchanged: 2, failed: [] });
    const rb = await t.owner('POST', '/api/memory/plan/rollback', { version: 1 }); // 回滚 = 用第 1 版内容写出第 4 版
    expect(rb.statusCode, rb.body).toBe(200);
    t.clock.advance(MIN);
    expect(await sync(p.id)).toEqual({ added: 1, changed: 0, unchanged: 3, failed: [] });
    const { versions } = await timeline(p.id);
    expect(versions.map((v) => v.label)).toEqual(['第 4 版', '第 3 版', '第 2 版', '第 1 版']);
    const bodies = [];
    for (const v of versions) bodies.push((await t.owner('GET', `/api/work/versions/${v.id}`)).json().open.body);
    expect(bodies).toEqual(['一', '三', '二', '一']);
  });

  it('负责人 #342 必改 3：只看最近 100 次运行——listRuns 新在前、取到的是最近 100 次，时间线顺序从新到旧', async () => {
    await start();
    const a = await seedAssistant('owner', '长跑助手');
    for (let i = 1; i <= 105; i++) await addRun(a, 'succeeded', `第 ${i} 次`);
    // 钉住契约：listRuns 按请求时间新在前，limit 截的是最新的
    const listed = await t.deps.assistants.listRuns('owner', a.id, RUNS_PER_SYNC);
    expect(listed.map((r) => r.summary)).toEqual(Array.from({ length: 100 }, (_, i) => `第 ${105 - i} 次`));
    const p = await project('长跑', [{ type: 'assistant', assistantId: a.id }]);
    expect(await sync(p.id)).toEqual({ added: 100, changed: 0, unchanged: 0, failed: [] });
    const titles: (string | null)[] = [];
    let cursor: string | undefined;
    do {
      const page = await timeline(p.id, cursor);
      titles.push(...page.versions.map((v) => v.title));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(titles).toEqual(Array.from({ length: 100 }, (_, i) => `第 ${105 - i} 次`));
    // 再跑一次新的：再同步只加这一条（第 6 次从窗口掉出去，快照留着）
    await addRun(a, 'succeeded', '第 106 次');
    expect(await sync(p.id)).toEqual({ added: 1, changed: 0, unchanged: 99, failed: [] });
  });

  it('负责人 #323 小事：有来源时间的按来源时间排（不拿 tag 的同步时间比）；没时间的 tag 排后面、按 GitHub 先后；翻页跨过两段不丢不重；「最新」是有时间的最新一条', async () => {
    await start();
    // 先同步只有 tag 的仓库（tag 没有时间）
    routes['https://api.github.com/repos/acme/old/releases?per_page=30&page=1'] = [];
    routes['https://api.github.com/repos/acme/old/tags?per_page=30&page=1'] = ['v0.6', 'v0.5', 'v0.4', 'v0.3', 'v0.2', 'v0.1'].map((name) => ({ name }));
    const p = await project('混合', [{ type: 'github', repo: 'acme/old' }]);
    expect((await sync(p.id)).added).toBe(6);
    // 之后才写的公共记忆（来源时间比 tag 的同步时间晚）和之前补发的一个 release（来源时间比 tag 的同步时间早）
    for (let i = 1; i <= 25; i++) await putMemory('log', '日志', `第 ${i} 条`);
    const releaseAt = new Date(t.clock.now().getTime() - 400 * 24 * 60 * MIN).toISOString();
    routes['https://api.github.com/repos/acme/old/releases?per_page=30&page=1'] = [
      { id: 9, tag_name: 'v0.0.9', name: '很早的发布', draft: false, prerelease: false, published_at: releaseAt, html_url: 'https://github.com/acme/old/releases/tag/v0.0.9', author: { login: 'octo' }, assets: [] },
    ];
    expect((await t.owner('PATCH', `/api/work/projects/${p.id}`, { sources: [{ type: 'github', repo: 'acme/old' }, { type: 'memory', topic: 'log' }] })).statusCode).toBe(200);
    expect(await sync(p.id)).toMatchObject({ added: 26, failed: [] });

    const page1 = await timeline(p.id);
    expect(page1.versions).toHaveLength(30);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await timeline(p.id, page1.nextCursor!);
    expect(page2.nextCursor).toBeNull();
    const labels = [...page1.versions, ...page2.versions].map((v) => v.label);
    expect(labels).toEqual([...Array.from({ length: 25 }, (_, i) => `第 ${25 - i} 版`), 'v0.0.9', 'v0.6', 'v0.5', 'v0.4', 'v0.3', 'v0.2', 'v0.1']);
    // 有时间的版本里，时间一定是从新到旧
    const timed = [...page1.versions, ...page2.versions].filter((v) => v.sourceAt).map((v) => Date.parse(v.sourceAt!));
    expect([...timed].sort((x, y) => y - x)).toEqual(timed);
    expect((await t.owner('GET', '/api/work/projects')).json().projects[0].latest.label).toBe('第 25 版');
  });

  it('只有 tag 的项目照旧：按 GitHub 给的先后，「最新」是第一个 tag（切片 1 的行为不变）', async () => {
    await start();
    routes['https://api.github.com/repos/acme/t/releases?per_page=30&page=1'] = [];
    routes['https://api.github.com/repos/acme/t/tags?per_page=30&page=1'] = ['v3', 'v2', 'v1'].map((name) => ({ name }));
    const p = await project('标签', [{ type: 'github', repo: 'acme/t' }]);
    await sync(p.id);
    expect((await timeline(p.id)).versions.map((v) => v.label)).toEqual(['v3', 'v2', 'v1']);
    expect((await t.owner('GET', '/api/work/projects')).json().projects[0].latest.label).toBe('v3');
  });
});

describe('迁移 0034 /work 来源', () => {
  /**
   * 负责人 #342 必改 1：按生产迁移身份跑——和 aroomo_core 一样「是表所有者、不是超级用户、没有 BYPASSRLS」，会话里不设 app.user_id。
   * PGlite 默认连接是超级用户（会绕过 RLS，测不出问题）：这里建一个这样的角色，把 public 下全部表交给它，再 SET ROLE 过去跑迁移和回退。
   */
  const asMigrationOwner = async (db: Awaited<ReturnType<typeof openPglite>>) => {
    await db.exec(`CREATE ROLE aroomo_core_mig_test NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT CREATE, USAGE ON SCHEMA public TO aroomo_core_mig_test`);
    const { rows } = await db.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
    for (const { t } of rows) await db.exec(`ALTER TABLE public.${t} OWNER TO aroomo_core_mig_test`);
    await db.exec('SET ROLE aroomo_core_mig_test');
    const { rows: me } = await db.query<{ su: boolean; br: boolean }>(`SELECT rolsuper AS su, rolbypassrls AS br FROM pg_roles WHERE rolname = current_user`);
    expect(me[0]).toEqual({ su: false, br: false });
  };
  const DOWN = () => readFileSync(fileURLToPath(new URL('../migrations/down/0034_work_sources.down.sql', import.meta.url)), 'utf8');

  it('生产迁移身份（表所有者、非超级用户、不设 app.user_id）：down 真的删掉 memory / assistant_run 行、FORCE RLS 恢复；再 up 可重复', async () => {
    const db = await openPglite();
    try {
      const PID = randomUUID();
      // 行由各账号自己写进来（app.user_id 只在写入时设，跑回退前清掉）
      const ins = (user: string, type: string) =>
        db.query(`INSERT INTO work_versions (id, user_id, project_id, source_type, source_ref, label, source_state, synced_at) VALUES ($1, $2, $3, $4, $5, 'x', 'none', now())`, [
          randomUUID(),
          user,
          PID,
          type,
          randomUUID(),
        ]);
      await asMigrationOwner(db);
      await db.query(`SELECT set_config('app.user_id', 'owner', false)`);
      await db.query(`INSERT INTO work_projects (id, user_id, name, created_at, updated_at) VALUES ($1, 'owner', 'p', now(), now())`, [PID]);
      await ins('owner', 'memory');
      await ins('owner', 'assistant_run');
      await ins('owner', 'github_tag');
      await expect(ins('owner', 'other')).rejects.toThrow();
      await db.query(`SELECT set_config('app.user_id', '', false)`);
      // 先证明前提：这个身份下 FORCE 生效，不设 app.user_id 什么都看不到、旧写法的 DELETE 一行都删不掉
      expect((await db.query(`SELECT 1 FROM work_versions`)).rows).toHaveLength(0);
      await db.exec('BEGIN');
      await db.exec(`DELETE FROM work_versions WHERE source_type IN ('memory', 'assistant_run')`);
      await db.exec('ALTER TABLE work_versions DROP CONSTRAINT work_versions_source_type_check');
      await expect(db.exec(`ALTER TABLE work_versions ADD CONSTRAINT work_versions_source_type_check CHECK (source_type IN ('github_release', 'github_tag'))`)).rejects.toThrow(/violated/);
      await db.exec('ROLLBACK');

      await db.exec(DOWN());
      const { rows: force } = await db.query<{ f: boolean }>(`SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'work_versions'::regclass`);
      expect(force[0]?.f).toBe(true);
      expect((await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0034_work_sources.sql'`)).rows).toHaveLength(0);
      await db.query(`SELECT set_config('app.user_id', 'owner', false)`);
      const { rows } = await db.query<{ source_type: string }>(`SELECT source_type FROM work_versions`);
      expect(rows.map((r) => r.source_type)).toEqual(['github_tag']);
      await expect(ins('owner', 'memory')).rejects.toThrow();
      expect(await migrate(db)).toEqual(['0034_work_sources.sql']);
      await ins('owner', 'memory');
    } finally {
      await db.close();
    }
  });

  it('down 中途失败整体回滚：FORCE RLS 不会被留在关着', async () => {
    const db = await openPglite();
    try {
      await asMigrationOwner(db);
      // 让 down 在 NO FORCE / 删除 / 改 CHECK 之后、COMMIT 之前出错
      const broken = DOWN().replace(/^DROP INDEX IF EXISTS work_versions_timeline_idx;$/m, 'SELECT 1 / 0;');
      expect(broken).toContain('SELECT 1 / 0;');
      await expect(db.exec(broken)).rejects.toThrow();
      await db.exec('ROLLBACK').catch(() => undefined);
      const { rows } = await db.query<{ f: boolean; c: string }>(
        `SELECT relforcerowsecurity AS f, pg_get_constraintdef(k.oid) AS c FROM pg_class r JOIN pg_constraint k ON k.conrelid = r.oid AND k.conname = 'work_versions_source_type_check' WHERE r.oid = 'work_versions'::regclass`,
      );
      expect(rows[0]?.f).toBe(true);
      expect(rows[0]?.c).toContain('memory');
    } finally {
      await db.close();
    }
  });
});
