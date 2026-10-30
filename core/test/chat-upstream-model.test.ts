import { describe, expect, it } from 'vitest';
import { ChatService } from '../src/chat/service.js';

const run = async (upstreamModel?: (n: string) => string) => {
  const seen: string[] = [];
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    seen.push((JSON.parse(init.body) as { model: string }).model);
    return new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
  const svc = new ChatService({
    litellmBaseUrl: 'http://x',
    litellmKey: 'placeholder-key',
    listMembers: async () => [{ id: 'm1', name: 'GPT', aliases: [], enabled: true, status: 'active' } as never],
    lead: { get: async () => ({ effectiveLeadId: 'm1' }) } as never,
    upstreamModel,
    fetchImpl,
  });
  await svc.complete({ model: 'other', messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal);
  return seen;
};

describe('上游模型名映射', () => {
  it('账号成员的上游名带前缀；不传映射时保持原名', async () => {
    expect(await run((n) => `uab12/${n}`)).toEqual(['uab12/GPT']);
    expect(await run()).toEqual(['GPT']);
  });
  it('A 的成员名等于所有者的模型名时，上游名仍带 A 的前缀', async () => {
    expect(await run((n) => `uab12/${n}`)).not.toContain('GPT');
  });
  it('单次调用的上下文覆盖全局映射，互不串用户', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      seen.push((JSON.parse(init.body) as { model: string }).model);
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch;
    const svc = new ChatService({
      litellmBaseUrl: 'http://x', litellmKey: 'placeholder-key',
      listMembers: async () => [{ id: 'm1', name: 'GPT', aliases: [], enabled: true, status: 'active' } as never],
      lead: { get: async () => ({ effectiveLeadId: 'm1' }) } as never,
      fetchImpl,
    });
    const req = { model: 'other', messages: [{ role: 'user', content: 'hi' }] };
    await svc.complete(req, new AbortController().signal, { upstreamModel: (n) => `ua/${n}` } as never);
    await svc.complete(req, new AbortController().signal, { upstreamModel: (n) => `ub/${n}` } as never);
    await svc.complete(req, new AbortController().signal);
    expect(seen).toEqual(['ua/GPT', 'ub/GPT', 'GPT']);
  });
});
