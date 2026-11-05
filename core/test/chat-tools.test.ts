/**
 * X-05 工具调用过程可见（docs/api/stream-parts.md）：脱敏、合并分段、详细程度、存库上限、流里的 data-aroomo-tool。
 * 纯函数 + toUiMessageStream，不起服务器（接口层的所有者 / 家人差别见 x23-cross-account.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { toUiMessageStream } from '../src/chat/stream.js';
import { HIDDEN, TOOL_MAX_PER_REPLY, TOOL_PART, ToolCollector, fitForStorage, redactArgs, redactText, redactUrl, toolLabel, type ToolPartData } from '../src/chat/tool-parts.js';

const enc = new TextEncoder();
const sk = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0'].join('-');

function upstream(deltas: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const d of deltas) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: d }] })}\n\n`));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
}
async function read(s: ReadableStream<Uint8Array>): Promise<Array<Record<string, unknown>>> {
  const body = await new Response(s).text();
  return body
    .split('\n\n')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('data:') && !e.includes('[DONE]'))
    .map((e) => JSON.parse(e.slice(5)) as Record<string, unknown>);
}

const SEARCH_ARGS = JSON.stringify({ query: '免费模型', api_key: sk, url: 'https://user:pw@example.com/s?q=1&token=abc#x', headers: { Cookie: 'sid=1', Accept: 'json' } });
const searchDeltas = [
  { executed_tools: [{ index: 0, type: 'search', arguments: SEARCH_ARGS }] },
  { executed_tools: [{ index: 0, type: 'search', output: `结果一 https://a.example/p?ref=${sk}\n结果二`, search_results: { results: [1, 2, 3, 4, 5] } }] },
  { content: '找到 5 条' },
];

describe('X-05 脱敏', () => {
  it('网址：去掉账号密码、查询参数、#片段，留域名和路径', () => {
    expect(redactUrl('https://user:pw@example.com/a/b?q=1#frag')).toBe('https://example.com/a/b?…');
    expect(redactUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(redactText('看 http://x.test/p?key=1 和 https://y.test/')).toBe('看 http://x.test/p?… 和 https://y.test/');
    // 路径里的凭据（Groq 小审）：key=… 这类段、24 位以上字母数字混排的段；普通路径不动
    expect(redactUrl('https://example.com/api/key=ABC123/list')).toBe(`https://example.com/api/${HIDDEN}/list`);
    expect(redactUrl('https://api.example.org/bot123456789:AAEhBP0av28Zz1x2y3w4v5u6t7/sendMessage')).toBe(`https://api.example.org/${HIDDEN}/sendMessage`);
    expect(redactUrl('https://example.com/blog/2026/how-to-pick-a-free-model')).toBe('https://example.com/blog/2026/how-to-pick-a-free-model');
  });

  it('文字里像密钥的串换掉：sk- / Bearer / 长十六进制', () => {
    const t = redactText(`key ${sk} auth Bearer abcdefgh12345678 hash ${'a'.repeat(40)} 普通的话`);
    expect(t).not.toContain(sk);
    expect(t).not.toContain('abcdefgh12345678');
    expect(t).not.toContain('a'.repeat(40));
    expect(t).toContain('普通的话');
  });

  it('参数：键名像密钥的整值隐藏（含嵌套、大小写），网址去参数；不是 JSON 就按文字脱敏', () => {
    const a = JSON.parse(redactArgs(SEARCH_ARGS)) as Record<string, unknown>;
    expect(a).toEqual({ query: '免费模型', api_key: HIDDEN, url: 'https://example.com/s?…', headers: { Cookie: HIDDEN, Accept: 'json' } });
    expect(redactArgs(`{"half": "${sk}`)).not.toContain(sk);
    expect(redactArgs('')).toBe('');
  });

  it('工具名 → 人话', () => {
    expect(toolLabel('search')).toBe('搜了网页');
    expect(toolLabel('browser.search')).toBe('搜了网页');
    expect(toolLabel('read_webpage')).toBe('读了网页');
    expect(toolLabel('python')).toBe('运行了代码');
    expect(toolLabel('weird')).toBe('用了工具 weird');
  });
});

describe('X-05 收集工具调用', () => {
  it('executed_tools 分两段来（先参数、后结果）：合成一个，done，5 条结果；所有者有参数和结果，家人只有摘要', () => {
    const c = new ToolCollector();
    for (const d of searchDeltas) c.add(d);
    const [full] = c.parts('full');
    expect(full).toMatchObject({ index: 0, name: 'search', label: '搜了网页', state: 'done', count: 5, summary: '5 条结果' });
    expect(full!.args).toContain(HIDDEN);
    expect(full!.args).not.toContain(sk);
    expect(full!.result).toContain('https://a.example/p?…');
    expect(full!.result).not.toContain(sk);
    const [sum] = c.parts('summary');
    expect(sum).toEqual({ index: 0, name: 'search', label: '搜了网页', state: 'done', count: 5, summary: '5 条结果' });
  });

  it('tool_calls（模型想调函数，Core 没给成员开工具）：参数分段拼起来，记成「没开放」，不执行', () => {
    const c = new ToolCollector();
    c.add({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_webpage', arguments: '{"url":"https://x.test/?' } }] });
    c.add({ tool_calls: [{ index: 0, function: { arguments: 'a=1"}' } }] });
    const [p] = c.parts('full');
    expect(p).toMatchObject({ name: 'read_webpage', label: '读了网页', state: 'unavailable', summary: '这个工具还没有开放给成员，没有执行' });
    expect(JSON.parse(p!.args!)).toEqual({ url: 'https://x.test/?…' });
    expect(p!.result).toBeUndefined();
  });

  it('一条回复最多记 20 个；工具名里的怪字符去掉；存库超长时先去结果再去参数，摘要留着', () => {
    const c = new ToolCollector();
    c.add({ executed_tools: Array.from({ length: 25 }, (_, i) => ({ index: i, type: 'search<script>', arguments: '参数 '.repeat(300), output: '结果 '.repeat(450) })) });
    expect(c.size).toBe(TOOL_MAX_PER_REPLY);
    expect(c.dropped).toBe(5);
    const parts = c.parts('full');
    expect(parts[0]!.name).toBe('searchscript');
    const fit = fitForStorage(parts);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(15_000);
    expect(fit.every((p) => p.summary)).toBe(true);
    // 参数加起来就超了：结果全去掉，参数从后往前去，前面的留着
    expect(fit.every((p) => p.result === undefined)).toBe(true);
    expect(fit[0]!.args).toBeDefined();
    expect(fit.at(-1)!.args).toBeUndefined();
    // 不超就原样
    expect(fitForStorage(parts.slice(0, 2))).toEqual(parts.slice(0, 2));
  });
});

describe('X-05 流里的 data-aroomo-tool', () => {
  it('拿到结果就即时发一次，结束时再发最终的；同一个调用 id 不变（浏览器按 id 覆盖）；正文照常；onFinish 拿到工具', async () => {
    let saved: ToolPartData[] = [];
    const ev = await read(toUiMessageStream(upstream(searchDeltas), { messageId: 'm1', toolDetail: 'full', onFinish: async (_t, tools) => void (saved = tools) }));
    const tools = ev.filter((e) => e.type === TOOL_PART);
    expect(tools.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tools.map((e) => e.id))).toEqual(new Set(['m1_tool_0']));
    expect(tools.at(-1)!.data).toMatchObject({ state: 'done', count: 5 });
    expect((tools.at(-1)!.data as ToolPartData).args).toBeDefined();
    expect(ev.filter((e) => e.type === 'text-delta').map((e) => e.delta).join('')).toBe('找到 5 条');
    expect(saved).toHaveLength(1);
    // 工具部件不是 transient：跟着回复留在消息里
    expect(tools.every((e) => e.transient === undefined)).toBe(true);
  });

  it('默认（没说是所有者）只发摘要；没有工具调用就不发', async () => {
    const ev = await read(toUiMessageStream(upstream(searchDeltas)));
    const last = ev.filter((e) => e.type === TOOL_PART).at(-1)!.data as ToolPartData;
    expect(last.args).toBeUndefined();
    expect(last.result).toBeUndefined();
    expect((await read(toUiMessageStream(upstream([{ content: 'hi' }])))).some((e) => e.type === TOOL_PART)).toBe(false);
  });
});
