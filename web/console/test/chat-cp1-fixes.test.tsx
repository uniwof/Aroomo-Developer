/**
 * 负责人审查点 1 的必改与补充裁决（#250 spike）：
 * - 必改 3：Markdown 链接防 javascript: / data: / vbscript:，外部链接 rel="noopener noreferrer"；
 * - 裁决 1：网关失败时出错框显示固定的话；「重试」发给原来的成员；Key 无效时改成「去检查 Key」；
 * - 裁决 2：朗读按钮（只读纯文字、代码块略过、网址不读、切段、停止和自动停止、不支持就隐藏、默认只用本机中文语音）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';
import { parseEvent, streamChat, ChatStreamError } from '@/chat/store';
import { CODE_SKIPPED, pickVoice, speakableText, splitForSpeech, speaker } from '@/chat/speech';
import { safeUrl } from '@/chat/Markdown';

const enc = new TextEncoder();
const sse = (objs: unknown[]) => objs.map((o) => (o === 'DONE' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`)).join('');
const uiStream = (deltas: string[]) =>
  sse([{ type: 'start', messageId: 'm' }, { type: 'text-start', id: 't' }, ...deltas.map((d) => ({ type: 'text-delta', id: 't', delta: d })), { type: 'text-end', id: 't' }, { type: 'finish' }, 'DONE']);
const failStream = (code: string, text: string) => sse([{ type: 'start', messageId: 'm' }, { type: 'data-aroomo-failure', data: { code }, transient: true }, { type: 'error', errorText: text }, 'DONE']);
const okResponse = (body: string) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(body));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

const membersFetch = () =>
  vi.fn(async (url: string) => {
    if (url === '/api/members')
      return new Response(JSON.stringify({ members: [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response('{}', { status: 404 });
  });

const renderPage = (fetchImpl?: typeof fetch) =>
  render(
    <MemoryRouter>
      <ChatPage {...(fetchImpl ? { fetchImpl } : {})} />
    </MemoryRouter>,
  );

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText('输入消息'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
};

// ---- 必改 3 ----
describe('必改 3：Markdown 链接只放行 http / https / mailto', () => {
  it('safeUrl：javascript: / data: / vbscript: / file: / 相对地址 / 夹了空白和控制字符的写法都清空', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd', '/relative', '//evil.example', ''])
      expect(safeUrl(bad)).toBe('');
    expect(safeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeUrl('http://example.com')).toBe('http://example.com');
    expect(safeUrl('mailto:a@example.com')).toBe('mailto:a@example.com');
  });

  describe('渲染', () => {
    beforeEach(() => {
      localStorage.clear();
      vi.stubGlobal('fetch', membersFetch());
    });
    afterEach(() => {
      cleanup();
      vi.unstubAllGlobals();
    });

    it('回复里的 [点我](javascript:alert(1)) 等：href 里不出现危险协议；正常链接带 rel="noopener noreferrer"', async () => {
      const reply = '[点我](javascript:alert(1)) [数据](data:text/html,x) [vb](vbscript:msgbox(1)) [好的](https://example.com/ok) <javascript:alert(2)>';
      const chatFetch = (async () => okResponse(uiStream([reply]))) as unknown as typeof fetch;
      const { container } = renderPage(chatFetch);
      send('给我几个链接');
      // 等 Markdown 引擎（按需加载）渲染出正常链接
      const ok = await screen.findByRole('link', { name: '好的' }, { timeout: 8000 });
      expect(ok).toHaveAttribute('href', 'https://example.com/ok');
      expect(ok).toHaveAttribute('rel', 'noopener noreferrer');
      expect(ok).toHaveAttribute('target', '_blank');
      for (const a of container.querySelectorAll('.chat-md a')) {
        const href = a.getAttribute('href') ?? '';
        expect(href).not.toMatch(/javascript:|data:|vbscript:/i);
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      }
      // 危险链接只剩文字，不是链接
      expect(screen.queryByRole('link', { name: '点我' })).toBeNull();
      expect(container.textContent).toContain('点我');
      expect(container.innerHTML).not.toMatch(/href="(javascript|data|vbscript):/i);
    });
  });
});

// ---- 裁决 1 ----
describe('裁决 1：网关失败 → error（失败码 + 固定的话）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', membersFetch());
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('解析失败码部件；streamChat 抛出带失败码的错误', async () => {
    expect(parseEvent('data: {"type":"data-aroomo-failure","data":{"code":"key_invalid"},"transient":true}')).toEqual({ type: 'failure', code: 'key_invalid' });
    expect(parseEvent('data: {"type":"data-aroomo-failure","data":{"code":"rm -rf"}}')).toBeNull();
    const f = (async () => okResponse(failStream('gateway_unreachable', '模型网关连不上，请稍后重试。'))) as unknown as typeof fetch;
    const err = await streamChat([{ role: 'user', text: 'x' }], 'aroomo', new AbortController().signal, f)
      .next()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatStreamError);
    expect((err as ChatStreamError).message).toBe('模型网关连不上，请稍后重试。');
    expect((err as ChatStreamError).code).toBe('gateway_unreachable');
  });

  it('网关连不上：显示固定的话 +「重试」；重试发给原来的成员（同一句话、同一个模型名）', async () => {
    const bodies: unknown[] = [];
    let n = 0;
    const chatFetch = (async (_u: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      n += 1;
      return n === 1 ? okResponse(failStream('gateway_unreachable', '模型网关连不上，请稍后重试。')) : okResponse(uiStream(['回来了\n\n— Kimi']));
    }) as unknown as typeof fetch;
    const { container } = renderPage(chatFetch);
    send('@Kimi 在吗');
    expect(await screen.findByText('模型网关连不上，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /去检查 Key/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试这条回复' }));
    await waitFor(() => expect(container.textContent).toContain('回来了'), { timeout: 8000 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[1]).toMatchObject({ messages: [{ role: 'user', content: '@Kimi 在吗' }] });
  });

  it('Key 无效：不显示「重试」，改成「去检查 Key」（链到 Key 与接入）；读屏也这么说', async () => {
    const chatFetch = (async () => okResponse(failStream('key_invalid', 'Key 无效，请到「成员 → Key 与接入」检查。'))) as unknown as typeof fetch;
    renderPage(chatFetch);
    send('在吗');
    expect(await screen.findByText('Key 无效，请到「成员 → Key 与接入」检查。')).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /去检查 Key/ });
    expect(link).toHaveAttribute('href', '/keys');
    expect(screen.queryByRole('button', { name: '重试这条回复' })).toBeNull();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('去检查 Key'));
  });
});

// ---- 裁决 2 ----
type Utter = { text: string; lang: string; rate: number; voice: unknown; onend: (() => void) | null; onerror: (() => void) | null };

function mockSpeech(voices: Array<{ lang: string; localService: boolean; name: string }>) {
  const spoken: Utter[] = [];
  const synth = {
    speaking: false,
    pending: false,
    speak: vi.fn((u: Utter) => {
      spoken.push(u);
    }),
    cancel: vi.fn(),
    getVoices: () => voices,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  class Utterance {
    lang = '';
    rate = 1;
    voice: unknown = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  vi.stubGlobal('speechSynthesis', synth);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  return { synth, spoken };
}

describe('裁决 2：朗读', () => {
  it('只读纯文字：代码块读成「已略过」，链接只读文字，网址不读，Markdown 符号去掉，署名照读', () => {
    const md = '# 标题\n\n**重点**：看 [文档](https://example.com/doc) 和 https://evil.example/x 。\n\n```js\nconsole.log("secret")\n```\n\n- 第一条\n- 第二条 `x=1`\n\n— Kimi';
    const t = speakableText(md);
    expect(t).toContain('标题');
    expect(t).toContain('重点：看 文档 和');
    expect(t).toContain(CODE_SKIPPED);
    expect(t).toContain('第一条');
    expect(t).toContain('x=1');
    expect(t).toContain('— Kimi');
    for (const no of ['https', 'example.com', 'console.log', 'secret', '**', '#', '```', '- 第']) expect(t).not.toContain(no);
  });

  it('长回复切成小段（句号、问号、换行；单句太长再按逗号切）', () => {
    expect(splitForSpeech('第一句。第二句？第三句\n第四句')).toEqual(['第一句。', '第二句？', '第三句', '第四句']);
    const long = `${'很长的一段话，'.repeat(40)}完。`;
    const parts = splitForSpeech(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(120);
    expect(parts.join('')).toBe(long);
  });

  it('选语音：默认只用本机中文语音；没有本机中文语音且没同意在线 → null', () => {
    const local = { lang: 'zh-CN', localService: true, name: 'Ting' } as SpeechSynthesisVoice;
    const online = { lang: 'zh-CN', localService: false, name: 'Google 普通话' } as SpeechSynthesisVoice;
    const en = { lang: 'en-US', localService: true, name: 'Alex' } as SpeechSynthesisVoice;
    expect(pickVoice([online, local, en], false)).toEqual({ kind: 'local', voice: local });
    expect(pickVoice([online, en], false)).toBeNull();
    expect(pickVoice([online, en], true)).toEqual({ kind: 'online', voice: online });
  });

  describe('按钮', () => {
    beforeEach(() => {
      localStorage.clear();
      vi.stubGlobal('fetch', membersFetch());
    });
    afterEach(() => {
      speaker.stop();
      cleanup();
      vi.unstubAllGlobals();
    });

    const reply = '你好。这是第二句？\n\n```py\nprint("x")\n```\n\n看 [这里](https://example.com)\n\n— Kimi';

    it('浏览器不支持语音合成：不显示朗读按钮', async () => {
      const { container } = renderPage((async () => okResponse(uiStream([reply]))) as unknown as typeof fetch);
      send('hi');
      await waitFor(() => expect(container.textContent).toContain('这是第二句'), { timeout: 8000 });
      await waitFor(() => expect(screen.getByRole('button', { name: '复制整条回复' })).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /朗读/ })).toBeNull();
    });

    it('点了才读（不自动读）；读纯文字、按段读；同一按钮停止；开始新回复自动停止', async () => {
      const { synth, spoken } = mockSpeech([{ lang: 'zh-CN', localService: true, name: 'Ting' }]);
      let n = 0;
      const chatFetch = (async () => okResponse(uiStream([n++ === 0 ? reply : '第二条回复']))) as unknown as typeof fetch;
      renderPage(chatFetch);
      send('hi');
      const btn = await screen.findByRole('button', { name: '朗读这条回复' }, { timeout: 8000 });
      expect(synth.speak).not.toHaveBeenCalled();
      // 键盘可用：是原生 button
      expect(btn.tagName).toBe('BUTTON');
      fireEvent.click(btn);
      expect(spoken.map((u) => u.text)).toEqual(['你好。']);
      expect(spoken[0]!.lang).toBe('zh-CN');
      expect(spoken[0]!.rate).toBe(1);
      // 一段读完接下一段
      for (let i = 0; i < 4; i++) spoken[i]!.onend?.();
      expect(spoken.map((u) => u.text)).toEqual(['你好。', '这是第二句？', CODE_SKIPPED, '看 这里', '— Kimi']);
      expect(spoken.map((u) => u.text).join('')).not.toContain('example.com');
      // 读屏播报 + 同一个按钮变「停止朗读」
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('开始朗读'));
      const stop = screen.getByRole('button', { name: '停止朗读' });
      fireEvent.click(stop);
      expect(synth.cancel).toHaveBeenCalled();
      await waitFor(() => expect(screen.getByRole('button', { name: '朗读这条回复' })).toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('已停止朗读'));
      // 再读，然后开始新回复 → 自动停止
      fireEvent.click(screen.getByRole('button', { name: '朗读这条回复' }));
      expect(screen.getByRole('button', { name: '停止朗读' })).toBeInTheDocument();
      synth.cancel.mockClear();
      send('再说一句');
      expect(synth.cancel).toHaveBeenCalled();
      expect(speaker.speakingId).toBeNull();
    });

    it('切换会话自动停止', async () => {
      const { synth } = mockSpeech([{ lang: 'zh-CN', localService: true, name: 'Ting' }]);
      renderPage((async () => okResponse(uiStream([reply]))) as unknown as typeof fetch);
      send('hi');
      fireEvent.click(await screen.findByRole('button', { name: '朗读这条回复' }, { timeout: 8000 }));
      expect(speaker.speakingId).not.toBeNull();
      synth.cancel.mockClear();
      // Ctrl+Shift+O 新对话 = 换到另一个会话
      fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(speaker.speakingId).toBeNull());
      expect(synth.cancel).toHaveBeenCalled();
    });

    it('本机没有中文语音：按钮写明「用在线语音」，点了才读并记住；语速取设置', async () => {
      localStorage.setItem('aroomo.chat.prefs.v1', JSON.stringify({ speechRate: 1.2 }));
      const { synth, spoken } = mockSpeech([
        { lang: 'zh-CN', localService: false, name: 'Google 普通话' },
        { lang: 'en-US', localService: true, name: 'Alex' },
      ]);
      renderPage((async () => okResponse(uiStream([reply]))) as unknown as typeof fetch);
      send('hi');
      const btn = await screen.findByRole('button', { name: /用在线语音朗读这条回复/ }, { timeout: 8000 });
      expect(synth.speak).not.toHaveBeenCalled();
      fireEvent.click(btn);
      expect(spoken[0]!.voice).toMatchObject({ name: 'Google 普通话' });
      expect(spoken[0]!.rate).toBe(1.2);
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('开始朗读（在线语音）'));
      await waitFor(() => expect(JSON.parse(localStorage.getItem('aroomo.chat.prefs.v1') ?? '{}').speechOnline).toBe(true));
    });
  });
});
