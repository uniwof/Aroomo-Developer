import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { MemoryAuditLog } from '../src/audit/memory.js';
import { installAuth } from '../src/auth/plugin.js';
import { installErrorHandler } from '../src/http/errors.js';

// /api 鉴权钩子前的全局限速（CodeQL js/missing-rate-limiting）：按凭据分桶，超出 429，错误格式与全站一致
async function app() {
  const a = Fastify();
  installErrorHandler(a);
  installAuth(a, {
    verify: async (t) => (t === 'good' ? { type: 'owner' } : null) as never,
    auditLog: new MemoryAuditLog(),
    ownerConfigured: true,
    rateLimitPerMin: 3,
  });
  a.get('/api/ping', async () => ({ ok: true }));
  await a.ready();
  return a;
}

describe('鉴权限速', () => {
  it('同一凭据超过每分钟上限 → 429 RATE_LIMITED；猜错的令牌同样被限', async () => {
    const a = await app();
    const hit = (tok: string) => a.inject({ url: '/api/ping', headers: { authorization: `Bearer ${tok}` } });
    for (let i = 0; i < 3; i++) expect((await hit('wrong')).statusCode).toBe(401);
    const r = await hit('wrong');
    expect(r.statusCode).toBe(429);
    expect(r.json()).toEqual({ error: { code: 'RATE_LIMITED', message: '请求太频繁，请稍后再试' } });
    // 另一个凭据单独计数（Shell 代理后同一 IP，不能互相挤掉）
    expect((await hit('good')).statusCode).toBe(200);
    await a.close();
  });
});
