'use strict';
/**
 * 独立版启动 LobeHub（代替镜像里的 /app/startServer.js；LobeHub 的文件一个都不改，DECISIONS D66）。
 * 和 startServer.js 做同样的事：
 *   1. 执行数据库迁移（docker.cjs，LobeHub 官方迁移脚本）
 *   2. 启动 Next.js 服务（server.js）
 *   3. 服务就绪后调用一次 /api/agent/gateway/start（与 startServer.js 的 startGateway 相同）
 * 不做的：proxychains（只在设置 PROXY_URL 时用，独立版不需要）；QStash 定时（没有 QSTASH_TOKEN 时 startServer.js 也跳过）。
 * 环境变量由 aroomo-standalone.ps1 传入（LOBE_APP_DIR、DATABASE_URL 等），本文件不打印任何密钥。
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const dir = process.env.LOBE_APP_DIR;
if (!dir) {
  console.error('lobe-start: 缺少 LOBE_APP_DIR');
  process.exit(2);
}

console.log('lobe-start: 正在执行数据库迁移。');
const mig = spawnSync(process.execPath, [path.join(dir, 'docker.cjs')], { cwd: dir, stdio: 'inherit', env: process.env });
if (mig.status !== 0) {
  console.error(`lobe-start: 数据库迁移失败（退出码 ${mig.status}）`);
  process.exit(mig.status || 1);
}

async function startGateway() {
  const secret = process.env.KEY_VAULTS_SECRET;
  if (!secret) return;
  const url = `http://127.0.0.1:${process.env.PORT || 3210}/api/agent/gateway/start`;
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) {
        console.log('lobe-start: Gateway started.');
        return;
      }
    } catch {
      // 服务还没起来，继续等
    }
  }
  console.warn('lobe-start: Gateway did not start (same as startServer.js, not fatal).');
}

void startGateway();
console.log('lobe-start: 正在启动 LobeHub。');
require(path.join(dir, 'server.js'));
