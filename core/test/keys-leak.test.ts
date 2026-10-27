import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MemoryKeyStore } from '../src/keys/store.js';
import { LiteLLMAdminClient } from '../src/keys/litellm.js';
import { buildServer } from '../src/server.js';

describe('Key 泄露专项测试 (Secret Leakage Test)', () => {
  const secretKeyParts = ['placeholder', 'sk', 'dummy', 'leak', 'test', '123456789'];
  const testSecretKey = secretKeyParts.join('-');
  const last4 = '6789';

  let mockLiteLLM: FastifyInstance;
  let mockUrl: string;
  let app: FastifyInstance;
  const capturedLogs: string[] = [];

  beforeAll(async () => {
    // 捕获 stdout/stderr 日志输出以检测是否在日志中泄露密钥
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = (chunk: Uint8Array | string, ...args: unknown[]): boolean => {
      if (typeof chunk === 'string') capturedLogs.push(chunk);
      return (originalStdoutWrite as (c: Uint8Array | string, ...a: unknown[]) => boolean)(chunk, ...args);
    };
    process.stderr.write = (chunk: Uint8Array | string, ...args: unknown[]): boolean => {
      if (typeof chunk === 'string') capturedLogs.push(chunk);
      return (originalStderrWrite as (c: Uint8Array | string, ...a: unknown[]) => boolean)(chunk, ...args);
    };

    // 假 LiteLLM 服务，模拟异常与带 Key 的报错消息
    mockLiteLLM = Fastify();
    mockLiteLLM.post('/model/new', async (_req, reply) => {
      // 故意返回 400，并且消息中带有 Key 原文（模拟极端的 LiteLLM 透传错误）
      return reply.status(400).send({
        error: 'Invalid provider key: ' + testSecretKey,
      });
    });

    await mockLiteLLM.listen({ port: 0, host: '127.0.0.1' });
    const address = mockLiteLLM.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    mockUrl = `http://127.0.0.1:${port}`;

    const config = loadConfig({
      CORE_LOG_LEVEL: 'info',
      LITELLM_BASE_URL: mockUrl,
      LITELLM_MASTER_KEY: 'master-key',
    });
    const store = new MemoryKeyStore();
    const client = new LiteLLMAdminClient(config.litellmBaseUrl, config.litellmMasterKey);
    app = buildServer(config, { keyStore: store, litellmClient: client });
  });

  afterAll(async () => {
    await mockLiteLLM.close();
  });

  function assertNoLeak(text: string) {
    const fullKeyWithoutLast4 = testSecretKey.slice(0, -4);
    expect(text).not.toContain(fullKeyWithoutLast4);
    expect(text).not.toContain(testSecretKey);
  }

  it('1. HTTP 响应体中绝不包含完整 Key（除末 4 位）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: {
        sourceUrl: 'https://api.openai.com',
        name: '测试泄露 Key',
        apiKey: testSecretKey,
      },
    });

    const responseText = res.body;
    assertNoLeak(responseText);
    // 允许包含末 4 位
    if (res.statusCode === 201) {
      expect(responseText).toContain(last4);
    }
  });

  it('2. 捕获到的所有 Server 控制台日志中绝不包含完整 Key', async () => {
    const allLogs = capturedLogs.join('\n');
    assertNoLeak(allLogs);
  });

  it('3. 当 LiteLLM 返回包含 Key 的错误时，转成的通用中文错误绝不透传原文', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: {
        sourceUrl: 'https://api.openai.com',
        name: '测试泄露 Key 错误',
        apiKey: testSecretKey,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('LiteLLM 请求处理失败，请检查配置参数');
    assertNoLeak(JSON.stringify(body));
  });
});
