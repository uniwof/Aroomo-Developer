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
import { openPglite } from './helpers/db.js';
import { rlsTargets } from './helpers/rls.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const XIAO = '00000000-0000-4000-8000-00000000a11c';
const T0 = new Date('2026-11-10T00:00:00Z');
const T1 = new Date('2026-11-10T01:00:00Z');
const FUTURE = new Date('2026-11-11T00:00:00Z');
const RLS = /row-level security/;

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
    it('小号看不到管理员的邀请；不能冒充 owner / 管理员创建；不能标记已用、不能删', async () => {
      const { db, s } = await seeded();
      await s.insertInvite(invite('inv-owner', 'owner'));
      await s.insertInvite(invite('inv-admin', `user:${OWNER}`));
      const asXiao = userScoped(db, XIAO);
      expect((await asXiao.query('SELECT * FROM user_invites')).rows).toEqual([]);
      const ins = (by: string) => asXiao.query(`INSERT INTO user_invites (token_hash, kind, email, role, created_by, created_at, expires_at) VALUES ('x-${by.length}','invite','a@b.test','admin',$1,now(),now())`, [by]);
      await expect(ins('owner')).rejects.toThrow(RLS);
      await expect(ins(`user:${OWNER}`)).rejects.toThrow(RLS);
      expect((await asXiao.query(`UPDATE user_invites SET used_at=now() RETURNING token_hash`)).rows).toEqual([]);
      expect((await asXiao.query(`DELETE FROM user_invites RETURNING token_hash`)).rows).toEqual([]);
      // 小号自己可以以自己（user:<id>）名义创建，并且只看得到自己的
      await s.insertInvite(invite('inv-xiao', `user:${XIAO}`));
      expect((await asXiao.query<{ token_hash: string }>('SELECT token_hash FROM user_invites')).rows.map((r) => r.token_hash)).toEqual(['inv-xiao']);
      // 创建人改不了 created_by 到别人名下
      await expect(asXiao.query(`UPDATE user_invites SET created_by='owner' WHERE token_hash='inv-xiao'`)).rejects.toThrow(RLS);
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
    it('不设范围 / 用户范围直接 SELECT 都为空（包括自己写的）；系统范围可读', async () => {
      const db = await open();
      await new PgAuditLog(db, () => T0).append(entry('1'));
      expect((await db.query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await userScoped(db, XIAO).query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await userScoped(db, OWNER).query('SELECT * FROM audit_log')).rows).toEqual([]);
      expect((await systemScoped(db).query('SELECT * FROM audit_log')).rows).toHaveLength(1);
    });
    it('仍然只追加：任何范围 UPDATE / DELETE 被拒（触发器）或影响 0 行', async () => {
      const db = await open();
      await new PgAuditLog(db, () => T0).append(entry('1'));
      for (const scope of [db, userScoped(db, XIAO), systemScoped(db)]) {
        for (const sql of [`UPDATE audit_log SET note='x' RETURNING id`, 'DELETE FROM audit_log RETURNING id']) {
          const rows = await scope.query(sql).then((r) => r.rows, () => []);
          expect(rows, sql).toEqual([]);
        }
      }
      expect((await systemScoped(db).query('SELECT * FROM audit_log')).rows).toHaveLength(1);
    });
  });
});

describe('迁移 0038 回退', () => {
  it('down 把三张表的 RLS 关掉并删迁移记录，再次迁移回来', async () => {
    const db = await openPglite();
    try {
      const DOWN = readFileSync(fileURLToPath(new URL('../migrations/down/0038_rls_p2.down.sql', import.meta.url)), 'utf8');
      await db.exec(DOWN);
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('users','user_invites','audit_log') ORDER BY relname`);
      expect(rows.every((r) => !r.relrowsecurity && !r.relforcerowsecurity)).toBe(true);
      expect((await db.query(`SELECT 1 FROM pg_policies WHERE tablename IN ('users','user_invites','audit_log')`)).rows).toEqual([]);
      expect((await db.query(`SELECT 1 FROM core_schema_migrations WHERE version = '0038_rls_p2.sql'`)).rows).toEqual([]);
      expect(await migrate(db)).toEqual(['0038_rls_p2.sql']);
    } finally {
      await db.close();
    }
  });
});
