/** B3：扫描 core/src 里所有 systemScoped( 调用，必须在白名单内（新增调用处要负责人审）。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// 文件 → 允许的调用次数
const ALLOW: Record<string, number> = {
  'assistants/pg.ts': 2, // systemActiveRuns（重启恢复）/ systemDueAssistants（定时执行器第一步）：只读找行，改写切回 userScoped
  'members/pg.ts': 1, // userIds：系统定时任务列出有成员的用户
  'vault/pg.ts': 2, // countAll / countLive：只给启动检查（vaultStartupCheck）用，只读计数，不对用户接口开放
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('systemScoped 白名单', () => {
  it('只在白名单文件里按次数调用', () => {
    const found: Record<string, number> = {};
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).replaceAll('\\', '/');
      if (rel === 'db/scope.ts') continue;
      const n = (readFileSync(f, 'utf8').match(/\bsystemScoped\(/g) ?? []).length;
      if (n > 0) found[rel] = n;
    }
    expect(found).toEqual(ALLOW);
  });
});
