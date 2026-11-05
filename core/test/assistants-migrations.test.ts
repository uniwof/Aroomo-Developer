/** 助手 v1 迁移 0025–0027 + 会话存库 0028 + 送达状态 0029（X-06）：可回退（up → down → up）；消息、步骤只追加（X-21）。 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { openPglite } from './helpers/db.js';

const DOWN = fileURLToPath(new URL('../migrations/down/', import.meta.url));
const NEW = ['0025_conversations.sql', '0026_assistants.sql', '0027_assistant_runs.sql', '0028_saved_conversations.sql', '0029_run_step_received.sql'];
const NOW = "'2026-11-05T14:00:00+08:00'";

const tables = async (db: Awaited<ReturnType<typeof openPglite>>) =>
  (
    await db.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = current_schema()
        AND tablename IN ('conversations','conversation_messages','assistants','assistant_members','assistant_runs','run_steps') ORDER BY 1`,
    )
  ).rows.map((r) => r.t);

describe('助手迁移 0025–0029', () => {
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
    await db.query(`DELETE FROM assistants`);
    expect((await db.query('SELECT 1 FROM run_steps')).rows).toHaveLength(0);
    await db.query(`DELETE FROM conversations`);
    expect((await db.query('SELECT 1 FROM conversation_messages')).rows).toHaveLength(0);
    await db.close();
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
  it('0028 回退：聊天回复（role = assistant）先删掉，列和约束回到 0027 的样子；再 up 一次能用', async () => {
    const db = await openPglite();
    await db.exec(`
      INSERT INTO conversations (id, user_id, kind, title, model, group_names, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000021', 'owner', 'chat', 't', 'aroomo/x', '{甲,乙}', ${NOW}, ${NOW});
      INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, meta, created_at) VALUES ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000021', 'owner', 'assistant', 'hi', '{"imported":true}', ${NOW});
      INSERT INTO conversation_messages (id, conversation_id, user_id, role, content, created_at) VALUES ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000021', 'owner', 'user', 'q', ${NOW});
    `);
    await expect(db.query(`INSERT INTO conversations (id, user_id, kind, title, model, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000024', 'owner', 'chat', 't', 'gpt-4o', ${NOW}, ${NOW})`)).rejects.toThrow(/check/);
    await db.exec(readFileSync(`${DOWN}/0028_saved_conversations.down.sql`, 'utf8'));
    expect((await db.query<{ role: string }>('SELECT role FROM conversation_messages')).rows.map((r) => r.role)).toEqual(['user']);
    await expect(db.query(`SELECT model FROM conversations`)).rejects.toThrow(/model/);
    expect(await migrate(db)).toEqual(['0028_saved_conversations.sql']);
    await db.close();
  });

  it('0029（X-06）：步骤能记 received；回退删掉 received 事件行、约束回到 0028 的样子；再 up 一次能用', async () => {
    const db = await openPglite();
    await db.exec(`
      INSERT INTO conversations (id, user_id, kind, title, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000031', 'owner', 'assistant', 't', ${NOW}, ${NOW});
      INSERT INTO assistants (id, user_id, name, instructions, timezone, conversation_id, created_at, updated_at) VALUES ('00000000-0000-4000-8000-000000000032', 'owner', 'a', '0123456789', 'Asia/Shanghai', '00000000-0000-4000-8000-000000000031', ${NOW}, ${NOW});
      INSERT INTO assistant_runs (id, assistant_id, user_id, trigger, requested_at, status) VALUES ('00000000-0000-4000-8000-000000000033', '00000000-0000-4000-8000-000000000032', 'owner', 'manual', ${NOW}, 'succeeded');
      INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) VALUES
        ('00000000-0000-4000-8000-000000000033', 'owner', 0, 0, 'work', 'pending', ${NOW}),
        ('00000000-0000-4000-8000-000000000033', 'owner', 1, 0, 'work', 'received', ${NOW}),
        ('00000000-0000-4000-8000-000000000033', 'owner', 2, 0, 'work', 'running', ${NOW}),
        ('00000000-0000-4000-8000-000000000033', 'owner', 3, 0, 'work', 'done', ${NOW});
    `);
    await expect(db.query(`INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) VALUES ('00000000-0000-4000-8000-000000000033', 'owner', 4, 0, 'work', 'read', ${NOW})`)).rejects.toThrow(/check/);
    await db.exec(readFileSync(`${DOWN}/0029_run_step_received.down.sql`, 'utf8'));
    expect((await db.query<{ status: string }>('SELECT status FROM run_steps ORDER BY seq')).rows.map((r) => r.status)).toEqual(['pending', 'running', 'done']);
    await expect(db.query(`INSERT INTO run_steps (run_id, user_id, seq, step_no, action, status, created_at) VALUES ('00000000-0000-4000-8000-000000000033', 'owner', 5, 0, 'work', 'received', ${NOW})`)).rejects.toThrow(/check/);
    expect(await migrate(db)).toEqual(['0029_run_step_received.sql']);
    await db.close();
  });
});
