/**
 * 成员工具分配 v1 切片 1（docs/api/design-member-tools-v1.md；Poke 清单第 9 项后半）：
 * - 分配只存引用（工具名），列表的名字、风险、可用与否当场从工具网关读；
 * - 工具在资源库里停用 / 删除后，分配还在但写明不可用（不显示成能用）；
 * - 只有所有者能改：家人账号改 403（先判权限再校验）；读只读到本账号，所有者的成员对家人 = 不存在；
 * - 跨账号 RLS（PGlite / 真 PG）；迁移 0034 可回退；成员彻底删除时分配一起删。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { userScoped } from '../src/db/scope.js';
import { scopedSettings } from '../src/settings/store.js';
import { openPglite } from './helpers/db.js';
import { rlsTargets } from './helpers/rls.js';
import { expectSameAsMissing, twoAccountEnvs, twoAccounts, type DepsEnv, type TwoAccounts } from './helpers/two-accounts.js';

const httpTool = (toolId: string, enabled = true) => ({
  toolId,
  name: `天气 ${toolId}`,
  description: '查天气',
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'none' },
  allowedHosts: ['api.example.com'],
  risk: 'read',
  perDayLimit: 100,
  enabled,
});

describe.each(twoAccountEnvs)('成员工具分配（$name）', (env: DepsEnv) => {
  let t: TwoAccounts;
  afterEach(async () => {
    await t?.close();
  });
  const start = async () => {
    t = await twoAccounts(env);
    expect((await t.owner('POST', '/api/members', { name: 'Gemini 2.5 Pro' })).statusCode).toBe(201);
    const id = (await t.owner('GET', '/api/members')).json().members[0].id as string;
    return id;
  };
  const setHttpTools = (defs: unknown[]) => scopedSettings(t.deps.settings, 'owner').set('gateway.http_tools', defs, t.clock.now());

  it('没分配时是空列表；分配网关里的工具后列出名字、风险、可用、分配时间；重复分配幂等', async () => {
    const id = await start();
    expect((await t.owner('GET', `/api/members/${id}/tools`)).json()).toEqual({ tools: [] });
    const put = await t.owner('PUT', `/api/members/${id}/tools/read_webpage`);
    expect(put.statusCode).toBe(200);
    expect(put.json().tool).toMatchObject({ tool: 'read_webpage', available: true, risk: 'read' });
    expect((await t.owner('PUT', `/api/members/${id}/tools/read_webpage`)).statusCode).toBe(200);
    const list = (await t.owner('GET', `/api/members/${id}/tools`)).json().tools;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ tool: 'read_webpage', available: true, risk: 'read' });
    expect(typeof list[0].name).toBe('string');
    expect(typeof list[0].assignedAt).toBe('string');
  });

  it('只存引用：分配记录和接口响应里没有工具配置（主机、鉴权、secretId）', async () => {
    const id = await start();
    await setHttpTools([{ ...httpTool('weather_cn'), auth: { type: 'bearer', secretId: '00000000-0000-4000-8000-00000000abcd' } }]);
    expect((await t.owner('PUT', `/api/members/${id}/tools/weather_cn`)).statusCode).toBe(200);
    const body = (await t.owner('GET', `/api/members/${id}/tools`)).body;
    expect(body).toContain('weather_cn');
    for (const leak of ['api.example.com', 'secretId', '00000000-0000-4000-8000-00000000abcd', 'bearer', 'baseUrl']) expect(body).not.toContain(leak);
  });

  it('网关里没有的工具不能分配（400）；成员不存在 404；工具名格式不对 400', async () => {
    const id = await start();
    expect((await t.owner('PUT', `/api/members/${id}/tools/no_such_tool`)).statusCode).toBe(400);
    expect((await t.owner('PUT', '/api/members/nobody/tools/read_webpage')).statusCode).toBe(404);
    expect((await t.owner('GET', '/api/members/nobody/tools')).statusCode).toBe(404);
    expect((await t.owner('PUT', `/api/members/${id}/tools/Bad%20Name`)).statusCode).toBe(400);
  });

  it('工具在资源库里停用或删掉：分配还在，但写明不可用，风险与说明为空', async () => {
    const id = await start();
    await setHttpTools([httpTool('weather_cn')]);
    expect((await t.owner('PUT', `/api/members/${id}/tools/weather_cn`)).statusCode).toBe(200);
    await setHttpTools([httpTool('weather_cn', false)]);
    let row = (await t.owner('GET', `/api/members/${id}/tools`)).json().tools[0];
    expect(row).toMatchObject({ tool: 'weather_cn', available: false, risk: null, description: null });
    await setHttpTools([]);
    row = (await t.owner('GET', `/api/members/${id}/tools`)).json().tools[0];
    expect(row).toMatchObject({ tool: 'weather_cn', available: false });
  });

  it('去掉分配 204；本来没有 404；写审计（只记工具名）', async () => {
    const id = await start();
    await t.owner('PUT', `/api/members/${id}/tools/read_webpage`);
    expect((await t.owner('DELETE', `/api/members/${id}/tools/read_webpage`)).statusCode).toBe(204);
    expect((await t.owner('DELETE', `/api/members/${id}/tools/read_webpage`)).statusCode).toBe(404);
    expect((await t.owner('GET', `/api/members/${id}/tools`)).json().tools).toEqual([]);
    const audit = await t.deps.auditLog.query({});
    const acts = audit.map((e) => `${e.action}:${e.result}:${e.note ?? ''}`);
    expect(acts).toContain('member.tool.assign:ok:read_webpage');
    expect(acts).toContain('member.tool.unassign:ok:read_webpage');
  });

  it('每位成员最多 50 个分配（409）', async () => {
    const id = await start();
    await setHttpTools(Array.from({ length: 30 }, (_, i) => httpTool(`tool_${i}`)));
    const names = ['read_webpage', 'browser_task_create', 'browser_task_status', 'browser_task_cancel', ...Array.from({ length: 30 }, (_, i) => `tool_${i}`)];
    // 网关一个账号最多 30 个 HTTP 工具 + 内置 4 个 = 34 < 50：上限由服务层兜底，这里直接往存储里塞到 50 再验
    for (const n of names) expect((await t.owner('PUT', `/api/members/${id}/tools/${n}`)).statusCode, n).toBe(200);
    for (let i = names.length; i < 50; i++) await t.deps.memberTools.assign('owner', id, `filler_${i}`, t.clock.now(), 50);
    expect((await t.owner('PUT', `/api/members/${id}/tools/browser_task_create`)).statusCode).toBe(200); // 已有的照样幂等
    await setHttpTools([...Array.from({ length: 30 }, (_, i) => httpTool(`tool_${i}`)).slice(0, 29), httpTool('one_more')]);
    expect((await t.owner('PUT', `/api/members/${id}/tools/one_more`)).statusCode).toBe(409);
  });

  it('家人账号：改 403（不论请求对不对）；读所有者的成员 = 不存在；读自己的成员是空', async () => {
    const id = await start();
    await t.owner('PUT', `/api/members/${id}/tools/read_webpage`);
    expect((await t.xiao('PUT', `/api/members/${id}/tools/read_webpage`)).statusCode).toBe(403);
    expect((await t.xiao('PUT', '/api/members/x/tools/Bad%20Name')).statusCode).toBe(403);
    expect((await t.xiao('DELETE', `/api/members/${id}/tools/read_webpage`)).statusCode).toBe(403);
    await expectSameAsMissing((mid) => t.xiao('GET', `/api/members/${mid}/tools`), id);
    expect((await t.xiao('POST', '/api/members', { name: 'Kimi K2' })).statusCode).toBe(201);
    const mine = (await t.xiao('GET', '/api/members')).json().members[0].id as string;
    expect((await t.xiao('GET', `/api/members/${mine}/tools`)).json()).toEqual({ tools: [] });
    // 所有者的分配没被家人动到
    expect((await t.owner('GET', `/api/members/${id}/tools`)).json().tools).toHaveLength(1);
  });

  it('成员彻底删除后分配一起删（再建同 id 不会继承旧分配）', async () => {
    const id = await start();
    await t.owner('PUT', `/api/members/${id}/tools/read_webpage`);
    await t.deps.members.delete(id);
    expect(await t.deps.memberTools.list('owner', id)).toEqual([]);
  });
});

describe.each(rlsTargets)('RLS member_tools（$name，非超级用户应用角色）', (target) => {
  it('不设 app.user_id 为空、写入被拒；小号看不到、写不进、删不掉所有者的分配', async () => {
    const db = await target.open();
    try {
      const now = new Date();
      const own = userScoped(db, 'owner');
      await own.query("INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m1', 'owner', 'A', $1, $1)", [now]);
      await own.query("INSERT INTO member_tools (user_id, member_id, tool, assigned_at) VALUES ('owner', 'm1', 'read_webpage', $1)", [now]);
      expect((await db.query('SELECT * FROM member_tools')).rows).toEqual([]);
      const xiao = userScoped(db, 'u-2');
      expect((await xiao.query('SELECT * FROM member_tools')).rows).toEqual([]);
      await expect(xiao.query("INSERT INTO member_tools (user_id, member_id, tool, assigned_at) VALUES ('owner', 'm1', 'x', $1)", [now])).rejects.toThrow(/row-level security/);
      expect((await xiao.query("DELETE FROM member_tools WHERE member_id = 'm1' RETURNING tool")).rows).toEqual([]);
      expect((await own.query('SELECT tool FROM member_tools')).rows).toEqual([{ tool: 'read_webpage' }]);
    } finally {
      await db.close();
    }
  });
});

describe('迁移 0034 member_tools（PGlite）', () => {
  it('ENABLE + FORCE RLS；down → up 可回退', async () => {
    const db = await openPglite();
    try {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'member_tools'",
      );
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const has = async () => (await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'member_tools' AND schemaname = current_schema()")).rows.length;
      expect(await has()).toBe(1);
      await db.exec(readFileSync(fileURLToPath(new URL('../migrations/down/0034_member_tools.down.sql', import.meta.url)), 'utf8'));
      expect(await has()).toBe(0);
      await migrate(db);
      expect(await has()).toBe(1);
    } finally {
      await db.close();
    }
  });
});
