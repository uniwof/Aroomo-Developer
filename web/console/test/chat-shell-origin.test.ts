/**
 * 从 Shell 打开控制台时（页面带 aroomo-shell 标记），对话流也走 Shell 同源：POST /api/chat/stream（Shell 白名单直通 Core，
 * 负责人 2026-11-05 19:47 裁定）。不改成 /aroomo/api（那条带主人令牌），也不指向任何聊天子域名。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.head.querySelector('meta[name="aroomo-shell"]')?.remove();
  vi.resetModules();
});

describe('从 Shell 打开时的对话地址', () => {
  it('streamChat 只发同源相对路径 /api/chat/stream，带 Cookie、不带 Authorization', async () => {
    const m = document.createElement('meta');
    m.name = 'aroomo-shell';
    m.content = '1';
    document.head.appendChild(m);
    vi.resetModules();
    const api = await import('@/lib/api');
    const store = await import('@/chat/store');
    expect(api.viaShell).toBe(true);
    // 其他接口仍走 /aroomo/api（Shell 附加令牌）；对话流不走这条
    expect(api.apiUrl('/api/members')).toBe('/aroomo/api/members');
    expect(store.STREAM_URL).toBe('/api/chat/stream');
    const calls: Array<[string, RequestInit]> = [];
    const f = (async (u: string, init: RequestInit) => {
      calls.push([u, init]);
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    for await (const _ of store.streamChat([{ role: 'user', text: 'hi' }], 'aroomo', new AbortController().signal, f)) void _;
    expect(calls).toHaveLength(1);
    const [u, init] = calls[0]!;
    expect(u).toBe('/api/chat/stream');
    expect(init.credentials).toBe('same-origin');
    const h = init.headers as Record<string, string>;
    expect(h['x-aroomo-request']).toBe('1');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});
