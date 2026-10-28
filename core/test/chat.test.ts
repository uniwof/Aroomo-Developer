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
  let app: FastifyInstance;
  let deps: CoreDeps;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
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
    expect(m.json().data.map((d: { id: string }) => d.id)).toEqual(['aroomo']);
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
    const footerAt = r.body.indexOf('GPT-4o mini（负责人）');
    expect(footerAt).toBeGreaterThan(0);
    expect(footerAt).toBeLessThan(doneAt);
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
});
