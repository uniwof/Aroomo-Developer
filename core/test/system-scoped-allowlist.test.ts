/** B3：扫描 core/src 里所有 systemScoped( 调用，必须在白名单内（新增调用处要负责人审）。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
// 文件 → 允许的调用次数
const ALLOW: Record<string, number> = {
  'assistants/pg.ts': 3, // systemActiveRuns（重启恢复）/ systemDueAssistants（定时执行器第一步）/ systemStaleWaitingRuns（等确认过期作废，裁定 12）：只读找行，改写切回 userScoped
  'audit/pg.ts': 1, // query：只给所有者的 GET /api/audit 读审计（0038 起 audit_log 只有系统范围能读，#345 P2）；追加走任何范围、不 RETURNING
  'clients/pg.ts': 1, // getByHash：登录前按令牌哈希找令牌（还没有 app.user_id），只读；找到后的写入都切回 userScoped（#345 P0）
  'confirm/confirm.ts': 1, // deleteExpired：定时清理先 systemScoped 只读找出有过期记录的归属键，再逐个 userScoped 删（#345 P0）
  'executor/pg.ts': 1, // sweep：定时清扫先 systemScoped 只读找出有活要清的用户，再逐个 userScoped 改（#345 P0）
  'members/pg.ts': 1, // userIds：系统定时任务列出有成员的用户
  'users/pg.ts': 6, // getSession：登录前按会话令牌哈希找会话，只读（#345 P0）；getUser / getUserByEmail / listUsers：登录前按 id、邮箱查、管理员列表，只读；
  // listOpenInvites：管理员列表只读；useInvite：按码哈希标记已用（策略 user_invites_system_redeem 只放行系统范围 UPDATE）（#345 P2，0038）。建号 / 改号 / 建邀请 / 会话写入都在 userScoped
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
