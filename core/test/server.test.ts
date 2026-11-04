import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const auth = { authorization: 'Bearer test-owner-token-0123456789abcdef0123' };
const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: 'test-owner-token-0123456789abcdef0123' }));
afterAll(() => app.close());

describe('HTTP', () => {
  it('GET /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'aroomo-core' });
  });

  it('POST /internal/route-preview 返回路由计划', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/route-preview',
      headers: auth,
      payload: { text: '@Groq hi', members: [{ id: 'groq', name: 'Groq', enabled: true }], leadId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'mention', targets: ['groq'] });
  });

  it('route-preview 不带令牌 401（#235 必改2：不能有免验身份接口）', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/route-preview', payload: { text: 'x', members: [] } });
    expect(res.statusCode).toBe(401);
  });

  it('请求体不合法时 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/route-preview', headers: auth, payload: { text: 1 } });
    expect(res.statusCode).toBe(400);
  });
});
