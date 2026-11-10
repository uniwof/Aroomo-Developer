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
 * 开了 FORCE RLS、但暂不进 release-precheck 清单的表（#345 P0，迁移 0036），每条写理由。
 * release-precheck 检查 1 要求清单里的表有文本列 user_id，且 scripts/test-release-precheck.sh 的假库里要建同名表：
 * - user_sessions：user_id 是 uuid（外键 users.id），不可能有空串 / NULL；
 * - confirm_challenges：user_id 是 0036 新加并按 actor 回填的列，上线前的库里还没有这一列；
 * - client_tokens / exec_tasks / exec_takeovers / executors：user_id 早就是 text NOT NULL，0036 的非空串 CHECK 用 NOT VALID，旧数据里的空串不挡迁移。
 *   这四张加进清单要同步改 scripts/test-release-precheck.sh 的假库与「检查了 N 张」的断言（脚本归 #229 的线），已在 PR 里记了跟进。
 */
const NOT_IN_PRECHECK_LIST = ['client_tokens', 'confirm_challenges', 'exec_takeovers', 'exec_tasks', 'executors', 'user_sessions'];

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
});
