/**
 * CLI：在当前环境（staging / 测试）创建或校正固定测试账号「小号」（D205），可重复运行。
 *
 *   CORE_DATABASE_URL=… XIAOHAO_EMAIL=… XIAOHAO_PASSWORD=… node dist/seed/xiaohao.js
 *
 * 凭据只经环境变量注入（服务器 .env 或保险箱），不写进仓库；本程序不打印邮箱以外的任何凭据。
 * 生产环境默认拒绝运行（NODE_ENV=production 且未设 XIAOHAO_ALLOW_PRODUCTION=1）。
 */
import { createPgDb } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { PgUserStore } from '../users/pg.js';
import { seedXiaohao } from '../users/seed.js';

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = env.CORE_DATABASE_URL;
  const email = env.XIAOHAO_EMAIL;
  const password = env.XIAOHAO_PASSWORD;
  if (!url || !email || !password) {
    process.stderr.write('需要环境变量 CORE_DATABASE_URL、XIAOHAO_EMAIL、XIAOHAO_PASSWORD\n');
    return 2;
  }
  if (env.NODE_ENV === 'production' && env.XIAOHAO_ALLOW_PRODUCTION !== '1') {
    process.stderr.write('生产环境不创建小号（如确需，设 XIAOHAO_ALLOW_PRODUCTION=1）\n');
    return 3;
  }
  const db = createPgDb(url, { max: 1 });
  try {
    await migrate(db);
    const r = await seedXiaohao(new PgUserStore(db), { email, password }, () => new Date());
    process.stdout.write(`小号 ${r.outcome}：${email}（id ${r.userId}）\n`);
    return 0;
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`小号 seed 失败：${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
