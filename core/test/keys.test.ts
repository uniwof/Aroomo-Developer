import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { MemoryKeyStore } from '../src/keys/store.js';
import { LiteLLMAdminClient } from '../src/keys/litellm.js';
import { buildServer } from '../src/server.js';

describe('Key Management API (Mock LiteLLM)', () => {
  let mockLiteLLM: FastifyInstance;
  let mockUrl: string;
  let app: FastifyInstance;
  let store: MemoryKeyStore;
  let client: LiteLLMAdminClient;

  let modelNewCalled = false;
  let modelUpdateCalled = false;
  let modelDeleteCalled = false;
  let syncModelsCalled = false;

  const sampleApiKey = 'placeholder-sk-1234567890abcdef';
  const updatedApiKey = 'placeholder-sk-newkey9999';
  const fallbackApiKey = 'placeholder-sk-testsecretkey1234';

  beforeAll(async () => {
    // 启动本地 mock LiteLLM 服务
    mockLiteLLM = Fastify();

    mockLiteLLM.post('/model/new', async (req, reply) => {
      modelNewCalled = true;
      const body = req.body as { model_name: string };
      return reply.send({
        model_id: `litellm-${body.model_name}`,
        status: 'success',
      });
    });

    mockLiteLLM.post('/model/update', async () => {
      modelUpdateCalled = true;
      return { status: 'success' };
    });

    mockLiteLLM.post('/model/delete', async () => {
      modelDeleteCalled = true;
      return { status: 'success' };
    });

    mockLiteLLM.get('/v1/models', async () => {
      syncModelsCalled = true;
      return { data: [] };
    });

    await mockLiteLLM.listen({ port: 0, host: '127.0.0.1' });
    const address = mockLiteLLM.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    mockUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await mockLiteLLM.close();
  });

  beforeEach(() => {
    modelNewCalled = false;
    modelUpdateCalled = false;
    modelDeleteCalled = false;
    syncModelsCalled = false;

    const config = loadConfig({
      LITELLM_BASE_URL: mockUrl,
      LITELLM_MASTER_KEY: 'placeholder-master-key',
    });
    store = new MemoryKeyStore();
    client = new LiteLLMAdminClient(config.litellmBaseUrl, config.litellmMasterKey);
    app = buildServer(config, { keyStore: store, litellmClient: client });
  });

  it('POST /api/keys 可以成功新增 Key 并只返回非敏感元数据', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/keys',
      payload: {
        sourceUrl: 'https://api.openai.com',
        name: 'OpenAI 官方 Key',
        apiKey: sampleApiKey,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toHaveProperty('id');
    expect(body.name).toBe('OpenAI 官方 Key');
    expect(body.sourceUrl).toBe('https://api.openai.com');
    expect(body.last4).toBe('cdef');
    expect(body.status).toBe('active');
    expect(body).not.toHaveProperty('apiKey');
    expect(body).not.toHaveProperty('litellmDeploymentId');

    expect(modelNewCalled).toBe(true);
    expect(syncModelsCalled).toBe(true);
  });

  it('GET /api/keys 可以获取全部 Key 的非敏感元数据列表', async () => {
    await store.create({
      id: 'key_1',
      name: 'Key 1',
      sourceUrl: 'https://api.example.com',
      last4: '1111',
      litellmDeploymentId: 'litellm-key_1',
      status: 'active',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/keys',
    });

    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(1);
    expect(list[0]).toEqual({
      id: 'key_1',
      name: 'Key 1',
      sourceUrl: 'https://api.example.com',
      last4: '1111',
      status: 'active',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it('PUT /api/keys/:id 支持仅修改名称或完全替换 Key', async () => {
    const created = await store.create({
      id: 'key_test',
      name: '旧名称',
      sourceUrl: 'https://api.example.com',
      last4: '1111',
      litellmDeploymentId: 'litellm-key_test',
      status: 'active',
    });

    // 1. 仅修改名称
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/keys/${created.id}`,
      payload: { name: '新名称' },
    });
    expect(res1.statusCode).toBe(200);
    expect(res1.json().name).toBe('新名称');
    expect(res1.json().last4).toBe('1111');
    expect(modelUpdateCalled).toBe(false);

    // 2. 修改 Key
    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/keys/${created.id}`,
      payload: { apiKey: updatedApiKey },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().last4).toBe('9999');
    expect(modelUpdateCalled).toBe(true);
  });

  it('DELETE /api/keys/:id 必须传 confirm: true 才能删除', async () => {
    const created = await store.create({
      id: 'key_del',
      name: '待删除 Key',
      sourceUrl: 'https://api.example.com',
      last4: '8888',
      litellmDeploymentId: 'litellm-key_del',
      status: 'active',
    });

    // 没有 confirm
    const res1 = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${created.id}`,
      payload: {},
    });
    expect(res1.statusCode).toBe(400);

    // 传 confirm: true
    const res2 = await app.inject({
      method: 'DELETE',
      url: `/api/keys/${created.id}`,
      payload: { confirm: true },
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual({ success: true });
    expect(modelDeleteCalled).toBe(true);
    expect(await store.get(created.id)).toBeNull();
  });

  it('LiteLLM 不可用时返回 503 与通用中文错误提示，且服务不崩溃', async () => {
    const configBad = loadConfig({
      LITELLM_BASE_URL: 'http://127.0.0.1:59999', // 无法连接的端口
    });
    const badApp = buildServer(configBad);

    const res = await badApp.inject({
      method: 'POST',
      url: '/api/keys',
      payload: {
        sourceUrl: 'https://api.openai.com',
        name: '测试 Key',
        apiKey: fallbackApiKey,
      },
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toContain('LiteLLM 服务不可用');
    expect(body.error).not.toContain('ECONNREFUSED');
  });
});
