import { afterAll, describe, expect, it } from 'vitest';
import { CapabilityService, summaryLine } from '../src/capabilities/service.js';
import { loadConfig } from '../src/config.js';
import { memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

describe('能力清单', () => {
  const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off' }), memoryDeps(fakeClock().now));
  afterAll(() => app.close());

  it('需要登录', async () => {
    expect((await app.inject({ url: '/api/capabilities' })).statusCode).toBe(401);
  });

  it('返回计数、徽标和额度，计数与条目一致', async () => {
    const r = await app.inject({ url: '/api/capabilities', headers: ownerAuth });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.items.length).toBeGreaterThan(10);
    expect(b.counts.text + b.counts.image + b.counts.video).toBe(b.items.length);
    expect(b.counts.image).toBeGreaterThanOrEqual(2);
    expect(b.summary).toBe(`文本 ${b.counts.text} · 生图 ${b.counts.image} · 视频 ${b.counts.video}`);
    for (const i of b.items) expect(['free', 'trial', 'paid']).toContain(i.access);
    expect(b.library.skills.total).toBe(148);
    expect(b.library.resources.total).toBe(45);
  });

  it('额度查不到时 quotaKnown=false（界面显示未知），不编数', async () => {
    const b = (await app.inject({ url: '/api/capabilities', headers: ownerAuth })).json();
    const gemini = b.items.find((i: { provider: string }) => i.provider === 'Google Gemini');
    expect(gemini.quota).toBeNull();
    expect(gemini.quotaKnown).toBe(false);
    // 有公开上限但用量查不到：也算未知
    const groq = b.items.find((i: { provider: string }) => i.provider === 'Groq');
    expect(groq.quota.limit).toBe(1000);
    expect(groq.quotaKnown).toBe(false);
  });

  it('验证失败项只标状态，不含 Key', async () => {
    const r = await app.inject({ url: '/api/capabilities', headers: ownerAuth });
    const b = r.json();
    expect(b.items.some((i: { status: string }) => i.status === 'failed')).toBe(true);
    expect(r.body).not.toMatch(/sk-[A-Za-z0-9]{10,}|api[_-]?key["']?\s*:/i);
  });

  it('可按类型和徽标筛选', async () => {
    const img = (await app.inject({ url: '/api/capabilities?kind=image', headers: ownerAuth })).json();
    expect(img.items.every((i: { kind: string }) => i.kind === 'image')).toBe(true);
    const free = (await app.inject({ url: '/api/capabilities?access=free', headers: ownerAuth })).json();
    expect(free.items.every((i: { access: string }) => i.access === 'free')).toBe(true);
    expect((await app.inject({ url: '/api/capabilities?kind=audio', headers: ownerAuth })).statusCode).toBe(400);
  });

  it('summaryLine 对空清单为 0', () => {
    expect(summaryLine([])).toBe('文本 0 · 生图 0 · 视频 0');
    expect(new CapabilityService({ source: 't', items: [], tools: [], library: { skills: { total: 0, groups: [] }, resources: { total: 0, groups: [] } } }).list().counts.video).toBe(0);
  });
});
