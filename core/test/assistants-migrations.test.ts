/** 助手 v1 迁移 0025–0027：可回退（up → down → up）；消息、步骤只追加（X-21）。 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertAppRoleSafe, grantAppRole } from '../src/db/app-role.js';
import { migrate } from '../src/db/migrate.js';
import { openPglite } from './helpers/db.js';

const DOWN = fileURLToPath(new URL('../migrations/down/', import.meta.url));
const NEW = ['0025_conversations.sql', '0026_assistants.sql', '0027_assistant_runs.sql'];
const NOW = "'2026-11-05T14:00:00+08:00'";

const tables = async (db: Awaited<ReturnType<typeof openPglite>>) =>
  (
    await db.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()
        AND tablename IN ('conversations','conversation_messages','assistants','assistant_members','assistant_runs','run_steps') ORDER BY 1`,
    )
  ).rows.map((r) => r.t);

describe('助手迁移 0025–0027', () => {
  it('每个新迁移都有回退文件', () => {
    const downs = readdirSync(DOWN);
    for (const f of NEW) expect(downs).toContain(f.replace(/\.sql$/, '.down.sql'));
  });

  it('up → down（倒序）→ up：表全部删掉再建回，迁移记录同步', async () => {
    const db = await openPglite();
    expect(await tables(db)).toHaveLength(6);
    for (const f of [...NEW].reverse()) await db.exec(readFileSync(`${DOWN}/${f.replace(/\.sql$/, '.down.sql')}`, 'utf8'));
    expect(await tables(db)).toEqual([]);
    expect(await migrate(db)).toEqual(NEW);
    expect(await tables(db)).toHaveLength(6);
    await db.close();
  });

  it('conversation_messages / run_steps 不能 UPDATE（只追加）；随父行一起删', async () => {
    const db = await openPglite();
    await db.exec(`
      INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000001', 'owner', 'assistant', 't', ${NOW}, ${NOW});
      INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, created_at) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'owner', 'system', 'hi', ${NOW});
      INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000003', 'owner', 'a', '0123456789', 'Asia/Shanghai', '00000000-0000-4000-8000-000000000001', ${NOW}, ${NOW});
      INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000003', 'owner', 'manual', ${NOW}, 'queued');
      INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) VALUES ('00000000-0000-4000-8000-000000000004', 'owner', 0, 0, 'plan', 'pending', ${NOW});
    `);
    await expect(db.query(`UPDATE conversation_messages SET content = 'changed'`)).rejects.toThrow(/只追加/);
    await expect(db.query(`UPDATE run_steps SET status = 'done'`)).rejects.toThrow(/只追加/);
    // 同一助手不能同时有两条 queued/running
    await expect(
      db.query(`INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000003', 'owner', 'manual', ${NOW}, 'running')`),
    ).rejects.toThrow(/assistant_runs_one_active|duplicate/);
    // 裁定 12：同一助手最多一条等确认
    await db.query(`INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000003', 'owner', 'manual', ${NOW}, 'waiting_confirmation')`);
    await expect(
      db.query(`INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000003', 'owner', 'manual', ${NOW}, 'waiting_confirmation')`),
    ).rejects.toThrow(/assistant_runs_one_waiting|duplicate/);
    await db.query(`DELETE FROM assistants`);
    expect((await db.query('SELECT 1 FROM run_steps')).rows).toHaveLength(0);
    await db.query(`DELETE FROM conversations`);
    expect((await db.query('SELECT 1 FROM conversation_messages')).rows).toHaveLength(0);
    await db.close();
  });

  it('负责人第二批必改 3：应用角色不能直接 DELETE 消息 / 步骤（也不能 TRUNCATE）；删助手、删会话的级联照样删得掉', async () => {
    const db = await openPglite();
    try {
      await db.exec(`
        INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000021', 'owner', 'assistant', 't', ${NOW}, ${NOW});
        INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, created_at) VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000021', 'owner', 'system', 'hi', ${NOW});
        INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000023', 'owner', 'a', '0123456789', 'Asia/Shanghai', '00000000-0000-4000-8000-000000000021', ${NOW}, ${NOW});
        INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000024', '00000000-0000-4000-8000-000000000023', 'owner', 'manual', ${NOW}, 'queued');
        INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) VALUES ('00000000-0000-4000-8000-000000000024', 'owner', 0, 0, 'plan', 'pending', ${NOW});
        CREATE ROLE aroomo_core_app NOLOGIN;
      `);
      await grantAppRole(db, 'aroomo_core_app');
      await db.exec(`SET ROLE aroomo_core_app; SELECT set_config('app.user_id', 'owner', false);`);
      expect(await assertAppRoleSafe(db)).toMatchObject({ truncatable: [], appendOnlyDeletable: [] });
      expect((await db.query('SELECT 1 FROM conversation_messages')).rows).toHaveLength(1);
      await expect(db.query('DELETE FROM conversation_messages')).rejects.toThrow(/permission denied for table conversation_messages/);
      await expect(db.query('DELETE FROM run_steps')).rejects.toThrow(/permission denied for table run_steps/);
      await expect(db.query('TRUNCATE run_steps')).rejects.toThrow(/permission denied/);
      // 级联由数据库以表所有者身份执行：删助手带走运行和步骤，删会话带走消息
      await db.query(`DELETE FROM assistants WHERE id = '00000000-0000-4000-8000-000000000023'`);
      expect((await db.query('SELECT 1 FROM run_steps')).rows).toHaveLength(0);
      await db.query(`DELETE FROM conversations WHERE id = '00000000-0000-4000-8000-000000000021'`);
      expect((await db.query('SELECT 1 FROM conversation_messages')).rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  it('跨账号挂接在库层失败：助手不能挂别人的会话，成员组不能挂别人的成员', async () => {
    const db = await openPglite();
    await db.exec(`
      INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000011', 'owner', 'assistant', 't', ${NOW}, ${NOW});
      INSERT INTO members (id, user_id, name, created_at, updated_at) VALUES ('m-a', 'owner', 'A', ${NOW}, ${NOW});
    `);
    await expect(
      db.query(`INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000012', 'u-b', 'a', '0123456789', 'Asia/Shanghai', '00000000-0000-4000-8000-000000000011', ${NOW}, ${NOW})`),
    ).rejects.toThrow(/foreign key/);
    await db.exec(`
      INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000013', 'u-b', 'assistant', 't', ${NOW}, ${NOW});
      INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000014', 'u-b', 'a', '0123456789', 'Asia/Shanghai', '00000000-0000-4000-8000-000000000013', ${NOW}, ${NOW});
    `);
    await expect(db.query(`INSERT INTO assistant_members (assistant_id, user_id, member_id, role) VALUES ('00000000-0000-4000-8000-000000000014', 'u-b', 'm-a', 'lead')`)).rejects.toThrow(/foreign key/);
    await expect(db.query(`UPDATE assistants SET lead_member_id = 'm-a' WHERE id = '00000000-0000-4000-8000-000000000014'`)).rejects.toThrow(/foreign key/);
    await db.close();
  });
});
