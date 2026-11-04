import { ConfigError, loadConfig, toSafeJSON } from './config.js';
import { createDeps } from './deps.js';
import { vaultStartupCheck } from './vault/service.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`配置错误：${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const { deps, migrated, storage } = await createDeps(cfg);
  try {
    await vaultStartupCheck(cfg.vaultKey, deps.vault, deps.settings, deps.now);
  } catch (err) {
    process.stderr.write(`保险箱检查失败：${(err as Error).message}\n`);
    process.exit(1);
  }
  const app = buildServer(cfg, deps);
  app.log.info({ config: toSafeJSON(cfg), storage, migrated }, 'aroomo-core starting');
  if (storage === 'memory') app.log.warn('CORE_DATABASE_URL 未设置：使用内存存储，重启后数据丢失（只适合开发 / 演示）');

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: cfg.host, port: cfg.port });
}

void main();
