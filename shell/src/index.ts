import { loadConfig } from './config.js';
import { createShellServer } from './server.js';

const cfg = loadConfig();
const server = createShellServer(cfg);
server.listen(cfg.port, cfg.host, () => {
  process.stdout.write(
    JSON.stringify({
      msg: 'aroomo-shell listening',
      port: cfg.port,
      lobe: cfg.lobeUpstream.origin,
      core: cfg.coreUpstream.origin,
      auth: cfg.auth,
      coreTokenConfigured: Boolean(cfg.coreOwnerToken),
      ownerConfigured: Boolean(cfg.auth === 'core-session' ? cfg.ownerEmail : cfg.ownerUserId || cfg.localOwner),
    }) + '\n',
  );
  if (cfg.auth === 'core-session' && !cfg.ownerEmail)
    process.stdout.write(JSON.stringify({ level: 'warn', msg: '没有设置 SHELL_OWNER_EMAIL：控制台和 /aroomo/api 对所有人返回 403' }) + '\n');
  if (cfg.auth === 'lobe-session' && !cfg.ownerUserId && !cfg.localOwner)
    process.stdout.write(JSON.stringify({ level: 'warn', msg: '没有设置 SHELL_OWNER_USER_ID：控制台和 /aroomo/api 对所有人返回 403' }) + '\n');
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
