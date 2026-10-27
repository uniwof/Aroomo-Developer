import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindAudit } from '../src/audit/common.js';
import { MemoryAuditLog } from '../src/audit/memory.js';
import { PgAuditLog } from '../src/audit/pg.js';
import { REDACTED, redactSecrets } from '../src/audit/redact.js';
import type { AuditLog } from '../src/audit/types.js';
import type { Db } from '../src/db/db.js';
import { dbTargets, fakeClock } from './helpers/db.js';

/** 假密钥在运行时拼出来，源码里不出现完整的「像密钥的」字面量（避免 gitleaks 误报）。 */
const j = (...parts: string[]) => parts.join('');

type Factory = { name: string; make: (now: () => Date) => Promise<{ log: AuditLog; db?: Db }> };

const factories: Factory[] = [
  { name: 'memory', make: async (now) => ({ log: new MemoryAuditLog(now) }) },
  ...dbTargets.map<Factory>((t) => ({
    name: t.name,
    make: async (now) => {
      const db = await t.open();
      return { log: new PgAuditLog(db, now), db };
    },
  })),
];

const owner = { type: 'owner' as const, id: 'owner' };

for (const f of factories) {
  describe(`AuditLog（${f.name}）`, () => {
    const clock = fakeClock();
    let log: AuditLog;
    let db: Db | undefined;

    beforeAll(async () => {
      ({ log, db } = await f.make(clock.now));
      for (let i = 0; i < 25; i += 1) {
        clock.advance(1000);
        await log.append({
          actor: i % 5 === 0 ? { type: 'system', id: 'scheduler' } : owner,
          action: i % 2 === 0 ? 'members.create' : 'members.update',
          target: { type: 'member', id: `m-${i % 3}` },
          result: i === 7 ? 'denied' : 'ok',
          ...(i === 3 ? { note: j('key=', 'sk-', 'placeholder', 'ABCDEFGHIJKLMNOP1234 rotated') } : {}),
        });
      }
    });
    afterAll(async () => db?.close());

    it('追加后可查询，新的在前，带 id 与 ts', async () => {
      const page = await log.query({ limit: 3 });
      expect(page.entries).toHaveLength(3);
      expect(page.entries[0]?.ts.getTime()).toBeGreaterThan(page.entries[1]?.ts.getTime() ?? 0);
      expect(page.entries[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('分页游标稳定：逐页取完不重不漏，期间新追加的不打乱已有页', async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let first = true;
      do {
        const page = await log.query({ limit: 4, ...(cursor ? { cursor } : {}) });
        seen.push(...page.entries.map((e) => e.id));
        if (first) {
          // 取完第一页后再追加一条：后续页不应受影响
          clock.advance(1000);
          await log.append({ actor: owner, action: 'late.append', target: { type: 'x', id: 'y' }, result: 'ok' });
          first = false;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it('按 actor / action / target / 时间过滤', async () => {
      const sys = await log.query({ actor: { type: 'system' }, limit: 100 });
      expect(sys.entries.length).toBe(5);
      const upd = await log.query({ action: 'members.update', target: { type: 'member', id: 'm-1' }, limit: 100 });
      expect(upd.entries.every((e) => e.action === 'members.update' && e.target.id === 'm-1')).toBe(true);
      const from = new Date('2026-10-27T00:00:05.000Z');
      const to = new Date('2026-10-27T00:00:10.000Z');
      const win = await log.query({ from, to, limit: 100 });
      expect(win.entries).toHaveLength(5);
    });

    it('写入前脱敏 note', async () => {
      const page = await log.query({ action: 'members.update', limit: 100 });
      const withNote = page.entries.find((e) => e.note);
      expect(withNote?.note).toContain(REDACTED);
      expect(withNote?.note).not.toContain('sk-placeholder');
    });

    it('非法游标报错', async () => {
      await expect(log.query({ cursor: 'not-a-cursor' })).rejects.toThrow();
    });

    it('接口上没有修改 / 删除方法（运行时）', () => {
      const anyLog = log as unknown as Record<string, unknown>;
      for (const m of ['update', 'delete', 'remove', 'clear', 'truncate', 'set']) {
        expect(anyLog[m]).toBeUndefined();
      }
      expect(Object.isFrozen(log)).toBe(true);
      expect(() => {
        anyLog.delete = () => undefined;
      }).toThrow();
    });

    it('返回的条目被冻结，不能改', async () => {
      const [e] = (await log.query({ limit: 1 })).entries;
      expect(Object.isFrozen(e)).toBe(true);
      expect(() => {
        (e as unknown as { action: string }).action = 'x';
      }).toThrow();
    });

    if (f.name !== 'memory') {
      it('数据库层拒绝 UPDATE / DELETE / TRUNCATE', async () => {
        await expect(db!.query(`UPDATE audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
        await expect(db!.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
        await expect(db!.query(`TRUNCATE audit_log`)).rejects.toThrow(/append-only/);
        const { rows } = await db!.query<{ n: string }>('SELECT count(*)::text AS n FROM audit_log');
        expect(Number(rows[0]?.n)).toBe(26);
      });
    }

    it('bindAudit 便捷函数', async () => {
      const audit = bindAudit(log, owner);
      await audit('inbox.dismiss', { type: 'inbox', id: 'i1' }, 'ok', 'Bearer abcdefghijklmnop');
      const [e] = (await log.query({ action: 'inbox.dismiss' })).entries;
      expect(e).toMatchObject({ actor: owner, target: { type: 'inbox', id: 'i1' }, result: 'ok', note: REDACTED });
    });
  });
}

describe('类型层面没有修改 / 删除方法', () => {
  it('@ts-expect-error 保证编译期也调用不到', () => {
    const log: AuditLog = new MemoryAuditLog();
    const call = () => {
      // @ts-expect-error AuditLog 没有 delete
      log.delete('x');
      // @ts-expect-error AuditLog 没有 update
      log.update('x', {});
    };
    expect(call).toThrow(TypeError);
  });
});

describe('redactSecrets', () => {
  const positives = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'placeholder-sk-ABCDEFGHIJKLMNOPQRST',
    'sk-ant-api03-abcdefghijklmnopqrstuv',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    'Authorization: Bearer abc.def.ghi-jkl_mno',
    'gsk_abcdefghijklmnopqrstuvwxyz0123',
    j('eyJ', 'placeholderHeader', '.', 'placeholderPayload', '.', 'placeholderSignature'),
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    'dGhpcyBpcyBhIHZlcnkgbG9uZyBzZWNyZXQgdmFsdWUxMjM0NTY3ODk=',
    j('https://x.example/v1?api', '_key=', 'placeholder123456'),
  ];
  it.each(positives)('脱敏：%s', (s) => {
    const out = redactSecrets(`前缀 ${s} 后缀`);
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/^前缀 /);
  });

  const negatives = [
    'members.create',
    'risk-free 的任务 task-runner',
    '成员 Gemini 2.5 Pro 已置顶',
    '0b6f1c2e-6c1a-4bd4-9a1e-2f9b1f6a7c11',
    'deadbeef',
    'user@example.com',
    'https://docs.litellm.ai/docs/proxy/model_management',
    'sk-short',
  ];
  it.each(negatives)('不误伤：%s', (s) => {
    expect(redactSecrets(s)).toBe(s);
  });
});
