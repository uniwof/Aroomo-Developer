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

  async function configWith(env: string | undefined) {
    const old = process.env.CORE_MCP_LOBEHUB_URL;
    if (env === undefined) delete process.env.CORE_MCP_LOBEHUB_URL;
    else process.env.CORE_MCP_LOBEHUB_URL = env;
    const a = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(fakeClock().now));
    if (old === undefined) delete process.env.CORE_MCP_LOBEHUB_URL;
    else process.env.CORE_MCP_LOBEHUB_URL = old;
    try {
      return (await a.inject({ url: '/api/mcp/config', headers: { ...ownerAuth, host: 'core.example.com' } })).json();
    } finally {
      await a.close();
    }
  }

  it('配了 LobeHub 内部地址就多返回 lobehubUrl 和配置；外部 url 不变；仍不含令牌', async () => {
    const b = await configWith('http://172.29.77.2:8080/mcp');
    expect(b.url).toBe('https://core.example.com/mcp');
    expect(b.lobehubUrl).toBe('http://172.29.77.2:8080/mcp');
    expect(b.lobehubConfig.mcpServers.aroomo.url).toBe('http://172.29.77.2:8080/mcp');
    expect(JSON.stringify(b)).not.toContain(OWNER_TOKEN);
  });

  it('没配或格式不对（非 http、不是 /mcp 结尾、带账号口令）不返回 lobehubUrl', async () => {
    for (const bad of [undefined, '', 'https://x/mcp', 'http://172.29.77.2:8080/other', 'http://u:p@1.2.3.4/mcp', 'http://a b/mcp']) {
      expect((await configWith(bad)).lobehubUrl, String(bad)).toBeUndefined();
    }
  });
});
