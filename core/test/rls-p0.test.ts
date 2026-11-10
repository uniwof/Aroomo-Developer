/** D206 RLS：#345 P0 六张表（client_tokens / user_sessions / exec_tasks / exec_takeovers / executors / confirm_challenges，A+）。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PgClientTokenStore } from '../src/clients/pg.js';
import type { ClientTokenRecord } from '../src/clients/types.js';
import type { AuditFn } from '../src/audit/types.js';
import { type ChallengeRow, challengeScope, ConfirmService, PgChallengeStore } from '../src/confirm/confirm.js';
import type { Db } from '../src/db/db.js';
import type { HttpError } from '../src/http/errors.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgExecutorStore } from '../src/executor/pg.js';
import type { TaskRecord } from '../src/executor/types.js';
import { PgUserStore } from '../src/users/pg.js';
import { RLS_APP_ROLE, rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OWN_ACCT = '00000000-0000-4000-8000-0000000000a1';
const T0 = new Date('2026-11-10T00:00:00.000Z');
const T1 = new Date('2026-11-10T01:00:00.000Z');
const FUTURE = new Date('2026-11-11T00:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RLS = /row-level security/;
const SIX = ['client_tokens', 'user_sessions', 'exec_tasks', 'exec_takeovers', 'executors', 'confirm_challenges'];
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
const REQUIRE_REAL_PG = process.env.CI === 'true' || process.env.CI === '1' || process.env.AROOMO_REQUIRE_REAL_PG === '1';

/** 以表所有者 / 超级用户身份做一段（造旧脏数据、跑回退），做完切回应用角色 */
async function asAdmin<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${RLS_APP_ROLE}`);
  }
}

/** 记下审计动作的假 AuditFn */
function auditSink() {
  const seen: string[] = [];
  const fn: AuditFn = async (action, _target, result, note) => {
    seen.push(`${action}:${result}${note ? `:${note}` : ''}`);
  };
  return { seen, fn };
}

describe('M5 真 PG 必须在场（CI）', () => {
  it.runIf(REQUIRE_REAL_PG)('CI 下 rlsTargets 必须含真 PostgreSQL：rls-p0 在真 PG 上实际执行，不是跳过', () => {
    expect(rlsTargets.map((t) => t.name)).toContain('postgres');
  });
  if (!REQUIRE_REAL_PG && rlsTargets.length < 2) it.skip('本地没配 CORE_TEST_DATABASE_URL：只跑 PGlite（CI 里会失败）', () => {});
});

const token = (n: number, userId: string): ClientTokenRecord => ({
  id: id(n), userId, name: `t${n}`, tokenHash: `hash-${n}`, scopes: ['library:read'], rateLimitPerMin: 60, createdAt: T0, expiresAt: null, lastUsedAt: null, revokedAt: null,
});
const task = (n: number, userId: string): TaskRecord => ({
  id: id(n), userId, kind: 'browse', site: 'https://example.com', instruction: '', secrets: [], options: {}, status: 'queued', executorId: null,
  leaseExpiresAt: null, cancelRequested: false, lastStage: null, lastMessage: null, resultSummary: null, resultError: null, createdAt: T0, updatedAt: T0,
});
const challenge = (n: number, actor: string, expiresAt = FUTURE): ChallengeRow => ({
  id: id(n), scope: `s:${n}`, actor, kind: 'irreversible', title: 't', consequences: ['c'], confirmLabel: '确认', payloadSalt: null, payloadDigest: null,
  requiresReauth: false, createdAt: T0, expiresAt, step1At: null, tokenHash: null, tokenIssuedAt: null, usedAt: null,
});

describe.each(rlsTargets)('RLS P0 六张表（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function open() {
    const db = await target.open();
    dbs.push(db);
    return db;
  }
  const addUser = (db: Db, uid: string, email: string) =>
    db.query(`INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at) VALUES ($1,$2,'x','user','active','x',now(),now())`, [uid, email]);

  it('六张表都 ENABLE + FORCE，且只有 <表>_user 和 <表>_system_read 两条策略', async () => {
    const db = await open();
    for (const t of ['client_tokens', 'user_sessions', 'exec_tasks', 'exec_takeovers', 'executors', 'confirm_challenges']) {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        'SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = current_schema()::regnamespace', [t],
      );
      expect(rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = (await db.query<{ policyname: string; cmd: string }>('SELECT policyname, cmd FROM pg_policies WHERE tablename = $1 AND schemaname = current_schema() ORDER BY policyname', [t])).rows;
      expect(pol.map((p) => [p.policyname, p.cmd]), t).toEqual([[`${t}_system_read`, 'SELECT'], [`${t}_user`, 'ALL']]);
    }
  });

  it('M5 六张表 user_id 都是 NOT NULL、类型正确（user_sessions 是 uuid，其余 text）', async () => {
    const db = await open();
    const { rows } = await db.query<{ table_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'user_id' AND table_name = ANY($1) ORDER BY table_name`,
      [SIX],
    );
    expect(rows.map((r) => [r.table_name, r.data_type, r.is_nullable])).toEqual(
      SIX.slice().sort().map((t) => [t, t === 'user_sessions' ? 'uuid' : 'text', 'NO']),
    );
  });

  it('C1 confirm_challenges.actor 是 NOT NULL（换算函数 STRICT，actor 为 NULL 时 CHECK 会放行，所以必须非空）', async () => {
    // 类型层：ChallengeRow.actor 不可为空（改成可空会编译失败）
    const actorNotNullable: null extends ChallengeRow['actor'] ? false : undefined extends ChallengeRow['actor'] ? false : true = true;
    expect(actorNotNullable).toBe(true);
    const db = await open();
    const { rows } = await db.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'confirm_challenges' AND column_name = 'actor'`,
    );
    expect(rows).toEqual([{ is_nullable: 'NO' }]);
  });

  describe('client_tokens', () => {
    it('不设 app.user_id：查询为空、写入被拒', async () => {
      const db = await open();
      await new PgClientTokenStore(db).insert(token(1, 'owner'));
      expect((await db.query('SELECT * FROM client_tokens')).rows).toEqual([]);
      await expect(db.query(`INSERT INTO client_tokens (id,user_id,name,token_hash,created_at) VALUES ('${id(9)}','owner','n','h9',now())`)).rejects.toThrow(RLS);
    });
    it('小号看不到、吊销不了、改不了所有者的令牌；冒充 owner 写入被拒', async () => {
      const db = await open();
      const s = new PgClientTokenStore(db);
      await s.insert(token(1, 'owner'));
      await s.insert(token(2, XIAO));
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query<{ id: string }>('SELECT id FROM client_tokens')).rows.map((r) => r.id)).toEqual([id(2)]);
      expect((await asXiao.query(`UPDATE client_tokens SET name='hacked' WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM client_tokens WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      await expect(asXiao.query(`UPDATE client_tokens SET user_id='owner' WHERE id='${id(2)}'`)).rejects.toThrow(RLS);
      await expect(asXiao.query(`INSERT INTO client_tokens (id,user_id,name,token_hash,created_at) VALUES ('${id(9)}','owner','n','h9',now())`)).rejects.toThrow(RLS);
      expect(await s.revoke(XIAO, id(1), T1)).toBe(false);
      await s.touch(XIAO, id(1), T1);
      expect((await s.listByUser('owner')).map((r) => [r.id, r.revokedAt, r.lastUsedAt])).toEqual([[id(1), null, null]]);
      expect((await s.listByUser(XIAO)).map((r) => r.id)).toEqual([id(2)]);
      expect(await s.revokeAll(XIAO, T1)).toBe(1);
      expect((await s.listByUser('owner'))[0]?.revokedAt).toBeNull();
    });
    it('登录前按哈希查找（systemScoped 只读）能找到；系统范围写不了', async () => {
      const db = await open();
      const s = new PgClientTokenStore(db);
      await s.insert(token(1, 'owner'));
      expect((await s.getByHash('hash-1'))?.userId).toBe('owner');
      expect(await s.getByHash('nope')).toBeNull();
      const sys = systemScoped(db);
      expect((await sys.query(`UPDATE client_tokens SET revoked_at=now() WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      expect((await sys.query(`DELETE FROM client_tokens WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      await expect(sys.query(`INSERT INTO client_tokens (id,user_id,name,token_hash,created_at) VALUES ('${id(9)}','owner','n','h9',now())`)).rejects.toThrow(RLS);
      await s.touch('owner', id(1), T1);
      expect((await s.getByHash('hash-1'))?.lastUsedAt?.toISOString()).toBe(T1.toISOString());
    });
  });

  it('M3 client_tokens 有 user_id 为空串的旧脏行：按哈希查找当作不存在，不会走到 userScoped(\'\')', async () => {
    const db = await open();
    const s = new PgClientTokenStore(db);
    await s.insert(token(1, 'owner'));
    await asAdmin(db, async () => {
      await db.exec(`ALTER TABLE client_tokens DROP CONSTRAINT client_tokens_user_id_nonempty`);
      await db.exec(`INSERT INTO client_tokens (id,user_id,name,token_hash,created_at) VALUES ('${id(8)}','','dirty','hash-dirty',now())`);
      await db.exec(`ALTER TABLE client_tokens ADD CONSTRAINT client_tokens_user_id_nonempty CHECK (user_id <> '') NOT VALID`);
    });
    expect(await s.getByHash('hash-dirty')).toBeNull();
    expect((await s.getByHash('hash-1'))?.userId).toBe('owner');
  });

  describe('user_sessions', () => {
    const sess = (h: string, userId: string) => ({ tokenHash: h, userId, createdAt: T0, expiresAt: FUTURE, revokedAt: null });
    async function seeded() {
      const db = await open();
      await addUser(db, OWN_ACCT, 'own@example.test');
      await addUser(db, XIAO, 'xiao@example.test');
      const s = new PgUserStore(db);
      await s.insertSession(sess('sess-own', OWN_ACCT));
      await s.insertSession(sess('sess-xiao', XIAO));
      return { db, s };
    }
    it('不设 app.user_id：查询为空、写入被拒', async () => {
      const { db } = await seeded();
      expect((await db.query('SELECT * FROM user_sessions')).rows).toEqual([]);
      await expect(db.query(`INSERT INTO user_sessions (token_hash,user_id,created_at,expires_at) VALUES ('x','${OWN_ACCT}',now(),now())`)).rejects.toThrow(RLS);
    });
    it('小号看不到、吊销不了所有者账号的会话；冒充写入被拒', async () => {
      const { db, s } = await seeded();
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query<{ token_hash: string }>('SELECT token_hash FROM user_sessions')).rows.map((r) => r.token_hash)).toEqual(['sess-xiao']);
      expect((await asXiao.query(`UPDATE user_sessions SET revoked_at=now() WHERE token_hash='sess-own' RETURNING 1`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM user_sessions WHERE token_hash='sess-own' RETURNING 1`)).rows).toEqual([]);
      await expect(asXiao.query(`UPDATE user_sessions SET user_id='${OWN_ACCT}' WHERE token_hash='sess-xiao'`)).rejects.toThrow(RLS);
      await expect(asXiao.query(`INSERT INTO user_sessions (token_hash,user_id,created_at,expires_at) VALUES ('x','${OWN_ACCT}',now(),now())`)).rejects.toThrow(RLS);
      await s.revokeSession(XIAO, 'sess-own', T1);
      await s.revokeUserSessions(XIAO, T1);
      expect((await s.getSession('sess-own'))?.revokedAt).toBeNull();
      expect((await s.getSession('sess-xiao'))?.revokedAt).not.toBeNull();
      await s.revokeSession(OWN_ACCT, 'sess-own', T1);
      expect((await s.getSession('sess-own'))?.revokedAt).not.toBeNull();
      expect(await s.getSession('nope')).toBeNull();
    });
    it('系统范围只读：不能改、不能删、不能插', async () => {
      const { db } = await seeded();
      const sys = systemScoped(db);
      expect((await sys.query('SELECT 1 FROM user_sessions')).rows).toHaveLength(2);
      expect((await sys.query(`UPDATE user_sessions SET revoked_at=now() RETURNING 1`)).rows).toEqual([]);
      expect((await sys.query(`DELETE FROM user_sessions RETURNING 1`)).rows).toEqual([]);
      await expect(sys.query(`INSERT INTO user_sessions (token_hash,user_id,created_at,expires_at) VALUES ('x','${OWN_ACCT}',now(),now())`)).rejects.toThrow(RLS);
    });
  });

  describe('exec_tasks / exec_takeovers / executors', () => {
    async function seeded() {
      const db = await open();
      const s = new PgExecutorStore(db);
      await s.insertTask(task(1, 'owner'));
      await s.insertTask(task(2, XIAO));
      await s.insertTakeover({ id: id(11), userId: 'owner', taskId: id(1), reason: 'captcha', message: 'm', status: 'pending', note: null, createdAt: T0, resolvedAt: null });
      const ex = (n: number, userId: string) => ({ id: id(n), userId, clientId: `c${n}`, deviceName: 'd', platform: 'win', version: '1', adapters: [] as string[], allowlistHash: null, createdAt: T0, lastSeenAt: T0 });
      await s.upsertExecutor(ex(21, 'owner'));
      await s.upsertExecutor(ex(22, XIAO));
      return { db, s };
    }
    it('不设 app.user_id：三张表查询为空、写入被拒', async () => {
      const { db } = await seeded();
      for (const t of ['exec_tasks', 'exec_takeovers', 'executors']) expect((await db.query(`SELECT * FROM ${t}`)).rows, t).toEqual([]);
      await expect(db.query(`INSERT INTO exec_tasks (id,user_id,kind,site,created_at,updated_at) VALUES ('${id(9)}','owner','browse','https://e.test',now(),now())`)).rejects.toThrow(RLS);
      await expect(db.query(`INSERT INTO executors (id,user_id,client_id,device_name,platform,version,created_at,last_seen_at) VALUES ('${id(9)}','owner','c','d','p','1',now(),now())`)).rejects.toThrow(RLS);
    });
    it('小号看不到、取消不了、领不走、结束不了所有者的任务；接管卡和执行员同样', async () => {
      const { db, s } = await seeded();
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query<{ id: string }>('SELECT id FROM exec_tasks')).rows.map((r) => r.id)).toEqual([id(2)]);
      expect((await asXiao.query('SELECT id FROM exec_takeovers')).rows).toEqual([]);
      expect((await asXiao.query<{ id: string }>('SELECT id FROM executors')).rows.map((r) => r.id)).toEqual([id(22)]);
      expect((await asXiao.query(`UPDATE exec_tasks SET status='cancelled' WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM exec_tasks WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      expect((await asXiao.query(`UPDATE exec_takeovers SET status='resolved' WHERE id='${id(11)}' RETURNING id`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM executors WHERE id='${id(21)}' RETURNING id`)).rows).toEqual([]);
      await expect(asXiao.query(`UPDATE exec_tasks SET user_id='owner' WHERE id='${id(2)}'`)).rejects.toThrow(RLS);
      await expect(asXiao.query(`INSERT INTO exec_takeovers (id,user_id,task_id,reason,message,created_at) VALUES ('${id(12)}','owner','${id(1)}','r','m',now())`)).rejects.toThrow(RLS);
      // 经 store：换成小号的 userId 也碰不到
      expect(await s.getTask(XIAO, id(1))).toBeNull();
      expect(await s.cancel(XIAO, id(1), T1)).toBeNull();
      expect(await s.getTakeover(XIAO, id(1), id(11))).toBeNull();
      expect(await s.resolveTakeover(XIAO, id(1), id(11), 'resolved', null, T1)).toBeNull();
      expect(await s.getExecutor(XIAO, id(21))).toBeNull();
      expect((await s.listTasks(XIAO, 10)).map((t) => t.id)).toEqual([id(2)]);
      // 小号领任务只会领到自己的那条
      expect((await s.claim(XIAO, id(22), null, T1, FUTURE))?.id).toBe(id(2));
      expect(await s.claim(XIAO, id(22), null, T1, FUTURE)).toBeNull();
      expect((await s.getTask('owner', id(1)))?.status).toBe('queued');
      expect(await s.finish(XIAO, id(1), id(22), 'succeeded', 's', null, T1)).toBeNull();
    });
    it('系统范围只读；sweep 跨用户清扫仍然生效（先系统范围找人、再逐个用户改）', async () => {
      const { db, s } = await seeded();
      const sys = systemScoped(db);
      expect((await sys.query('SELECT 1 FROM exec_tasks')).rows).toHaveLength(2);
      expect((await sys.query(`UPDATE exec_tasks SET status='cancelled' RETURNING 1`)).rows).toEqual([]);
      expect((await sys.query(`DELETE FROM executors RETURNING 1`)).rows).toEqual([]);
      await expect(sys.query(`INSERT INTO exec_tasks (id,user_id,kind,site,created_at,updated_at) VALUES ('${id(9)}','owner','browse','https://e.test',now(),now())`)).rejects.toThrow(RLS);
      // 两个用户各一条租约过期的 running、一条排队过久的 queued
      await s.claim('owner', id(21), null, T0, new Date(T0.getTime() + 1000));
      await s.claim(XIAO, id(22), null, T0, new Date(T0.getTime() + 1000));
      await s.insertTask({ ...task(3, 'owner'), createdAt: new Date('2026-11-01T00:00:00Z') });
      await s.insertTask({ ...task(4, XIAO), createdAt: new Date('2026-11-01T00:00:00Z') });
      const r = await s.sweep(T1, new Date('2026-11-05T00:00:00Z'));
      expect(r).toEqual({ requeued: 2, expired: 2 });
      expect((await s.getTask('owner', id(1)))?.status).toBe('queued');
      expect((await s.getTask(XIAO, id(4)))?.status).toBe('failed');
    });
  });

  it('M3 exec_tasks 有 user_id 为空串的旧脏行：sweep 不抛错、跳过它，其他用户照常清扫', async () => {
    const db = await open();
    const s = new PgExecutorStore(db);
    const OLD = new Date('2026-11-01T00:00:00Z');
    await s.insertTask({ ...task(3, 'owner'), createdAt: OLD });
    await s.insertTask({ ...task(4, XIAO), createdAt: OLD });
    await asAdmin(db, async () => {
      await db.exec(`ALTER TABLE exec_tasks DROP CONSTRAINT exec_tasks_user_id_nonempty`);
      await db.exec(`INSERT INTO exec_tasks (id,user_id,kind,site,status,created_at,updated_at) VALUES ('${id(9)}','','browse','https://e.test','queued','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')`);
      await db.exec(`ALTER TABLE exec_tasks ADD CONSTRAINT exec_tasks_user_id_nonempty CHECK (user_id <> '') NOT VALID`);
    });
    // 系统范围看得见脏行（负责人第 1 轮：「空串行谁也看不见」不对）
    expect((await systemScoped(db).query(`SELECT 1 FROM exec_tasks WHERE user_id = ''`)).rows).toHaveLength(1);
    const r = await s.sweep(T1, new Date('2026-11-05T00:00:00Z'));
    expect(r).toEqual({ requeued: 0, expired: 2 });
    expect((await s.getTask('owner', id(3)))?.status).toBe('failed');
    expect((await s.getTask(XIAO, id(4)))?.status).toBe('failed');
    // 脏行原样留着，等上线前清理（#229）
    expect((await systemScoped(db).query<{ status: string }>(`SELECT status FROM exec_tasks WHERE user_id = ''`)).rows).toEqual([{ status: 'queued' }]);
  });

  describe('confirm_challenges', () => {
    // M1：TS 的 challengeScope 和数据库的 confirm_challenge_scope 逐条等价（含边界：'user:'、多段冒号、大小写、前导空格、非 ASCII）
    const ACTORS = ['owner', `user:${XIAO}`, 'user:', 'user:a:b', 'user:owner', 'User:abc', ' user:z', 'useR:x', 'client:abc', 'operator:op1', 'mcp', 'owner2', '用户:1', 'u'];
    it('M1 等价性：challengeScope(actor) 与 SQL confirm_challenge_scope(actor) 对每个操作者都一样，且按 TS 算出的归属键都写得进去', async () => {
      const db = await open();
      const s = new PgChallengeStore(db);
      for (const [i, a] of ACTORS.entries()) {
        const { rows } = await db.query<{ v: string }>('SELECT confirm_challenge_scope($1) AS v', [a]);
        expect(rows[0]?.v, a).toBe(challengeScope(a));
        await s.insert(challenge(100 + i, a));
        expect((await s.get(a, id(100 + i)))?.actor, a).toBe(a);
      }
    });
    it('M1 反向：手写和 actor 换算不一致的 user_id 被 CHECK 拒（即使 RLS 放行）', async () => {
      const db = await open();
      const CK = /confirm_challenges_user_id_from_actor/;
      const ins = (uid: string, actor: string, n: number) =>
        userScoped(db, uid).query(
          `INSERT INTO confirm_challenges (id,scope,actor,kind,title,consequences,confirm_label,requires_reauth,created_at,expires_at,user_id) VALUES ($1,'s',$2,'irreversible','t','[]','c',false,now(),now(),$3)`,
          [id(n), actor, uid],
        );
      await expect(ins(XIAO, 'owner', 1)).rejects.toThrow(CK); // 主人的卡记到小号名下
      await expect(ins('owner', `user:${XIAO}`, 2)).rejects.toThrow(CK); // 小号的卡记到主人名下
      await expect(ins(`user:${XIAO}`, `user:${XIAO}`, 3)).rejects.toThrow(CK); // 没换算
      await expect(ins('abc', 'client:abc', 4)).rejects.toThrow(CK); // client:… 不剥前缀
      await ins(XIAO, `user:${XIAO}`, 5); // 一致的照常写入
      // 改 actor 让它和 user_id 不一致也被拒
      await expect(userScoped(db, XIAO).query(`UPDATE confirm_challenges SET actor = 'owner' WHERE id = $1`, [id(5)])).rejects.toThrow(CK);
    });
    it('M2 服务层：主人的确认令牌给别的操作者用一律被拒（409 confirm.rejected / 403 confirm.denied），卡不被用掉；主人自己用成功', async () => {
      const db = await open();
      let now = T0;
      const svc = new ConfirmService(new PgChallengeStore(db), { now: () => now, reauth: 'off' });
      const spec = { scope: 'vault.delete:x', kind: 'irreversible' as const, title: 't', consequences: ['c'] };
      const a = auditSink();
      const e = (await svc.require(spec, { actor: 'owner', canConfirmImportant: true }, a.fn).catch((x: unknown) => x)) as HttpError;
      expect(e.statusCode).toBe(428);
      const cid = (e.extra?.confirm as { id: string }).id;
      await svc.step(cid!, 1, { actor: 'owner' }, a.fn);
      now = new Date(T0.getTime() + 4000);
      const tok = (await svc.step(cid!, 2, { actor: 'owner' }, a.fn)).confirmToken!;
      // HTTP 层家人 / arc_ 没有 confirm:important（canConfirmImportant=false）：第一道就 403
      for (const actor of [`user:${XIAO}`, 'client:xiao-arc', 'client:owner-arc']) {
        await expect(svc.require(spec, { actor, canConfirmImportant: false, confirmToken: tok }, a.fn)).rejects.toMatchObject({ statusCode: 403 });
      }
      // 就算某天放开了（canConfirmImportant=true），换了操作者也查不到这张卡：409 CONFIRM_INVALID + confirm.rejected
      for (const actor of [`user:${XIAO}`, 'client:xiao-arc', 'client:owner-arc', 'operator:op1']) {
        await expect(svc.require(spec, { actor, canConfirmImportant: true, confirmToken: tok }, a.fn)).rejects.toMatchObject({ statusCode: 409, code: 'CONFIRM_INVALID' });
      }
      expect(a.seen.filter((x) => x.startsWith('confirm.denied:denied'))).toHaveLength(3);
      expect(a.seen.filter((x) => x === 'confirm.rejected:failed:CONFIRM_INVALID')).toHaveLength(4);
      expect((await systemScoped(db).query<{ used_at: unknown }>('SELECT used_at FROM confirm_challenges WHERE id = $1', [cid])).rows).toEqual([{ used_at: null }]);
      await svc.require(spec, { actor: 'owner', canConfirmImportant: true, confirmToken: tok }, a.fn);
      expect(a.seen).toContain(`confirm.consumed:ok:irreversible ${cid}`);
      expect((await systemScoped(db).query<{ used_at: unknown }>('SELECT used_at FROM confirm_challenges WHERE id = $1', [cid])).rows[0]?.used_at).not.toBeNull();
    });
    it('不设 app.user_id：查询为空、写入被拒', async () => {
      const db = await open();
      await new PgChallengeStore(db).insert(challenge(1, 'owner'));
      expect((await db.query('SELECT * FROM confirm_challenges')).rows).toEqual([]);
      await expect(
        db.query(`INSERT INTO confirm_challenges (id,scope,actor,kind,title,consequences,confirm_label,requires_reauth,created_at,expires_at,user_id) VALUES ('${id(9)}','s','owner','irreversible','t','[]','c',false,now(),now(),'owner')`),
      ).rejects.toThrow(RLS);
    });
    it('别的操作者读不到、点不了、用不掉所有者的确认卡；冒充写入被拒', async () => {
      const db = await open();
      const s = new PgChallengeStore(db);
      await s.insert(challenge(1, 'owner'));
      await s.insert(challenge(2, `user:${XIAO}`));
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query<{ id: string }>('SELECT id FROM confirm_challenges')).rows.map((r) => r.id)).toEqual([id(2)]);
      expect((await asXiao.query(`UPDATE confirm_challenges SET used_at=now() WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM confirm_challenges WHERE id='${id(1)}' RETURNING id`)).rows).toEqual([]);
      await expect(asXiao.query(`UPDATE confirm_challenges SET user_id='owner' WHERE id='${id(2)}'`)).rejects.toThrow(RLS);
      expect(await s.get(`user:${XIAO}`, id(1))).toBeNull();
      expect(await s.get('client:abc', id(1))).toBeNull();
      expect(await s.markStep1(`user:${XIAO}`, id(1), T1)).toBe(false);
      expect(await s.consume(`user:${XIAO}`, id(1), T1)).toBe(false);
      expect(await s.findByTokenHash(`user:${XIAO}`, 'whatever')).toBeNull();
      expect((await s.get('owner', id(1)))?.usedAt).toBeNull();
      expect(await s.markStep1('owner', id(1), T1)).toBe(true);
      expect(await s.issueToken('owner', id(1), 'tok-hash', T1)).toBe(true);
      expect((await s.findByTokenHash('owner', 'tok-hash'))?.id).toBe(id(1));
      expect(await s.findByTokenHash(`user:${XIAO}`, 'tok-hash')).toBeNull();
      expect(await s.consume('owner', id(1), T1)).toBe(true);
    });
    it('系统范围只读；deleteExpired 跨操作者清理仍然生效', async () => {
      const db = await open();
      const s = new PgChallengeStore(db);
      await s.insert(challenge(1, 'owner', new Date('2026-10-01T00:00:00Z')));
      await s.insert(challenge(2, `user:${XIAO}`, new Date('2026-10-01T00:00:00Z')));
      await s.insert(challenge(3, 'owner', FUTURE));
      const sys = systemScoped(db);
      expect((await sys.query('SELECT 1 FROM confirm_challenges')).rows).toHaveLength(3);
      expect((await sys.query(`DELETE FROM confirm_challenges RETURNING 1`)).rows).toEqual([]);
      expect((await sys.query(`UPDATE confirm_challenges SET used_at=now() RETURNING 1`)).rows).toEqual([]);
      expect(await s.deleteExpired(new Date('2026-10-20T00:00:00Z'))).toBe(2);
      expect((await s.get('owner', id(3)))?.id).toBe(id(3));
    });
  });
});

describe.each(rlsTargets)('迁移 0036 回退（$name）', (target) => {
  it('M5 up → down → up：down 后 RLS 开关、策略、约束、换算函数、confirm_challenges.user_id 全部清零；再 up 全部回来，旧确认卡按 actor 回填且能被本人消费', async () => {
    const db = await target.open();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0036_rls_p0.down.sql', import.meta.url)), 'utf8');
      const CONS = [
        ['client_tokens', 'client_tokens_user_id_nonempty', false],
        ['confirm_challenges', 'confirm_challenges_user_id_from_actor', true],
        ['confirm_challenges', 'confirm_challenges_user_id_nonempty', true],
        ['exec_takeovers', 'exec_takeovers_user_id_nonempty', false],
        ['exec_tasks', 'exec_tasks_user_id_nonempty', false],
        ['executors', 'executors_user_id_nonempty', false],
      ];
      const state = async () => ({
        rls: (await db.query<{ relname: string; r: boolean; f: boolean }>(
          `SELECT relname, relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1) AND relnamespace = current_schema()::regnamespace ORDER BY 1`, [SIX],
        )).rows.map((x) => [x.relname, x.r, x.f]),
        policies: (await db.query<{ n: string }>(`SELECT tablename || '.' || policyname AS n FROM pg_policies WHERE schemaname = current_schema() AND tablename = ANY($1) ORDER BY 1`, [SIX])).rows.map((x) => x.n),
        constraints: (await db.query<{ t: string; c: string; v: boolean }>(
          `SELECT cl.relname AS t, co.conname AS c, co.convalidated AS v FROM pg_constraint co JOIN pg_class cl ON cl.oid = co.conrelid
            WHERE cl.relnamespace = current_schema()::regnamespace AND cl.relname = ANY($1) AND co.contype = 'c' AND co.conname LIKE '%user_id%' ORDER BY 1, 2`, [SIX],
        )).rows.map((x) => [x.t, x.c, x.v]),
        fn: (await db.query<{ f: string | null }>(`SELECT to_regprocedure('confirm_challenge_scope(text)')::text AS f`)).rows[0]?.f ?? null,
        col: (await db.query<{ is_nullable: string }>(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'confirm_challenges' AND column_name = 'user_id'`)).rows.map((x) => x.is_nullable),
        mig: (await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0036_rls_p0.sql'`)).rows.length,
      });
      const UP = {
        rls: SIX.slice().sort().map((t) => [t, true, true]),
        policies: SIX.slice().sort().flatMap((t) => [`${t}.${t}_system_read`, `${t}.${t}_user`]),
        constraints: CONS,
        fn: 'confirm_challenge_scope(text)',
        col: ['NO'],
        mig: 1,
      };
      const DOWNED = { rls: SIX.slice().sort().map((t) => [t, false, false]), policies: [], constraints: [], fn: null, col: [], mig: 0 };
      await asAdmin(db, async () => {
        expect(await state()).toEqual(UP);
        await db.exec(DOWN);
        expect(await state()).toEqual(DOWNED);
        // 回退状态下写几张旧确认卡（主人、小号、客户端），带上已签发的令牌，再 up：回填 user_id
        const ins = (n: number, actor: string) =>
          db.query(
            `INSERT INTO confirm_challenges (id,scope,actor,kind,title,consequences,confirm_label,requires_reauth,created_at,expires_at,step1_at,token_hash,token_issued_at)
             VALUES ($1,'legacy:s',$2,'irreversible','t','["c"]','c',false,$3,$4,$3,$5,$3)`,
            [id(n), actor, T0, FUTURE, sha256(`legacy-token-${n}`)],
          );
        await ins(1, 'owner');
        await ins(2, `user:${XIAO}`);
        await ins(3, 'client:abc');
        expect(await migrate(db)).toEqual(['0036_rls_p0.sql']);
        expect(await state()).toEqual(UP);
      });
      const { rows } = await systemScoped(db).query<{ id: string; user_id: string }>('SELECT id, user_id FROM confirm_challenges ORDER BY id');
      expect(rows).toEqual([{ id: id(1), user_id: 'owner' }, { id: id(2), user_id: XIAO }, { id: id(3), user_id: 'client:abc' }]);
      // M2：回填出来的旧卡不会被锁死——对应的操作者（这里是家人小号）能正常消费；别人拿它的令牌被拒
      const svc = new ConfirmService(new PgChallengeStore(db), { now: () => T1, reauth: 'off' });
      const spec = { scope: 'legacy:s', kind: 'irreversible' as const, title: 't', consequences: ['c'] };
      const a = auditSink();
      await expect(svc.require(spec, { actor: 'owner', canConfirmImportant: true, confirmToken: 'legacy-token-2' }, a.fn)).rejects.toMatchObject({ statusCode: 409 });
      await svc.require(spec, { actor: `user:${XIAO}`, canConfirmImportant: true, confirmToken: 'legacy-token-2' }, a.fn);
      await svc.require(spec, { actor: 'owner', canConfirmImportant: true, confirmToken: 'legacy-token-1' }, a.fn);
      expect(a.seen).toEqual(['confirm.rejected:failed:CONFIRM_INVALID', `confirm.consumed:ok:irreversible ${id(2)}`, `confirm.consumed:ok:irreversible ${id(1)}`]);
    } finally {
      await db.close();
    }
  });
});
