import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { OWNER_TOKEN, fakeClock, ownerAuth } from './helpers/db.js';

const CHAT_TOKEN = 'placeholder-chat-token-0123456789abcdefgh';
const chatAuth = { authorization: `Bearer ${CHAT_TOKEN}` };

interface Seen { model: string; messages: Array<{ role: string; content: unknown }>; stream: boolean }

describe('/v1 对话入口（LobeHub → Core → LiteLLM，D31）', () => {
  let upstream: Server;
  let upstreamUrl = '';
  const seen: Seen[] = [];
  const failModels = new Set<string>();
  const leadCapable = new Set<string>(['GPT-4o mini', 'Claude']);
  let app: FastifyInstance;
  let deps: CoreDeps;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        // 模型事实（负责人资格）：这些名字都是能对话、128k、支持工具调用的模型
        if (req.method === 'GET' && req.url === '/model/info') {
          const caps = { mode: 'chat', max_input_tokens: 128000, supports_function_calling: true };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [...leadCapable].map((n) => ({ model_name: n, model_info: { id: n, ...caps } })) }));
          return;
        }
        const body = JSON.parse(raw) as Seen;
        seen.push(body);
        if (req.headers.authorization !== 'Bearer placeholder-master-key-for-tests-0001') {
          res.writeHead(401).end('{}');
          return;
        }
        if (failModels.has(body.model)) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"bad key placeholder"}}');
          return;
        }
        const text = `我是 ${body.model}`;
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
          // 和真实供应商一样：先发 finish_reason 分片，再发用量分片，最后 [DONE]
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {} }], usage: { total_tokens: 3 } })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
        }
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
    await new Promise((r) => upstream.close(r));
  });

  const build = (env: Record<string, string> = {}) => {
    deps = memoryDeps(fakeClock().now);
    app = buildServer(
      loadConfig({
        CORE_LOG_LEVEL: 'silent',
        CORE_OWNER_TOKEN: OWNER_TOKEN,
        CORE_CHAT_TOKEN: CHAT_TOKEN,
        LITELLM_BASE_URL: upstreamUrl,
        LITELLM_MASTER_KEY: 'placeholder-master-key-for-tests-0001',
        ...env,
      }),
      deps,
    );
  };
  beforeEach(async () => {
    await app?.close();
    seen.length = 0;
    failModels.clear();
    leadCapable.clear();
    leadCapable.add('GPT-4o mini').add('Claude');
    build();
  });

  const addMember = (name: string) => app.inject({ method: 'POST', url: '/api/members', headers: ownerAuth, payload: { name } });
  const chat = (content: unknown, opts: { stream?: boolean; model?: string } = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: chatAuth,
      payload: { model: opts.model ?? 'aroomo', stream: opts.stream ?? false, messages: [{ role: 'system', content: 's' }, { role: 'user', content }] },
    });
  const text = (r: { json(): { choices: Array<{ message: { content: string } }> } }) => r.json().choices[0]!.message.content;

  it('鉴权：没配置 503、令牌不对 401；主人令牌不能用来对话', async () => {
    build({ CORE_CHAT_TOKEN: '' });
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: chatAuth })).statusCode).toBe(503);
    build();
    expect((await app.inject({ method: 'GET', url: '/v1/models', headers: ownerAuth })).statusCode).toBe(401);
    const m = await app.inject({ method: 'GET', url: '/v1/models', headers: chatAuth });
    expect(m.json().data.map((d: { id: string }) => d.id)).toEqual(['aroomo', 'aroomo/auto']);
  });

  it('还没有成员：回一句提示，不调用 LiteLLM', async () => {
    const r = await chat('你好');
    expect(text(r)).toContain('填入一个 Key');
    expect(seen).toHaveLength(0);
  });

  it('没有 @ → 交给负责人（流式）；署名在 [DONE] 之前', async () => {
    await addMember('GPT-4o mini');
    await addMember('Claude');
    const r = await chat('写一句诗', { stream: true });
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(seen[0]).toMatchObject({ model: 'GPT-4o mini', stream: true });
    expect(r.body).toContain('我是 GPT-4o mini');
    const doneAt = r.body.indexOf('[DONE]');
    const finishAt = r.body.indexOf('"finish_reason":"stop"');
    const footerAt = r.body.indexOf('GPT-4o mini（负责人）');
    expect(footerAt).toBeGreaterThan(0);
    expect(footerAt).toBeLessThan(doneAt);
    // LobeHub 读到 finish_reason 就收尾：署名必须在结束分片之前（#191）
    expect(finishAt).toBeGreaterThan(0);
    expect(footerAt).toBeLessThan(finishAt);
    expect(r.body.split('GPT-4o mini（负责人）').length).toBe(2);
  });

  it('@ 一个成员 → 点名：直接交给他，@ 从正文去掉；负责人不介入', async () => {
    await addMember('GPT-4o mini');
    await addMember('Claude');
    const r = await chat('@Claude 你好');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe('Claude');
    expect(seen[0]!.messages.at(-1)!.content).toBe('你好');
    expect(text(r)).toBe('我是 Claude\n\n— Claude');
  });

  it('多段内容（图片 + 文字）：只改文字，图片保留', async () => {
    await addMember('Claude');
    await chat([{ type: 'text', text: '@Claude 看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
    expect(seen[0]!.messages.at(-1)!.content).toEqual([{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }]);
  });

  it('@ 多个成员 → 各自回答、分段显示', async () => {
    await addMember('GPT-4o mini');
    await addMember('Claude');
    const r = await chat('@Claude @GPT-4o mini 比较一下', { stream: true });
    expect(seen.map((s) => s.model).sort()).toEqual(['Claude', 'GPT-4o mini']);
    expect(r.body).toContain('### Claude');
    expect(r.body).toContain('### GPT-4o mini');
    expect(r.body).toContain('[DONE]');
  });

  it('被点名成员出错：只回一行提示，不自动换人（D31）', async () => {
    await addMember('GPT-4o mini');
    await addMember('Claude');
    failModels.add('Claude');
    const r = await chat('@Claude 你好');
    expect(seen.map((s) => s.model)).toEqual(['Claude']);
    expect(text(r)).toContain('Claude 暂时没有回应（Key 无效或没有权限）');
    expect(text(r)).not.toContain('placeholder');
  });

  it('没有这个成员：只给提示', async () => {
    await addMember('Claude');
    const r = await chat('@Nobody 你好');
    expect(seen).toHaveLength(0);
    expect(text(r)).toContain('没有叫「Nobody」的成员');
  });

  it('系统任务（其他模型名）：交给负责人，不加署名、不解析 @', async () => {
    await addMember('Claude');
    const r = await chat('给这段对话起个标题：@x', { model: 'gpt-4o-mini' });
    expect(seen[0]!.model).toBe('Claude');
    expect(seen[0]!.messages.at(-1)!.content).toBe('给这段对话起个标题：@x');
    expect(text(r)).toBe('我是 Claude');
  });
  it('Responses API（LobeHub 联网 / 智能搜索时走这条）：转成同一套路由，流式事件和署名都在', async () => {
    await addMember('GPT-4o mini');
    const r = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: chatAuth,
      payload: {
        model: 'aroomo',
        stream: true,
        instructions: 's',
        tools: [{ type: 'web_search' }],
        input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      },
    });
    expect(r.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ model: 'GPT-4o mini', stream: true });
    expect(seen[0]!.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: '你好' }]);
    expect(seen[0]).not.toHaveProperty('tools');
    const types = [...r.body.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types.at(-1)).toBe('response.completed');
    expect(r.body).toContain('我是 GPT-4o mini');
    expect(r.body).toContain('GPT-4o mini（负责人）');
  });

  it('Responses API 非流式 + 点名不存在的成员', async () => {
    await addMember('Claude');
    const r = await app.inject({ method: 'POST', url: '/v1/responses', headers: chatAuth, payload: { model: 'aroomo', input: '@Nobody 你好' } });
    expect(seen).toHaveLength(0);
    expect(r.json()).toMatchObject({ object: 'response', status: 'completed' });
    expect(r.json().output_text).toContain('没有叫「Nobody」的成员');
    expect((await app.inject({ method: 'POST', url: '/v1/responses', payload: { input: 'x' } })).statusCode).toBe(401);
  });

  it('候选不能被点名、不能当负责人；没有合格负责人时不 @ 的消息只给提示（§9.1、D31）', async () => {
    leadCapable.delete('Claude');
    await addMember('Claude');
    const r = await chat('你好');
    expect(seen).toHaveLength(0);
    expect(text(r)).toContain('还没有合格的负责人');
    // 点名照常可用
    const r2 = await chat('@Claude 你好');
    expect(seen.map((x) => x.model)).toEqual(['Claude']);
    expect(text(r2)).toContain('我是 Claude');
    // 系统任务（起标题）在没有负责人时交给第一个在职成员
    seen.length = 0;
    await chat('起标题', { model: 'gpt-4o-mini' });
    expect(seen.map((x) => x.model)).toEqual(['Claude']);
  });

  it('敏感内容保护（D38）：消息里有密码 / Key 时按敏感路由；开关读自设置', async () => {
    await addMember('GPT-4o mini');
    const r = await chat('我的密码：hunter22，帮我记一下');
    expect(seen.map((x) => x.model)).toEqual(['GPT-4o mini']);
    expect(text(r)).toContain('（负责人）');
    expect((await app.inject({ method: 'PUT', url: '/api/settings/security', headers: ownerAuth, payload: { sensitiveProtect: false } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/settings/security', headers: ownerAuth })).json().sensitiveProtect).toBe(false);
  });

  it('aroomo/auto 与负责人入口一致；aroomo/<成员> 直接由该成员答（不 @ 也不交给负责人）', async () => {
    await addMember('GPT-4o mini');
    const claude = (await addMember('Claude')).json() as { id?: string; member?: { id: string } };
    const claudeId = claude.id ?? claude.member?.id ?? 'claude';
    // 模型列表带上成员别名
    const ids = (await app.inject({ method: 'GET', url: '/v1/models', headers: chatAuth })).json().data.map((d: { id: string }) => d.id);
    expect(ids).toContain('aroomo/auto');
    expect(ids).toContain(`aroomo/${claudeId}`);
    // aroomo/auto：不 @ → 负责人，@ → 该成员
    const a = await chat('你好', { model: 'aroomo/auto' });
    expect(seen.map((x) => x.model)).toEqual(['GPT-4o mini']);
    expect(text(a)).toContain('（负责人）');
    seen.length = 0;
    await chat('@Claude 你好', { model: 'aroomo/auto' });
    expect(seen.map((x) => x.model)).toEqual(['Claude']);
    // 成员别名：直接由该成员答，没有署名；正文里的 @ 不再解析
    seen.length = 0;
    const m = await chat('@GPT-4o mini 你好', { model: `aroomo/${claudeId}` });
    expect(seen.map((x) => x.model)).toEqual(['Claude']);
    expect(text(m)).toBe('我是 Claude');
    // 名字（空格换 -）也认；不存在的成员给提示，不调用 LiteLLM
    seen.length = 0;
    await chat('hi', { model: 'aroomo/gpt-4o-mini' });
    expect(seen.map((x) => x.model)).toEqual(['GPT-4o mini']);
    seen.length = 0;
    const none = await chat('hi', { model: 'aroomo/nobody' });
    expect(seen).toHaveLength(0);
    expect(text(none)).toContain('没有这位在职成员');
  });

  it('规矩注入：公共记忆 rules 拼进系统提示；系统任务（起标题）不注入；没有规矩时不变', async () => {
    await addMember('GPT-4o mini');
    await chat('你好');
    expect(seen.at(-1)!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(await app.inject({ method: 'PUT', url: '/api/memory/rules', headers: ownerAuth, payload: { title: '规矩', body: '回答先给结论。不要替我花钱。' } })).toMatchObject({ statusCode: 200 });
    await chat('你好');
    const m = seen.at(-1)!.messages;
    expect(m.map((x) => x.role)).toEqual(['system', 'system', 'user']);
    expect(String(m[0]!.content)).toContain('回答先给结论');
    expect(String(m[1]!.content)).toBe('s'); // 原系统提示保留
    // 成员别名同样注入
    await chat('hi', { model: 'aroomo/gpt-4o-mini' });
    expect(String(seen.at(-1)!.messages[0]!.content)).toContain('不要替我花钱');
    // 系统任务不注入
    await chat('起标题', { model: 'gpt-4o-mini' });
    expect(seen.at(-1)!.messages.map((x) => x.role)).toEqual(['system', 'user']);
  });
});
