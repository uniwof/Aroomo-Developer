/**
 * 假 LiteLLM（本地 Fastify 服务），只实现 Core 用到的管理端点。
 * 不连接任何真实 LiteLLM，不需要任何真实 Key。
 */
import Fastify, { type FastifyInstance } from 'fastify';

export const MOCK_MASTER_KEY = 'placeholder-master-key-for-tests-0001';

/** 模拟 LiteLLM 自带的模型数据（只列测试用到的） */
export const KNOWN_MODELS: Record<string, Record<string, unknown>> = {
  'openai/gpt-4o-mini': { mode: 'chat', max_input_tokens: 128000, supports_function_calling: true },
  'openai/small-ctx': { mode: 'chat', max_input_tokens: 8192, supports_function_calling: true },
  'openai/no-tools': { mode: 'chat', max_input_tokens: 200000, supports_function_calling: false },
  'openai/dall-e-3': { mode: 'image_generation' },
};

export type MockMode = 'ok' | 'server_error_echo' | 'reject_echo' | 'slow';

export interface MockLiteLLM {
  url: string;
  app: FastifyInstance;
  deployments: Map<string, { model_name: string; litellm_params: Record<string, unknown>; model_info: Record<string, unknown> }>;
  calls: Array<{ method: string; url: string; body: unknown }>;
  mode: { add: MockMode; del: MockMode; models: MockMode };
  close(): Promise<void>;
}

export async function startMockLiteLLM(): Promise<MockLiteLLM> {
  const app = Fastify({ logger: false });
  const deployments: MockLiteLLM['deployments'] = new Map();
  const calls: MockLiteLLM['calls'] = [];
  const mode: MockLiteLLM['mode'] = { add: 'ok', del: 'ok', models: 'ok' };

  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.authorization !== `Bearer ${MOCK_MASTER_KEY}`) return reply.status(401).send({ error: 'bad master key' });
  });
  app.addHook('preHandler', async (req) => {
    calls.push({ method: req.method, url: req.url, body: req.body });
  });

  // 失败时故意在响应里回显请求体（模拟真实网关把 Key 带进错误信息），用来验证 Core 不透传
  const fail = (m: MockMode, body: unknown) => {
    if (m === 'server_error_echo') return { status: 500, payload: { error: { message: `boom: ${JSON.stringify(body)}` } } };
    if (m === 'reject_echo') return { status: 400, payload: { error: { message: `invalid: ${JSON.stringify(body)}` } } };
    return null;
  };

  app.post<{ Body: { model_name: string; litellm_params: Record<string, unknown>; model_info: { id: string } } }>('/model/new', async (req, reply) => {
    const f = fail(mode.add, req.body);
    if (f) return reply.status(f.status).send(f.payload);
    if (mode.add === 'slow') await new Promise((r) => setTimeout(r, 300));
    deployments.set(req.body.model_info.id, req.body);
    return { model_id: req.body.model_info.id, model_name: req.body.model_name };
  });
  app.post<{ Body: { id: string } }>('/model/delete', async (req, reply) => {
    const f = fail(mode.del, req.body);
    if (f) return reply.status(f.status).send(f.payload);
    if (!deployments.delete(req.body.id)) return reply.status(404).send({ error: 'not found' });
    return { message: 'deleted' };
  });
  // 真实 LiteLLM 会把它自带的模型数据并进 model_info（mode、max_input_tokens、supports_function_calling）；
  // 这里用 KNOWN_MODELS 模拟，表里没有的模型只有 id（= 能力未知）
  app.get('/model/info', async () => ({
    data: [...deployments.values()].map((d) => ({
      model_name: d.model_name,
      litellm_params: { ...d.litellm_params, api_key: '****' },
      model_info: { ...(KNOWN_MODELS[String(d.litellm_params.model)] ?? {}), ...d.model_info },
    })),
  }));
  app.get('/v1/models', async (_req, reply) => {
    if (mode.models !== 'ok') return reply.status(500).send({ error: 'down' });
    return { object: 'list', data: [...deployments.values()].map((d) => ({ id: d.model_name, object: 'model' })) };
  });

  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, app, deployments, calls, mode, close: () => app.close() };
}
