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
    }) + '\n',
  );
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
