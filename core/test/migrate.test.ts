import { describe, expect, it } from 'vitest';
import { listMigrations, migrate } from '../src/db/migrate.js';
import { openPglite } from './helpers/db.js';

describe('migrate', () => {
  it('按顺序执行一次；重复执行不重复', async () => {
    const db = await openPglite(false);
    const first = await migrate(db);
    expect(first).toEqual(listMigrations());
    expect(first[0]).toBe('0001_audit_log.sql');
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });
});
