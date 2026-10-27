import { ConfigError, loadConfig, toSafeJSON } from './config.js';
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

  const app = buildServer(cfg);
  app.log.info({ config: toSafeJSON(cfg) }, 'aroomo-core starting');

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
