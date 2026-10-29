import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

describe('GET /api/mcp/config', () => {
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(fakeClock().now));
  afterAll(() => app.close());
  it('需要登录', async () => {
    expect((await app.inject({ url: '/api/mcp/config' })).statusCode).toBe(401);
  });
  it('返回地址和占位符，不含令牌', async () => {
    const r = await app.inject({ url: '/api/mcp/config', headers: { ...ownerAuth, host: 'core.example.com' } });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.url).toBe('https://core.example.com/mcp');
    expect(r.body).toContain('<YOUR_ARC_TOKEN>');
    expect(r.body).not.toContain(OWNER_TOKEN);
  });
});
