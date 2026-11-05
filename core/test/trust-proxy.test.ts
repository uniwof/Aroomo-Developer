/**
 * #259 负责人必改 2：登录限速按「邮箱 + 来源 IP」算。Core 在 Shell / cloudflared 后面时，只有信任容器网络里的上一跳（CORE_TRUST_PROXY），
 * req.ip 才是浏览器的真实 IP；否则所有人都是同一个 IP，别人输错 5 次就会把所有者也锁 15 分钟。
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ConfigError, loadConfig, toSafeJSON } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const apps: FastifyInstance[] = [];
afterAll(async () => {
  for (const a of apps) await a.close();
});

async function setup(trust?: string) {
  const clock = fakeClock();
  const app = buildServer(
    loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', ...(trust ? { CORE_TRUST_PROXY: trust } : {}) }),
    memoryDeps(clock.now),
  );
  apps.push(app);
  const inv = await app.inject({ method: 'POST', url: '/api/users/invites', headers: ownerAuth, payload: { email: 'owner@example.com', role: 'admin' } });
  expect((await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } })).statusCode).toBe(200);
  // app.inject 的直连地址是 127.0.0.1（相当于容器网络里的 Shell）
  const login = (ip: string, password: string) =>
    app.inject({ method: 'POST', url: '/auth/login', headers: { 'x-forwarded-for': ip }, payload: { email: 'owner@example.com', password } });
  return { login };
}

describe('登录限速按真实来源 IP（CORE_TRUST_PROXY）', () => {
  it('信任上一跳：别的 IP 连错 5 次被锁，所有者从自己的 IP 照样能登录', async () => {
    const { login } = await setup('loopback,uniquelocal');
    for (let i = 0; i < 5; i++) expect((await login('203.0.113.7', 'wrong-password')).statusCode).toBe(401);
    expect((await login('203.0.113.7', PW)).statusCode).toBe(429);
    expect((await login('198.51.100.9', PW)).statusCode).toBe(200);
  });

  it('不信任（默认）：X-Forwarded-For 被忽略，所有请求算同一个 IP（说明为什么要配）', async () => {
    const { login } = await setup();
    for (let i = 0; i < 5; i++) await login('203.0.113.7', 'wrong-password');
    expect((await login('198.51.100.9', PW)).statusCode).toBe(429);
  });

  it('CORE_TRUST_PROXY 只接受 loopback / linklocal / uniquelocal / IP / CIDR', () => {
    expect(loadConfig({ CORE_TRUST_PROXY: 'uniquelocal, 172.18.0.0/16, ::1' }).trustProxy).toBe('uniquelocal, 172.18.0.0/16, ::1');
    for (const bad of ['true', '*', '10.0.0.0/33', 'evil.example']) expect(() => loadConfig({ CORE_TRUST_PROXY: bad })).toThrow(ConfigError);
    expect(toSafeJSON(loadConfig({})).trustProxy).toBe('(unset)');
  });
});
