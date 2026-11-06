/**
 * /work 项目与版本 v1 切片 1（docs/api/design-work-v1.md）：
 * - 只给所有者（家人账号、没登录 403/401）；
 * - 项目增改查；来源只认 GitHub 公开仓库 owner/repo；
 * - 同步只请求 api.github.com（不跟重定向），草稿 release 不收，预发布照收；没 release 用 tag（已打标签，产出者和时间空着）；
 * - 产物链接只留 https + GitHub 主机；最多 3 页；每项目 10 分钟最多同步一次；GitHub 限流说清楚；
 * - 版本是不可变快照（库层拒绝 UPDATE）；迁移可回退。
 * 存储跑 memory + PGlite（+ CI 的真 PostgreSQL）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { fetchGithubVersions, safeGithubUrl } from '../src/work/github.js';
import { openPglite } from './helpers/db.js';
import { twoAccountEnvs, twoAccounts, type DepsEnv, type TwoAccounts } from './helpers/two-accounts.js';

interface Call {
  url: string;
  redirect: string | undefined;
}
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

const rel = (id: number, tag: string, over: Record<string, unknown> = {}) => ({
  id,
  tag_name: tag,
  name: `发布 ${tag}`,
  draft: false,
  prerelease: false,
  published_at: '2026-11-01T08:00:00Z',
  created_at: '2026-10-31T08:00:00Z',
  html_url: `https://github.com/acme/app/releases/tag/${tag}`,
  author: { login: 'octo' },
  assets: [],
  ...over,
});

describe.each(twoAccountEnvs)('/work 切片 1（$name）', (env: DepsEnv) => {
  let t: TwoAccounts;
  const calls: Call[] = [];
  let routes: Record<string, Reply> = {};
  const start = async () => {
    calls.length = 0;
    routes = {};
    t = await twoAccounts({
      name: env.name,
      make: async (now) => {
        const deps = await env.make(now);
        deps.workFetch = (async (url: string, init: { redirect?: string }) => {
          calls.push({ url, redirect: init?.redirect });
          const r = routes[url] ?? { status: 404, body: { message: 'Not Found' } };
          return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
        }) as unknown as typeof fetch;
        return deps;
      },
    });
  };
  afterEach(async () => {
    await t?.close();
  });
  const releases = (repo: string, page = 1) => `https://api.github.com/repos/${repo}/releases?per_page=30&page=${page}`;
  const tags = (repo: string, page = 1) => `https://api.github.com/repos/${repo}/tags?per_page=30&page=${page}`;
  const mk = async (name = '家里的应用', repo = 'acme/app') => {
    const r = await t.owner('POST', '/api/work/projects', { name, sources: [{ type: 'github', repo }] });
    expect(r.statusCode).toBe(201);
    return r.json().project as { id: string };
  };

  it('家人账号：所有 /work 接口 403（先判权限再校验请求体）', async () => {
    await start();
    const p = await mk();
    expect((await t.xiao('GET', '/api/work/projects')).statusCode).toBe(403);
    expect((await t.xiao('POST', '/api/work/projects', { junk: 1 })).statusCode).toBe(403);
    expect((await t.xiao('GET', `/api/work/projects/${p.id}`)).statusCode).toBe(403);
    expect((await t.xiao('PATCH', `/api/work/projects/${p.id}`, { name: 'x' })).statusCode).toBe(403);
    expect((await t.xiao('POST', `/api/work/projects/${p.id}/sync`)).statusCode).toBe(403);
    expect((await t.xiao('GET', `/api/work/projects/${p.id}/versions`)).statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('建项目、列出、改名改状态；名字重复 409；来源格式不对 400；找不到 404', async () => {
    await start();
    expect((await t.owner('GET', '/api/work/projects')).json()).toEqual({ projects: [] });
    const p = await mk();
    const list = (await t.owner('GET', '/api/work/projects')).json().projects;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: p.id, name: '家里的应用', status: 'active', sources: [{ type: 'github', repo: 'acme/app' }], latest: null, lastSyncAt: null });
    expect((await t.owner('POST', '/api/work/projects', { name: '家里的应用' })).statusCode).toBe(409);
    for (const repo of ['acme', 'acme/app/x', 'https://github.com/acme/app', '../etc', 'acme/..', 'ac me/app']) {
      expect((await t.owner('POST', '/api/work/projects', { name: `x${repo}`, sources: [{ type: 'github', repo }] })).statusCode, repo).toBe(400);
    }
    expect((await t.owner('POST', '/api/work/projects', { name: '   ' })).statusCode).toBe(400);
    const r = await t.owner('PATCH', `/api/work/projects/${p.id}`, { name: '新名字', status: 'paused' });
    expect(r.statusCode).toBe(200);
    expect(r.json().project).toMatchObject({ name: '新名字', status: 'paused' });
    expect((await t.owner('GET', `/api/work/projects/${p.id}`)).json().project.name).toBe('新名字');
    expect((await t.owner('GET', '/api/work/projects/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await t.owner('GET', '/api/work/projects/not-a-uuid')).statusCode).toBe(404);
  });

  it('同步：只收已发布和预发布，草稿不收；产出者、时间、产物来自 GitHub 原值；别的主机的链接丢掉', async () => {
    await start();
    const p = await mk();
    routes[releases('acme/app')] = {
      status: 200,
      body: [
        rel(3, 'v1.2.0-rc.1', { prerelease: true, published_at: '2026-11-03T08:00:00Z' }),
        rel(2, 'v1.1.0', {
          assets: [
            { name: 'app.zip', size: 2048, browser_download_url: 'https://github.com/acme/app/releases/download/v1.1.0/app.zip' },
            { name: 'evil.zip', size: 10, browser_download_url: 'https://evil.example.com/app.zip' },
            { name: 'http.zip', size: 10, browser_download_url: 'http://github.com/acme/app/x.zip' },
          ],
        }),
        rel(9, 'v2.0.0', { draft: true, published_at: null }),
      ],
    };
    const r = await t.owner('POST', `/api/work/projects/${p.id}/sync`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ added: 2, unchanged: 0, failed: [] });
    expect(calls.map((c) => c.url)).toEqual([releases('acme/app')]);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);

    const vs = (await t.owner('GET', `/api/work/projects/${p.id}/versions`)).json();
    expect(vs.nextCursor).toBeNull();
    expect(vs.versions.map((v: { label: string }) => v.label)).toEqual(['v1.2.0-rc.1', 'v1.1.0']);
    const [rc, v11] = vs.versions;
    expect(rc).toMatchObject({ sourceState: 'prerelease', actor: { type: 'github', name: 'octo' }, sourceAt: '2026-11-03T08:00:00.000Z' });
    expect(v11).toMatchObject({ sourceState: 'published', title: '发布 v1.1.0' });
    expect(v11.artifacts).toEqual([
      { type: 'page', title: 'GitHub 发布页', url: 'https://github.com/acme/app/releases/tag/v1.1.0', size: null },
      { type: 'file', title: 'app.zip', url: 'https://github.com/acme/app/releases/download/v1.1.0/app.zip', size: 2048 },
      { type: 'file', title: 'evil.zip', url: null, size: 10 },
      { type: 'file', title: 'http.zip', url: null, size: 10 },
    ]);
    const one = await t.owner('GET', `/api/work/versions/${v11.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json().version).toMatchObject({ id: v11.id, projectId: p.id, label: 'v1.1.0' });
    expect(JSON.stringify(vs)).not.toContain('v2.0.0');

    const list = (await t.owner('GET', '/api/work/projects')).json().projects;
    expect(list[0].latest).toMatchObject({ label: 'v1.2.0-rc.1', sourceState: 'prerelease' });
    expect(list[0].lastSyncAt).not.toBeNull();
  });

  it('同步限频：10 分钟内再同步 429（说还要等多久）；过了再同步，已有的不重复', async () => {
    await start();
    const p = await mk();
    routes[releases('acme/app')] = { status: 200, body: [rel(1, 'v1.0.0')] };
    expect((await t.owner('POST', `/api/work/projects/${p.id}/sync`)).json()).toMatchObject({ added: 1 });
    const again = await t.owner('POST', `/api/work/projects/${p.id}/sync`);
    expect(again.statusCode).toBe(429);
    expect(again.json().error.retryAfterSeconds).toBeGreaterThan(0);
    t.clock.advance(11 * 60 * 1000);
    routes[releases('acme/app')] = { status: 200, body: [rel(2, 'v1.1.0'), rel(1, 'v1.0.0', { name: '改过标题' })] };
    expect((await t.owner('POST', `/api/work/projects/${p.id}/sync`)).json()).toEqual({ added: 1, unchanged: 1, failed: [] });
    const vs = (await t.owner('GET', `/api/work/projects/${p.id}/versions`)).json().versions;
    // 不可变快照：GitHub 上后来改了标题，这里还是当时的
    expect(vs.find((v: { label: string }) => v.label === 'v1.0.0').title).toBe('发布 v1.0.0');
  });

  it('没有 release 的仓库用 tag：已打标签，产出者和时间空着，不拿提交时间冒充', async () => {
    await start();
    const p = await mk('只有标签', 'acme/tagsonly');
    routes[releases('acme/tagsonly')] = { status: 200, body: [] };
    routes[tags('acme/tagsonly')] = { status: 200, body: [{ name: 'v0.1.0', commit: { sha: 'abc123', url: 'https://api.github.com/repos/acme/tagsonly/commits/abc123' } }] };
    expect((await t.owner('POST', `/api/work/projects/${p.id}/sync`)).json()).toEqual({ added: 1, unchanged: 0, failed: [] });
    const [v] = (await t.owner('GET', `/api/work/projects/${p.id}/versions`)).json().versions;
    expect(v).toMatchObject({ label: 'v0.1.0', sourceState: 'tagged', actor: null, sourceAt: null, title: null });
    expect(v.artifacts).toEqual([{ type: 'page', title: 'GitHub 标签', url: 'https://github.com/acme/tagsonly/tree/v0.1.0', size: null }]);
  });

  it('最多翻 3 页', async () => {
    await start();
    const p = await mk();
    for (const page of [1, 2, 3, 4]) routes[releases('acme/app', page)] = { status: 200, body: Array.from({ length: 30 }, (_, i) => rel(page * 100 + i, `v${page}.${i}.0`)) };
    expect((await t.owner('POST', `/api/work/projects/${p.id}/sync`)).json()).toMatchObject({ added: 90 });
    expect(calls.map((c) => c.url)).toEqual([1, 2, 3].map((n) => releases('acme/app', n)));
    const first = (await t.owner('GET', `/api/work/projects/${p.id}/versions`)).json();
    expect(first.versions).toHaveLength(30);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await t.owner('GET', `/api/work/projects/${p.id}/versions?cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.versions).toHaveLength(30);
    expect(new Set([...first.versions, ...second.versions].map((v: { id: string }) => v.id)).size).toBe(60);
    // 游标只认自己发出去的样子：多一段、非规范 base64url 都 400（负责人 #323 建议）
    const raw = Buffer.from(first.nextCursor, 'base64url').toString();
    for (const bad of [Buffer.from(raw + '|x').toString('base64url'), first.nextCursor + '=', 'not a cursor'])
      expect((await t.owner('GET', `/api/work/projects/${p.id}/versions?cursor=${encodeURIComponent(bad)}`)).statusCode, bad).toBe(400);
  });

  it('GitHub 限流 / 仓库不存在 / 重定向：写进 failed，不加版本', async () => {
    await start();
    const p = await mk();
    routes[releases('acme/app')] = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1793952000' } };
    const r = (await t.owner('POST', `/api/work/projects/${p.id}/sync`)).json();
    expect(r.added).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ source: 'acme/app' });
    expect(r.failed[0].reason).toContain('限流');
    expect(r.failed[0].retryAt).toBe('2026-11-06T08:00:00.000Z');

    const q = await mk('不存在', 'acme/none');
    expect((await t.owner('POST', `/api/work/projects/${q.id}/sync`)).json().failed[0].reason).toContain('找不到');
    const m = await mk('搬家了', 'acme/moved');
    routes[releases('acme/moved')] = { status: 301, body: {} };
    expect((await t.owner('POST', `/api/work/projects/${m.id}/sync`)).json().failed[0].reason).toContain('搬');
    expect((await t.owner('GET', `/api/work/projects/${p.id}/versions`)).json().versions).toEqual([]);
  });
});

describe('产物链接过滤', () => {
  it('只收 https 的 GitHub 主机；带账号、端口、别的主机、http 都丢掉', () => {
    for (const ok of [
      'https://github.com/acme/app/releases/tag/v1',
      'https://objects.githubusercontent.com/x',
      'https://release-assets.githubusercontent.com/x',
      'https://codeload.github.com/acme/app/zip/v1',
    ]) expect(safeGithubUrl(ok), ok).toBe(ok);
    for (const bad of [
      'http://github.com/acme/app',
      'https://github.com.evil.com/x',
      'https://evilgithub.com/x',
      'https://user:pw@github.com/x',
      'https://github.com:8443/x',
      'javascript:alert(1)',
      'https://api.github.com/repos/acme/app',
      '',
      null,
    ]) expect(safeGithubUrl(bad as string), String(bad)).toBeNull();
  });
});

describe('迁移 0033 /work', () => {
  it('up → down → up 可回退；版本快照不能 UPDATE', async () => {
    const db = await openPglite();
    const has = async () => (await db.query(`SELECT 1 FROM pg_tables WHERE tablename IN ('work_projects','work_versions') AND schemaname = current_schema()`)).rows.length;
    expect(await has()).toBe(2);
    await db.query(`SELECT set_config('app.user_id', 'owner', false)`);
    await db.exec(`INSERT INTO work_projects (id, user_id, name, created_at, updated_at) VALUES ('00000000-0000-4000-8000-0000000000a1', 'owner', 'p', now(), now());
      INSERT INTO work_versions (id, user_id, project_id, source_type, source_ref, label, source_state, synced_at)
      VALUES ('00000000-0000-4000-8000-0000000000b1', 'owner', '00000000-0000-4000-8000-0000000000a1', 'github_release', '1', 'v1', 'published', now())`);
    await expect(db.exec(`UPDATE work_versions SET label = 'v9'`)).rejects.toThrow(/不可变/);
    await db.exec(readFileSync(fileURLToPath(new URL('../migrations/down/0033_work.down.sql', import.meta.url)), 'utf8'));
    expect(await has()).toBe(0);
    expect(await migrate(db)).toEqual(['0033_work.sql']);
    expect(await has()).toBe(2);
    await db.close();
  });
});

describe('GitHub 响应体（负责人 #323 必改 1）', () => {
  const url = (kind: string) => `https://api.github.com/repos/acme/app/${kind}?per_page=30&page=1`;
  /** 一块一块给的响应体，不带 content-length；记下读到第几块 */
  const streamed = (chunks: Uint8Array[]) => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= chunks.length) return c.close();
        c.enqueue(chunks[pulled++]!);
      },
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(body, { status: 200 }), stats: () => ({ pulled, cancelled }) };
  };

  it('没有 content-length 的超大响应：按字节数到 1 MB 就停止读取、取消下载，来源失败、不加版本', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x20);
    const s = streamed(Array.from({ length: 40 }, () => chunk)); // 10 MB
    const r = await fetchGithubVersions((async () => s.res) as unknown as typeof fetch, 'acme/app');
    expect(r).toEqual({ ok: false, reason: 'GitHub 返回的内容太大，没有读' });
    expect(s.stats().pulled).toBeLessThanOrEqual(6);
    expect(s.stats().cancelled).toBe(true);
  });

  it('按字节算不按字符：60 万个汉字（约 1.8 MB）也算太大', async () => {
    const big = new TextEncoder().encode(JSON.stringify([{ id: 1, tag_name: 'v1', name: '汉'.repeat(600_000) }]));
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const s = streamed([big]);
    const r = await fetchGithubVersions((async () => s.res) as unknown as typeof fetch, 'acme/app');
    expect(r).toMatchObject({ ok: false, reason: 'GitHub 返回的内容太大，没有读' });
  });

  it('形状不对的字段不抛错：assets 里的 null / 数字跳过，author 不是对象也行，数组里的 null 跳过', async () => {
    const body = [
      null,
      7,
      {
        id: 9,
        tag_name: 'v9',
        name: 'x',
        author: 'octo',
        html_url: 'https://github.com/acme/app/releases/tag/v9',
        assets: [null, 5, 'a', { name: 'ok.zip', browser_download_url: 'https://github.com/acme/app/releases/download/v9/ok.zip', size: 3 }],
      },
      { id: 10, tag_name: 'v10', assets: 'not-an-array', author: null },
    ];
    const f = (async (u: string) =>
      u === url('releases') ? new Response(JSON.stringify(body), { status: 200 }) : new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const r = await fetchGithubVersions(f, 'acme/app');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.versions.map((v) => v.label)).toEqual(['v9', 'v10']);
    expect(r.versions[0]!.actor).toBeNull();
    expect(r.versions[0]!.artifacts.filter((a) => a.type === 'file').map((a) => a.title)).toEqual(['ok.zip']);
  });

  it('JSON 不是数组 / 坏 JSON：受控失败', async () => {
    for (const text of ['{"message":"x"}', '[{', '']) {
      const r = await fetchGithubVersions((async () => new Response(text, { status: 200 })) as unknown as typeof fetch, 'acme/app');
      expect(r, text).toEqual({ ok: false, reason: 'GitHub 返回的内容看不懂' });
    }
  });
});

describe('产物链接过滤（负责人 #323 建议）', () => {
  it('按 URL 规范化后的主机名比，存规范化后的链接；带尾点、藏在账号里的别的主机丢掉', () => {
    expect(safeGithubUrl('https://GitHub.com/acme/app')).toBe('https://github.com/acme/app');
    expect(safeGithubUrl('https://git%68ub.com/x')).toBe('https://github.com/x');
    for (const bad of ['https://github.com./x', 'https://github.com%2f@evil.com/x', 'https://evil.com\\@github.com/x', 'https://evil.com#@github.com/x']) expect(safeGithubUrl(bad), bad).toBeNull();
  });
});
