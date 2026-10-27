import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent' }));
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
      payload: { text: '@Groq hi', members: [{ id: 'groq', name: 'Groq', enabled: true }], leadId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'mention', targets: ['groq'] });
  });

  it('请求体不合法时 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/route-preview', payload: { text: 1 } });
    expect(res.statusCode).toBe(400);
  });
});
