'use strict';
/**
 * 独立版启动收藏（Karakeep，官方镜像里的程序原样使用，一个文件都不改）。代替镜像里 s6 的三个服务脚本：
 *   web       先跑数据库迁移（/db_migrations/index.js，同 init-db-migration），再启动 Next.js（apps/web/server.js，同 svc-web）
 *   workers   后台任务（apps/workers/dist/index.js，同 svc-workers）：抓网页、搜索索引、OCR、AI 打标签
 *   backup <库文件> <目标文件>   用 SQLite 在线备份接口拷一份一致的副本（备份时用，服务可以在运行）
 * 环境变量由 AroomoStandalone.psm1 传入（KARAKEEP_DIR、DATA_DIR 等），本文件不打印任何密钥。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const dir = process.env.KARAKEEP_DIR;
if (!dir) {
  console.error('karakeep-start: 缺少 KARAKEEP_DIR');
  process.exit(2);
}
const mode = process.argv[2];

async function main() {
  if (mode === 'backup') {
    const [src, dst] = process.argv.slice(3);
    if (!src || !dst) throw new Error('用法：karakeep-start.cjs backup <库文件> <目标文件>');
    const Database = require(path.join(dir, 'node_modules', 'better-sqlite3'));
    const db = new Database(src, { readonly: true, fileMustExist: true });
    try {
      await db.backup(dst);
    } finally {
      db.close();
    }
    console.log('karakeep-start: 收藏数据库已导出。');
    return;
  }
  if (mode === 'web') {
    console.log('karakeep-start: 正在执行数据库迁移。');
    const migDir = path.join(dir, 'db_migrations');
    const mig = spawnSync(process.execPath, [path.join(migDir, 'index.js')], { cwd: migDir, stdio: 'inherit', env: process.env });
    if (mig.status !== 0) {
      console.error(`karakeep-start: 数据库迁移失败（退出码 ${mig.status}）`);
      process.exit(mig.status || 1);
    }
    const web = path.join(dir, 'apps', 'web');
    process.chdir(web);
    console.log('karakeep-start: 正在启动收藏界面。');
    await import(pathToFileURL(path.join(web, 'server.js')).href);
    return;
  }
  if (mode === 'workers') {
    const w = path.join(dir, 'apps', 'workers');
    process.chdir(w);
    console.log('karakeep-start: 正在启动后台任务。');
    await import(pathToFileURL(path.join(w, 'dist', 'index.js')).href);
    return;
  }
  throw new Error('用法：karakeep-start.cjs web | workers | backup <库文件> <目标文件>');
}

main().catch((e) => {
  console.error(`karakeep-start: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
