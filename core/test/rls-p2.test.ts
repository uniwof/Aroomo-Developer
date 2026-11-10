/** D206 RLS：#345 P2 users / user_invites / audit_log（迁移 0038，A+）。 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PgAuditLog } from '../src/audit/pg.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { EmailTakenError } from '../src/users/types.js';
import { PgUserStore } from '../src/users/pg.js';
import type { InviteRecord, UserRecord } from '../src/users/types.js';
import { RLS_APP_ROLE, rlsTargets } from './helpers/rls.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const XIAO = '00000000-0000-4000-8000-00000000a11c';
const T0 = new Date('2026-11-10T00:00:00Z');
const T1 = new Date('2026-11-10T01:00:00Z');
const FUTURE = new Date('2026-11-11T00:00:00Z');
const RLS = /row-level security/;
const REDEEM_ONLY = /user_invites: only used_at NULL -> NOT NULL is allowed/;
const REQUIRE_REAL_PG = process.env.CI === 'true' || process.env.CI === '1' || process.env.AROOMO_REQUIRE_REAL_PG === '1';
const P2 = ['audit_log', 'user_invites', 'users'];

/** 以表所有者 / 超级用户身份做一段（跑回退、造旧数据），做完切回应用角色 */
async function asAdmin<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('RESET ROLE');
  try {
    return await fn();
  } finally {
    await db.exec(`SET ROLE ${RLS_APP_ROLE}`);
  }
}

describe('M6 真 PG 必须在场（CI）', () => {
  it.runIf(REQUIRE_REAL_PG)('CI 下 rlsTargets 必须含真 PostgreSQL：rls-p2 在真 PG 上实际执行，不是跳过', () => {
    expect(rlsTargets.map((t) => t.name)).toContain('postgres');
  });
  if (!REQUIRE_REAL_PG && rlsTargets.length < 2) it.skip('本地没配 CORE_TEST_DATABASE_URL：只跑 PGlite（CI 里会失败）', () => {});
});

const user = (id: string, email: string, role: 'admin' | 'user' = 'user'): UserRecord => ({
  id, email, displayName: 'x', role, status: 'active', passwordHash: 'h', createdAt: T0, updatedAt: T0,
});
const invite = (hash: string, createdBy: string): InviteRecord => ({
  tokenHash: hash, kind: 'invite', email: `${hash}@example.test`, userId: null, role: 'user', createdBy, createdAt: T0, expiresAt: FUTURE, usedAt: null,
});

describe.each(rlsTargets)('RLS P2 users / user_invites / audit_log（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function open() {
    const db = await target.open();
    dbs.push(db);
    return db;
  }
  async function seeded() {
    const db = await open();
    const s = new PgUserStore(db);
    await s.insertUser(user(OWNER, 'own@example.test', 'admin'));
    await s.insertUser(user(XIAO, 'xiao@example.test'));
    return { db, s };
  }

  it('三张表都 ENABLE + FORCE，策略名和命令固定', async () => {
    const db = await open();
    for (const t of ['users', 'user_invites', 'audit_log']) {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1 AND relnamespace = current_schema()::regnamespace`, [t]);
      expect(rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    const pol = (await db.query<{ tablename: string; policyname: string; cmd: string }>(
      `SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = current_schema() AND tablename IN ('users','user_invites','audit_log') ORDER BY tablename, policyname`)).rows;
    expect(pol.map((p) => [p.policyname, p.cmd])).toEqual([
      ['audit_log_append', 'INSERT'], ['audit_log_system_read', 'SELECT'],
      ['user_invites_creator', 'ALL'], ['user_invites_system_read', 'SELECT'], ['user_invites_system_redeem', 'UPDATE'],
      ['users_self', 'ALL'], ['users_system_read', 'SELECT'],
    ]);
  });

  it('M1 结构：整个 schema 里引用 app.system_scope 的写策略（非 SELECT）恰好只有 user_invites_system_redeem；两个 0038 触发器在位', async () => {
    const db = await open();
    const w = (await db.query<{ n: string }>(
      `SELECT tablename || '.' || policyname || ':' || cmd AS n FROM pg_policies
        WHERE schemaname = current_schema() AND cmd <> 'SELECT' AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%app.system_scope%' ORDER BY 1`,
    )).rows.map((r) => r.n);
    expect(w).toEqual(['user_invites.user_invites_system_redeem:UPDATE']);
    const trg = (await db.query<{ n: string }>(
      `SELECT c.relname || '.' || t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal AND c.relname = ANY($1) ORDER BY 1`, [P2],
    )).rows.map((r) => r.n);
    expect(trg).toEqual(['audit_log.audit_log_no_truncate', 'audit_log.audit_log_no_update_delete', 'audit_log.audit_log_no_update_delete_stmt', 'user_invites.user_invites_redeem_only']);
  });

  describe('users', () => {
    it('不设 app.user_id：查询为空、写入被拒', async () => {
      const { db } = await seeded();
      expect((await db.query('SELECT * FROM users')).rows).toEqual([]);
      await expect(db.query(`INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at) VALUES ($1,'a@b.test','x','user','active','x',now(),now())`, [XIAO.replace('a11c', 'ffff')])).rejects.toThrow(RLS);
    });
    it('小号只看得到自己；改不了、删不了所有者；冒充所有者建号 / 改 id 被拒；UPDATE 提权别人那行影响 0 行', async () => {
      const { db } = await seeded();
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query<{ id: string }>('SELECT id FROM users')).rows.map((r) => r.id)).toEqual([XIAO]);
      expect((await asXiao.query(`UPDATE users SET role='admin' WHERE id=$1 RETURNING id`, [OWNER])).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM users WHERE id=$1 RETURNING id`, [OWNER])).rows).toEqual([]);
      await expect(asXiao.query(`INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at) VALUES ($1,'evil@b.test','x','admin','active','x',now(),now())`, [OWNER.replace('a1', 'b2')])).rejects.toThrow(RLS);
      await expect(asXiao.query(`UPDATE users SET id=$1 WHERE id=$2`, [OWNER, XIAO])).rejects.toThrow(RLS);
      const own = (await systemScoped(db).query<{ role: string; status: string }>('SELECT role, status FROM users WHERE id=$1', [OWNER])).rows[0];
      expect(own).toEqual({ role: 'admin', status: 'active' });
    });
    it('PgUserStore：按邮箱登录 / 列表走系统范围；改他人账号在目标账号范围内；重复邮箱仍是 EmailTakenError', async () => {
      const { s } = await seeded();
      expect((await s.getUserByEmail('XIAO@example.test'))?.id).toBe(XIAO);
      expect((await s.getUser(OWNER))?.role).toBe('admin');
      expect((await s.listUsers()).map((u) => u.id).sort()).toEqual([OWNER, XIAO].sort());
      expect((await s.updateUser(XIAO, { status: 'disabled' }, T1))?.status).toBe('disabled');
      expect(await s.updateUser('00000000-0000-4000-8000-0000000000ee', { status: 'disabled' }, T1)).toBeNull();
      await expect(s.insertUser(user('00000000-0000-4000-8000-0000000000dd', 'Xiao@Example.test'))).rejects.toBeInstanceOf(EmailTakenError);
    });
    it('getUser 行为写死（负责人第 2 轮 M3 小缺口）：id 存在 → 那一行；不存在 → null；\'owner\' → 抛 uuid 格式错（22P02），不返回任何行', async () => {
      const { s } = await seeded();
      expect(await s.getUser(XIAO)).toMatchObject({ id: XIAO, email: 'xiao@example.test', role: 'user', status: 'active' });
      expect(await s.getUser(OWNER)).toMatchObject({ id: OWNER, role: 'admin', status: 'active' });
      expect(await s.getUser('00000000-0000-4000-8000-0000000000ee')).toBeNull();
      // users.id 是 uuid：'owner'（所有者令牌的 user_id）在 PG 里直接被类型拒绝，读不到任何账号。
      // 路由的 :id 都有 format: 'uuid'，'owner' 到不了这里；内存存储对 'owner' 返回 null（两者都不会给出账号）。
      await expect(s.getUser('owner')).rejects.toMatchObject({ code: '22P02' });
    });
    it('系统范围只读：不能改、不能删、不能插', async () => {
      const { db } = await seeded();
      const sys = systemScoped(db);
      expect((await sys.query(`UPDATE users SET role='admin' WHERE id=$1 RETURNING id`, [XIAO])).rows).toEqual([]);
      expect((await sys.query(`DELETE FROM users WHERE id=$1 RETURNING id`, [XIAO])).rows).toEqual([]);
      await expect(sys.query(`INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at) VALUES ($1,'s@b.test','x','user','active','x',now(),now())`, [OWNER.replace('a1', 'c3')])).rejects.toThrow(RLS);
    });
  });

  describe('user_invites', () => {
    it('不设 app.user_id：查询为空、写入被拒', async () => {
      const { db, s } = await seeded();
      await s.insertInvite(invite('inv-owner', 'owner'));
      expect((await db.query('SELECT * FROM user_invites')).rows).toEqual([]);
      await expect(db.query(`INSERT INTO user_invites (token_hash, kind, email, role, created_by, created_at, expires_at) VALUES ('h','invite','a@b.test','user','owner',now(),now())`)).rejects.toThrow(RLS);
    });
    it('M2 创建人只能是所有者或在用管理员：普通账号以自己名义也建不了（含 role=admin），停用的管理员建不了；小号看不到、改不了、删不了别人的邀请', async () => {
      const { db, s } = await seeded();
      await s.insertInvite(invite('inv-owner', 'owner'));
      await s.insertInvite(invite('inv-admin', `user:${OWNER}`));
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query('SELECT * FROM user_invites')).rows).toEqual([]);
      const ins = (by: string, role: 'admin' | 'user' = 'admin') =>
        asXiao.query(`INSERT INTO user_invites (token_hash, kind, email, role, created_by, created_at, expires_at) VALUES ($2,'invite','a@b.test',$3,$1,now(),now())`, [by, `x-${by}-${role}`, role]);
      await expect(ins('owner')).rejects.toThrow(RLS);
      await expect(ins(`user:${OWNER}`)).rejects.toThrow(RLS);
      await expect(ins(`user:${XIAO}`)).rejects.toThrow(RLS); // 普通账号以自己名义建 admin 邀请：拒
      await expect(ins(`user:${XIAO}`, 'user')).rejects.toThrow(RLS); // 普通账号建任何邀请都拒
      await expect(s.insertInvite({ ...invite('inv-xiao', `user:${XIAO}`), role: 'admin' })).rejects.toThrow(RLS); // PgUserStore 同样拒
      expect((await asXiao.query(`UPDATE user_invites SET used_at=now() RETURNING token_hash`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM user_invites RETURNING token_hash`)).rows).toEqual([]);
      // 在用的管理员能以自己名义建，只看得到自己建的；停用后再建被拒
      const asAdmin1 = userScoped(db, OWNER);
      expect((await asAdmin1.query<{ token_hash: string }>('SELECT token_hash FROM user_invites')).rows.map((r) => r.token_hash)).toEqual(['inv-admin']);
      await s.updateUser(OWNER, { status: 'disabled' }, T1);
      await expect(s.insertInvite(invite('inv-admin-2', `user:${OWNER}`))).rejects.toThrow(RLS);
      // 所有者令牌（app.user_id = 'owner'）照常能建
      await s.insertInvite(invite('inv-owner-2', 'owner'));
      const all = (await systemScoped(db).query<{ token_hash: string }>('SELECT token_hash FROM user_invites ORDER BY token_hash')).rows.map((r) => r.token_hash);
      expect(all).toEqual(['inv-admin', 'inv-owner', 'inv-owner-2']);
    });
    it('M1 任何范围的 UPDATE 只能把 used_at 从 NULL 改成非 NULL：系统范围改 role / 延长有效期 / 已用改回未用、创建人改 created_by 都抛指定错误，库里不变', async () => {
      const { db, s } = await seeded();
      await s.insertInvite(invite('inv-owner', 'owner'));
      await s.insertInvite(invite('inv-admin', `user:${OWNER}`));
      expect((await s.useInvite('inv-admin', T1))?.tokenHash).toBe('inv-admin');
      const sys = systemScoped(db);
      const snap = async () => (await sys.query('SELECT * FROM user_invites ORDER BY token_hash')).rows;
      const before = await snap();
      await expect(sys.query(`UPDATE user_invites SET role='admin' WHERE token_hash='inv-owner'`)).rejects.toThrow(REDEEM_ONLY);
      await expect(sys.query(`UPDATE user_invites SET expires_at = expires_at + interval '30 days' WHERE token_hash='inv-owner'`)).rejects.toThrow(REDEEM_ONLY);
      await expect(sys.query(`UPDATE user_invites SET used_at = NULL WHERE token_hash='inv-admin'`)).rejects.toThrow(REDEEM_ONLY);
      await expect(sys.query(`UPDATE user_invites SET used_at = now() WHERE token_hash='inv-admin'`)).rejects.toThrow(REDEEM_ONLY); // 已用的再改时间也不行
      await expect(sys.query(`UPDATE user_invites SET used_at = now(), role = 'admin' WHERE token_hash='inv-owner'`)).rejects.toThrow(REDEEM_ONLY); // 夹带别的列
      await expect(userScoped(db, 'owner').query(`UPDATE user_invites SET created_by='user:${XIAO}' WHERE token_hash='inv-owner'`)).rejects.toThrow(REDEEM_ONLY);
      await expect(userScoped(db, 'owner').query(`UPDATE user_invites SET role='admin' WHERE token_hash='inv-owner'`)).rejects.toThrow(REDEEM_ONLY);
      expect(await snap()).toEqual(before);
      // 正常核销仍然可以（只动 used_at）
      expect((await s.useInvite('inv-owner', T1))?.usedAt).toEqual(T1);
    });
    it('PgUserStore：管理员列表（系统范围）看全部；按码哈希标记已用只一次；系统范围不能插入 / 删除', async () => {
      const { db, s } = await seeded();
      await s.insertInvite(invite('inv-owner', 'owner'));
      await s.insertInvite(invite('inv-admin', `user:${OWNER}`));
      expect((await s.listOpenInvites(T1)).map((i) => i.tokenHash).sort()).toEqual(['inv-admin', 'inv-owner']);
      expect((await s.useInvite('inv-owner', T1))?.createdBy).toBe('owner');
      expect(await s.useInvite('inv-owner', T1)).toBeNull();
      expect(await s.useInvite('nope', T1)).toBeNull();
      expect((await s.listOpenInvites(T1)).map((i) => i.tokenHash)).toEqual(['inv-admin']);
      const sys = systemScoped(db);
      await expect(sys.query(`INSERT INTO user_invites (token_hash, kind, email, role, created_by, created_at, expires_at) VALUES ('h2','invite','a@b.test','user','owner',now(),now())`)).rejects.toThrow(RLS);
      expect((await sys.query(`DELETE FROM user_invites RETURNING token_hash`)).rows).toEqual([]);
    });
  });

  describe('audit_log', () => {
    const entry = (n: string) => ({ actor: { type: 'user' as const, id: XIAO }, action: `a.${n}`, target: { type: 't', id: n }, result: 'ok' as const });
    it('任何范围都能追加（含不设范围）；追加不需要 SELECT 权限；所有者看全部（系统范围）', async () => {
      const db = await open();
      const log = new PgAuditLog(db, () => T0);
      const e = await log.append(entry('1'));
      expect(e).toMatchObject({ action: 'a.1', result: 'ok', actor: { type: 'user', id: XIAO } });
      await new PgAuditLog(userScoped(db, XIAO), () => T0).append(entry('2'));
      await new PgAuditLog(systemScoped(db), () => T0).append(entry('3'));
      expect((await log.query()).entries.map((x) => x.action).sort()).toEqual(['a.1', 'a.2', 'a.3']);
    });
    it('M4 append 不 RETURNING：返回值与库里那一行逐字段相等（有 note / 无 note 两种）', async () => {
      const db = await open();
      const log = new PgAuditLog(db, () => T0);
      const a = await log.append(entry('1'));
      const b = await log.append({ ...entry('2'), result: 'denied', note: '备注 n' });
      const { rows } = await systemScoped(db).query<{ id: string; ts: unknown; actor_type: string; actor_id: string; action: string; target_type: string; target_id: string; result: string; note: string | null }>(
        'SELECT id, ts, actor_type, actor_id, action, target_type, target_id, result, note FROM audit_log ORDER BY seq',
      );
      const asEntry = (r: (typeof rows)[number]) => ({
        id: r.id, ts: new Date(r.ts as string | Date), actor: { type: r.actor_type, id: r.actor_id }, action: r.action,
        target: { type: r.target_type, id: r.target_id }, result: r.result, ...(r.note !== null ? { note: r.note } : {}),
      });
      expect(rows.map(asEntry)).toEqual([{ ...a }, { ...b }]);
      expect(a.ts.getTime()).toBe(T0.getTime());
      // 与读接口（query）读出的同一行也逐字段相等
      expect((await log.query()).entries.map((x) => ({ ...x })).reverse()).toEqual([{ ...a }, { ...b }]);
    });
    it('不设范围 / 用户范围直接 SELECT 都为空（包括自己写的）；系统范围可读', async () => {
      const db = await open();
      await new PgAuditLog(db, () => T0).append(entry('1'));
      expect((await db.query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await userScoped(db, XIAO).query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await userScoped(db, OWNER).query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await systemScoped(db).query('SELECT * FROM audit_log')).rows).toHaveLength(1);
    });
    it('M4 仍然只追加：任何范围（不设 / 用户 / 系统）的 UPDATE / DELETE 都抛出指定错误，库快照不变', async () => {
      const db = await open();
      await new PgAuditLog(db, () => T0).append(entry('1'));
      await new PgAuditLog(db, () => T0).append(entry('2'));
      const snap = async () => (await systemScoped(db).query('SELECT * FROM audit_log ORDER BY seq')).rows;
      const before = await snap();
      expect(before).toHaveLength(2);
      for (const [name, scope] of [['none', db], ['user', userScoped(db, XIAO)], ['system', systemScoped(db)]] as const) {
        await expect(scope.query(`UPDATE audit_log SET note='x' RETURNING id`), `${name} UPDATE`).rejects.toThrow(/audit_log is append-only \(UPDATE blocked\)/);
        await expect(scope.query('DELETE FROM audit_log RETURNING id'), `${name} DELETE`).rejects.toThrow(/audit_log is append-only \(DELETE blocked\)/);
      }
      expect(await snap()).toEqual(before);
    });
  });
});

describe.each(rlsTargets)('迁移 0038 回退（$name）', (target) => {
  it('M6 up → down → up：整份结构状态比对（RLS 开关、策略含表达式、触发器、函数、迁移记录），三张表数据原样', async () => {
    const db = await target.open();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0038_rls_p2.down.sql', import.meta.url)), 'utf8');
      const state = async () => ({
        rls: (await db.query<{ relname: string; r: boolean; f: boolean }>(
          `SELECT relname, relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1) AND relnamespace = current_schema()::regnamespace ORDER BY 1`, [P2],
        )).rows.map((x) => [x.relname, x.r, x.f]),
        policies: (await db.query<{ n: string }>(
          `SELECT tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') AS n FROM pg_policies WHERE schemaname = current_schema() AND tablename = ANY($1) ORDER BY 1`, [P2],
        )).rows.map((x) => x.n),
        triggers: (await db.query<{ n: string }>(
          `SELECT c.relname || '.' || t.tgname AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal AND c.relname = ANY($1) ORDER BY 1`, [P2],
        )).rows.map((x) => x.n),
        fn: (await db.query<{ f: string | null }>(`SELECT to_regprocedure('user_invites_redeem_only()')::text AS f`)).rows[0]?.f ?? null,
        mig: (await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0038_rls_p2.sql'`)).rows.length,
      });
      const data = async () => ({
        users: (await db.query('SELECT * FROM users ORDER BY id')).rows,
        invites: (await db.query('SELECT * FROM user_invites ORDER BY token_hash')).rows,
        audit: (await db.query('SELECT * FROM audit_log ORDER BY seq')).rows,
      });
      await asAdmin(db, async () => {
        const UP = await state();
        expect(UP.rls).toEqual(P2.map((t) => [t, true, true]));
        expect(UP.policies.map((p) => p.split(':').slice(0, 2).join(':'))).toEqual([
          'audit_log.audit_log_append:INSERT', 'audit_log.audit_log_system_read:SELECT',
          'user_invites.user_invites_creator:ALL', 'user_invites.user_invites_system_read:SELECT', 'user_invites.user_invites_system_redeem:UPDATE',
          'users.users_self:ALL', 'users.users_system_read:SELECT',
        ]);
        expect(UP.triggers).toEqual(['audit_log.audit_log_no_truncate', 'audit_log.audit_log_no_update_delete', 'audit_log.audit_log_no_update_delete_stmt', 'user_invites.user_invites_redeem_only']);
        expect(UP.fn).toBe('user_invites_redeem_only()');
        expect(UP.mig).toBe(1);
        const DOWNED = {
          rls: P2.map((t) => [t, false, false]),
          policies: [],
          triggers: ['audit_log.audit_log_no_truncate', 'audit_log.audit_log_no_update_delete'],
          fn: null,
          mig: 0,
        };
        // 造数据（表所有者 / 超级用户身份）：两个账号、一张未用一张已用的邀请、两条审计
        await db.query(`INSERT INTO users (id, email, display_name, role, status, password_hash, created_at, updated_at) VALUES ($1,'own@example.test','o','admin','active','h',$3,$3), ($2,'xiao@example.test','x','user','active','h',$3,$3)`, [OWNER, XIAO, T0]);
        await db.query(`INSERT INTO user_invites (token_hash, kind, email, role, created_by, created_at, expires_at, used_at) VALUES ('i1','invite','a@example.test','user','owner',$1,$2,NULL), ('i2','invite','b@example.test','user',$3,$1,$2,$1)`, [T0, FUTURE, `user:${OWNER}`]);
        await db.query(`INSERT INTO audit_log (id, ts, actor_type, actor_id, action, target_type, target_id, result) VALUES ($1,$3,'system','s','a.1','t','1','ok'), ($2,$3,'system','s','a.2','t','2','ok')`, [OWNER.replace('a1', 'f1'), XIAO.replace('a11c', 'f11c'), T0]);
        const before = await data();
        await db.exec(DOWN);
        expect(await state()).toEqual(DOWNED);
        expect(await data()).toEqual(before);
        expect(await migrate(db)).toEqual(['0038_rls_p2.sql']);
        expect(await state()).toEqual(UP);
        expect(await data()).toEqual(before);
      });
    } finally {
      await db.close();
    }
  });
});
