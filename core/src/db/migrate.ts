/**
 * 极简迁移器：按文件名顺序执行 core/migrations/NNNN_name.sql，每个文件只执行一次。
 *
 * - 记录表 core_schema_migrations(version, applied_at)。
 * - 整个迁移过程在一个事务里，并持有事务级 advisory lock，多实例同时启动也只会执行一次。
 * - 迁移文件一旦合并到 dev 就不能修改，只能新增（与 PRODUCT §17.2.3 的可追溯要求一致）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

/** src/db 与 dist/db 往上两级都是 core/（镜像里是 /app/），迁移目录在那里。 */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;
/** 任意固定数字，用作 advisory lock 的键（"aroomo" 的 ASCII 求和变体）。 */
const LOCK_KEY = 7_202_633;

export function listMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort();
}

/** 执行尚未执行的迁移，返回本次执行的文件名。 */
export async function migrate(db: Db, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = listMigrations(dir);
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await q.exec(
      'CREATE TABLE IF NOT EXISTS core_schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await q.query<{ version: string }>('SELECT version FROM core_schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await q.exec(readFileSync(`${dir}/${f}`, 'utf8'));
      await q.query('INSERT INTO core_schema_migrations (version) VALUES ($1)', [f]);
      applied.push(f);
    }
    return applied;
  });
}
