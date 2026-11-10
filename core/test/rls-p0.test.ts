/** D206 RLS：#345 P0 六张表（client_tokens / user_sessions / exec_tasks / exec_takeovers / executors / confirm_challenges，A+）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PgClientTokenStore } from '../src/clients/pg.js';
import type { ClientTokenRecord } from '../src/clients/types.js';
import { type ChallengeRow, PgChallengeStore } from '../src/confirm/confirm.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgExecutorStore } from '../src/executor/pg.js';
import type { TaskRecord } from '../src/executor/types.js';
import { PgUserStore } from '../src/users/pg.js';
import { openPglite } from './helpers/db.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const OWN_ACCT = '00000000-0000-4000-8000-0000000000a1';
const T0 = new Date('2026-11-10T00:00:00.000Z');
const T1 = new Date('2026-11-10T01:00:00.000Z');
const FUTURE = new Date('2026-11-11T00:00:00.000Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RLS = /row-level security/;

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

  describe('confirm_challenges', () => {
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

describe('迁移 0036 回退', () => {
  it('up → down → up：down 关掉六张表的 RLS、删 confirm_challenges.user_id 并清迁移记录；再 up 回到原样，旧确认卡按 actor 回填', async () => {
    const db = await openPglite();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0036_rls_p0.down.sql', import.meta.url)), 'utf8');
      const tables = ['client_tokens', 'user_sessions', 'exec_tasks', 'exec_takeovers', 'executors', 'confirm_challenges'];
      const forced = async () =>
        (await db.query<{ relname: string; f: boolean }>(`SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1) AND relnamespace = current_schema()::regnamespace ORDER BY 1`, [tables])).rows.map((r) => [r.relname, r.f]);
      expect(await forced()).toEqual(tables.slice().sort().map((t) => [t, true]));
      await db.exec(DOWN);
      expect(await forced()).toEqual(tables.slice().sort().map((t) => [t, false]));
      const cols = async () => (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'confirm_challenges' AND table_schema = current_schema()`)).rows.map((r) => r.column_name);
      expect(await cols()).not.toContain('user_id');
      expect((await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0036_rls_p0.sql'`)).rows).toEqual([]);
      // 回退状态下写两张旧确认卡（owner、user:<id>），再 up：回填 user_id
      const ins = (n: number, actor: string) =>
        db.query(`INSERT INTO confirm_challenges (id,scope,actor,kind,title,consequences,confirm_label,requires_reauth,created_at,expires_at) VALUES ($1,'s',$2,'irreversible','t','[]','c',false,now(),now())`, [id(n), actor]);
      await ins(1, 'owner');
      await ins(2, `user:${XIAO}`);
      await ins(3, 'client:abc');
      expect(await migrate(db)).toEqual(['0036_rls_p0.sql']);
      expect(await forced()).toEqual(tables.slice().sort().map((t) => [t, true]));
      const { rows } = await systemScoped(db).query<{ id: string; user_id: string }>('SELECT id, user_id FROM confirm_challenges ORDER BY id');
      expect(rows).toEqual([{ id: id(1), user_id: 'owner' }, { id: id(2), user_id: XIAO }, { id: id(3), user_id: 'client:abc' }]);
    } finally {
      await db.close();
    }
  });
});
