/**
 * scripts/lib/rls-tables.txt（release-precheck 检查 1 的清单）要列全：迁移里每一张 FORCE ROW LEVEL SECURITY 的表都得在里面，
 * 清单里也不能有迁移里没开 FORCE RLS 的表。以前靠「同一个 PR 记得加」，push_subscriptions（0029）就漏了（行为审计 2026-11-05 第 1 项）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIG = fileURLToPath(new URL('../migrations/', import.meta.url));
const LIST = fileURLToPath(new URL('../../scripts/lib/rls-tables.txt', import.meta.url));

/** 去掉 -- 行尾注释和 /* *\/ 块注释后，找 ALTER TABLE <表> FORCE ROW LEVEL SECURITY；被 DROP TABLE 的表去掉 */
function forcedTables(): string[] {
  const forced = new Set<string>();
  for (const f of readdirSync(MIG).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = readFileSync(MIG + f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ');
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi)) forced.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) forced.delete(m[1]!.toLowerCase());
  }
  return [...forced].sort();
}

/**
 * 开了 FORCE RLS、但不进 release-precheck 清单的表（#345 P0 迁移 0036、P1 迁移 0037、P2 迁移 0038），每条写理由（负责人第 1 轮裁定接受这两张）。
 * release-precheck 检查 1 只认文本列 user_id，查的是「空串 / NULL」：
 * - user_sessions：user_id 是 uuid（外键 users.id），类型上就不可能有空串，NOT NULL 由列约束保证；
 * - confirm_challenges：user_id 是 0036 新加、按 actor 回填的列（CHECK 非空串、且必须等于 confirm_challenge_scope(actor)，都是 VALID），
 *   上线前的生产库里还没有这一列，进清单会让发布前预检在 0036 上生产前失败；0036 上生产之后再进清单。
 *   上生产前要查的是 actor 为 NULL / 空串的行（#229），不是 user_id。
 * - core_settings：user_id 是 0037 新加、按键名前缀回填的列，上线前的生产库里还没有这一列，理由同 confirm_challenges；0037 上生产之后再进清单。
 * - users / user_invites / audit_log（0038）：没有文本列 user_id（users 按 id、user_invites 按 created_by、audit_log 按 actor_id），不适用 precheck 的 user_id 检查；
 * client_tokens / exec_tasks / exec_takeovers / executors 已在清单里（M4：非空串 CHECK 是 NOT VALID，旧空串靠预检拦）。
 */
const NOT_IN_PRECHECK_LIST = ['audit_log', 'confirm_challenges', 'core_settings', 'user_invites', 'user_sessions', 'users'];

function listed(): string[] {
  return readFileSync(LIST, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .sort();
}

describe('rls-tables.txt 和迁移一致', () => {
  it('每张 FORCE RLS 的表都在清单里，清单里没有多余的表', () => {
    const forced = forcedTables();
    expect(forced.length).toBeGreaterThan(10);
    expect(listed()).toEqual(forced.filter((t) => !NOT_IN_PRECHECK_LIST.includes(t)));
    // 豁免名单里的表必须真的开了 FORCE RLS（不能留着已经删掉的表名）
    for (const t of NOT_IN_PRECHECK_LIST) expect(forced, t).toContain(t);
  });
  it('push_subscriptions（0029）在清单里', () => {
    expect(listed()).toContain('push_subscriptions');
  });
  it('#345 P0 的四张 text user_id 表在清单里（M4）', () => {
    for (const t of ['client_tokens', 'exec_tasks', 'exec_takeovers', 'executors']) expect(listed(), t).toContain(t);
  });
});
