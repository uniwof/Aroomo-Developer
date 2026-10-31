/** D206 RLS：成员表（第 1 个模块）。应用角色非超级用户、非表所有者，和生产一致地受 RLS 约束。 */
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { systemScoped, userScoped } from '../src/db/scope.js';
import { PgMemberStore } from '../src/members/pg.js';
import type { Member } from '../src/members/types.js';
import { rlsTargets } from './helpers/rls.js';

const XIAO = '00000000-0000-4000-8000-00000000a11c';
const mk = (id: string, name: string): Member => {
  const at = new Date('2026-10-31T00:00:00Z');
  return { id, name, aliases: [], capabilityTags: [], enabled: true, pinned: false, sortOrder: 0, status: 'active', modelCaps: null, deletedAt: null, createdAt: at, updatedAt: at };
};

describe.each(rlsTargets)('RLS 成员表（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  async function seeded() {
    const db = await target.open();
    dbs.push(db);
    const owner = new PgMemberStore(db);
    await owner.insert(mk('owner-secret', 'Owner Secret'));
    return { db, owner, xiao: owner.forUser(XIAO) };
  }

  it('当前角色确实受 RLS 约束（非超级用户、非 BYPASSRLS）', async () => {
    const { db } = await seeded();
    const { rows } = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('不设置 app.user_id 时查询返回空，计数为 0，写入被拒', async () => {
    const { db } = await seeded();
    expect((await db.query('SELECT * FROM members')).rows).toEqual([]);
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM members')).rows[0]?.n).toBe(0);
    expect((await db.query("SELECT * FROM members WHERE user_id = 'owner'")).rows).toEqual([]);
    await expect(
      db.query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('owner', 'sneak', 'Sneak', now(), now())`),
    ).rejects.toThrow(/row-level security/);
    // 更新、删除碰不到任何行
    await db.query("UPDATE members SET name = 'x' WHERE id = 'owner-secret'");
    await db.query("DELETE FROM members WHERE id = 'owner-secret'");
    expect((await userScoped(db, 'owner').query<{ name: string }>('SELECT name FROM members')).rows).toEqual([{ name: 'Owner Secret' }]);
  });

  it('设为小号时看不到所有者的行：漏写 WHERE 也只有自己的；改、删、伪造 user_id 都无效', async () => {
    const { db, owner, xiao } = await seeded();
    await xiao.insert(mk('xiao-bot', 'Xiao Bot'));
    const asXiao = userScoped(db, XIAO);
    // 故意不写 user_id 条件（模拟「忘了写」）
    expect((await asXiao.query<{ id: string }>('SELECT id FROM members ORDER BY id')).rows.map((r) => r.id)).toEqual(['xiao-bot']);
    expect((await asXiao.query<{ n: number }>("SELECT count(*)::int AS n FROM members WHERE id = 'owner-secret'")).rows[0]?.n).toBe(0);
    expect((await asXiao.query("UPDATE members SET name = 'Hacked' WHERE id = 'owner-secret' RETURNING id")).rows).toEqual([]);
    expect((await asXiao.query("DELETE FROM members WHERE id = 'owner-secret' RETURNING id")).rows).toEqual([]);
    // 把自己的行改成所有者的 user_id、或直接以所有者身份插入：WITH CHECK 拒绝
    await expect(asXiao.query("UPDATE members SET user_id = 'owner' WHERE id = 'xiao-bot'")).rejects.toThrow(/row-level security/);
    await expect(
      asXiao.query(`INSERT INTO members (user_id, id, name, created_at, updated_at) VALUES ('owner', 'sneak', 'Sneak', now(), now())`),
    ).rejects.toThrow(/row-level security/);
    // 事务内设置不外泄：小号事务结束后，同一连接上不设置时又是空
    expect((await db.query('SELECT id FROM members')).rows).toEqual([]);
    // store 层：各看各的
    expect((await owner.listAll()).map((m) => m.name)).toEqual(['Owner Secret']);
    expect((await xiao.listAll()).map((m) => m.name)).toEqual(['Xiao Bot']);
    expect(await xiao.get('owner-secret')).toBeNull();
    expect(await xiao.delete('owner-secret')).toBe(false);
  });

  it('系统任务范围可跨用户列出 user_id（只给定时任务用）', async () => {
    const { db, owner, xiao } = await seeded();
    await xiao.insert(mk('xiao-bot', 'Xiao Bot'));
    expect((await owner.userIds()).sort()).toEqual([XIAO, 'owner'].sort());
    expect((await systemScoped(db).query<{ n: number }>('SELECT count(*)::int AS n FROM members')).rows[0]?.n).toBe(2);
  });

  it('重排在同一事务里完成，且只动自己的行', async () => {
    const { owner, xiao } = await seeded();
    await owner.insert(mk('owner-two', 'Owner Two'));
    await xiao.insert(mk('xiao-bot', 'Xiao Bot'));
    await owner.reorder(['owner-two', 'owner-secret'], new Date());
    expect((await owner.listAll()).sort((a, b) => a.sortOrder - b.sortOrder).map((m) => m.id)).toEqual(['owner-two', 'owner-secret']);
    await expect(xiao.reorder(['owner-two', 'owner-secret'], new Date())).rejects.toThrow();
  });
});
