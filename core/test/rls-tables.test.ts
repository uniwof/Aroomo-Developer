/** D206 RLS：按表循环的元数据检查（members / 公共记忆 / 资源库），防止以后某张表漏掉 FORCE、策略或 CHECK。 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { rlsTargets } from './helpers/rls.js';

const NOW = "'2026-11-02T13:00:00+08:00'";

/** 每张表一条「user_id 以外都合法」的插入语句，user_id 由参数填入 */
const TABLES: Record<string, (userIdSql: string) => string> = {
  members: (u) =>
    `INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m-${randomUUID().slice(0, 8)}', ${u}, 'x', ${NOW}, ${NOW})`,
  public_memory: (u) =>
    `INSERT INTO public_memory (user_id, topic, title, body, version, created_at, updated_at) VALUES (${u}, 'topic-a', 't', 'b', 1, ${NOW}, ${NOW})`,
  public_memory_versions: (u) =>
    `INSERT INTO public_memory_versions (user_id, topic, version, title, body, created_at) VALUES (${u}, 'topic-a', 1, 't', 'b', ${NOW})`,
  vault_secrets: (u) =>
    `INSERT INTO vault_secrets (id, user_id, name, kind, last4, ciphertext, dek_wrapped, nonce, created_at, updated_at) VALUES ('s-${randomUUID().slice(0, 8)}', ${u}, 'n', 'api_key', '1234', 'c', 'd', 'n', ${NOW}, ${NOW})`,
  library_items: (u) =>
    `INSERT INTO library_items (id, user_id, kind, title, url, body, tags, source, created_at, updated_at) VALUES ('${randomUUID()}', ${u}, 'idea', 't', NULL, '', '', 'manual', ${NOW}, ${NOW})`,
};

describe.each(rlsTargets)('RLS 表元数据（$name）', (target) => {
  const dbs: Db[] = [];
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });
  const open = async () => {
    const db = await target.open();
    dbs.push(db);
    return db;
  };

  describe.each(Object.keys(TABLES))('%s', (table) => {
    it('ENABLE + FORCE 行级安全都开着', async () => {
      const db = await open();
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = $1 AND relnamespace = current_schema()::regnamespace`,
        [table],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('只有 <表>_user（ALL）和 <表>_system_read（SELECT）两条策略', async () => {
      const db = await open();
      const { rows } = await db.query<{ policyname: string; cmd: string }>(
        `SELECT policyname, cmd FROM pg_policies
          WHERE tablename = $1 AND schemaname = current_schema() ORDER BY policyname`,
        [table],
      );
      expect(rows.map((r) => [r.policyname, r.cmd])).toEqual([
        [`${table}_system_read`, 'SELECT'],
        [`${table}_user`, 'ALL'],
      ]);
    });

    it('存在 <表>_user_id_nonempty CHECK 约束', async () => {
      const db = await open();
      const { rows } = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = ($1)::regclass AND contype = 'c' AND conname = $2`,
        [table, `${table}_user_id_nonempty`],
      );
      expect(rows).toHaveLength(1);
    });

    it("手动 set_config('app.user_id','') 后插入 user_id='' 被拒绝；设为真实用户则能插入（证明语句本身合法）", async () => {
      const db = await open();
      await db.query(`SELECT set_config('app.user_id', '', false)`);
      await expect(db.query(TABLES[table]!("''"))).rejects.toThrow(/row-level security|user_id_nonempty|violates/);
      await db.query(`SELECT set_config('app.user_id', 'u-check', false)`);
      await db.query(TABLES[table]!("'u-check'"));
      expect((await db.query('SELECT 1 FROM ' + table)).rows).toHaveLength(1);
    });
  });
});
