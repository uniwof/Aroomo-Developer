/** D206 RLS：按表循环的元数据检查（members / 公共记忆 / 资源库 / 保险箱 / 收件箱 / Key），防止以后某张表漏掉 FORCE、策略或 CHECK。 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { rlsTargets } from './helpers/rls.js';

const NOW = "'2026-11-02T13:00:00+08:00'";

const CONV = (u: string) =>
  `INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('${randomUUID()}', ${u}, 'assistant', 't', ${NOW}, ${NOW}) RETURNING id, user_id`;
const ASSIST = (c: string, u: string) =>
  `INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) SELECT '${randomUUID()}', ${u}, 'a', '0123456789', 'Asia/Shanghai', ${c}.id, ${NOW}, ${NOW} FROM ${c}`;
const RUN = (a: string) =>
  `INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) SELECT '${randomUUID()}', ${a}.id, ${a}.user_id, 'manual', ${NOW}, 'queued' FROM ${a}`;

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
  inbox_items: (u) =>
    `INSERT INTO inbox_items (id, grp, kind, urgency, title, summary, actions, status, created_at, user_id) VALUES ('${randomUUID()}', 'decision', 'k', 'normal', 't', 's', '[]', 'open', now(), ${u})`,
  provider_keys: (u) =>
    `INSERT INTO provider_keys (id, name, source_url, last4, model, model_name, litellm_model_id, status, created_at, updated_at, user_id) VALUES ('${randomUUID()}', 'nm', 'u', '1234', 'm', 'm', 'lm-${randomUUID().slice(0, 8)}', 'active', now(), now(), ${u})`,
  // 助手 v1（0025–0027）：子表用 CTE 在同一条语句里先建好同一账号的父行
  conversations: (u) => `INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('${randomUUID()}', ${u}, 'assistant', 't', ${NOW}, ${NOW})`,
  conversation_messages: (u) => `WITH c AS (${CONV(u)}) INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, created_at) SELECT '${randomUUID()}', c.id, c.user_id, 'system', 'x', ${NOW} FROM c`,
  assistants: (u) => `WITH c AS (${CONV(u)}) ${ASSIST('c', u)}`,
  assistant_members: (u) =>
    `WITH c AS (${CONV(u)}), m AS (INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m-${randomUUID().slice(0, 8)}', ${u}, 'x', ${NOW}, ${NOW}) RETURNING id, user_id), a AS (${ASSIST('c', u)} RETURNING id, user_id)
     INSERT INTO assistant_members (assistant_id, user_id, member_id, role) SELECT a.id, a.user_id, m.id, 'lead' FROM a, m`,
  assistant_runs: (u) => `WITH c AS (${CONV(u)}), a AS (${ASSIST('c', u)} RETURNING id, user_id) ${RUN('a')}`,
  run_steps: (u) =>
    `WITH c AS (${CONV(u)}), a AS (${ASSIST('c', u)} RETURNING id, user_id), r AS (${RUN('a')} RETURNING id, user_id)
     INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) SELECT r.id, r.user_id, 0, 0, 'plan', 'pending', ${NOW} FROM r`,
  push_subscriptions: (u) =>
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('${randomUUID()}', ${u}, 'https://fcm.googleapis.com/fcm/send/${randomUUID()}', '${'B'.repeat(87)}', '${'a'.repeat(22)}', ${NOW})`,
  // /work（0033）：版本的父行（项目）在同一条语句里先建
  work_projects: (u) => `INSERT INTO work_projects (id, user_id, name, created_at, updated_at) VALUES ('${randomUUID()}', ${u}, 'p', ${NOW}, ${NOW})`,
  work_versions: (u) =>
    `WITH p AS (INSERT INTO work_projects (id, user_id, name, created_at, updated_at) VALUES ('${randomUUID()}', ${u}, 'p-${randomUUID().slice(0, 8)}', ${NOW}, ${NOW}) RETURNING id, user_id)
     INSERT INTO work_versions (id, user_id, project_id, source_type, source_ref, label, source_state, synced_at) SELECT '${randomUUID()}', p.user_id, p.id, 'github_release', '1', 'v1', 'published', ${NOW} FROM p`,
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
