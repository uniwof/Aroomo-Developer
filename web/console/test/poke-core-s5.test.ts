/** Poke Core 数据 切片 5（审计 C9）：群聊把挑的成员名单交给 Core */
import { describe, expect, it, vi } from 'vitest';
import { streamChat } from '@/chat/store';

describe('切片 5：群成员名单', () => {
  it('带 group 时请求体里有名单；不带就没有', async () => {
    const bodies: string[] = [];
    const f = vi.fn(async (_u: string, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    for await (const _ of streamChat([{ id: 'u1', role: 'user', text: '大家好' }], 'aroomo', new AbortController().signal, f, undefined, { group: ['甲模型', '乙模型'] })) void _;
    for await (const _ of streamChat([{ id: 'u1', role: 'user', text: '你好' }], 'aroomo', new AbortController().signal, f)) void _;
    expect(JSON.parse(bodies[0]!).group).toEqual(['甲模型', '乙模型']);
    expect(JSON.parse(bodies[1]!).group).toBeUndefined();
  });
});
