import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { rlsTargets } from './helpers/rls.js';

describe.each(rlsTargets)('RLS 测试角色权限与生产授权一致（$name，#413）', (target) => {
  let db: Db | undefined;
  afterEach(async () => {
    await db?.exec('RESET ROLE').catch(() => undefined);
    await db?.close();
    db = undefined;
  });

  it('测试角色对 audit_log 无 UPDATE / DELETE，对迁移记录表不能写', async () => {
    db = await target.open();
    const { rows } = await db.query<{ u: boolean; d: boolean; m: boolean }>(
      `SELECT has_table_privilege(current_user,'audit_log','UPDATE') AS u,
              has_table_privilege(current_user,'audit_log','DELETE') AS d,
              has_table_privilege(current_user,'core_schema_migrations','INSERT') AS m`,
    );
    expect(rows[0]).toEqual({ u: false, d: false, m: false });
  });
});
