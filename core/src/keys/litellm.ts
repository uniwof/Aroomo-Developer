/**
 * LiteLLM 管理 API 客户端（DECISIONS D34、D55；docs/architecture/KEY-STORAGE.md）。
 *
 * 端点依据 LiteLLM 官方文档 https://docs.litellm.ai/docs/proxy/model_management （2026-10-27 核对，v1.106.x）：
 *   POST /model/new      新增模型部署（litellm_params 里的 api_key 由 LiteLLM 用 LITELLM_SALT_KEY 加密入库）
 *   POST /model/delete   body { id }（只有 POST，没有 DELETE 动词）
 *   GET  /model/info     列出部署（API Key 已被 LiteLLM 打码）
 *   GET  /v1/models      OpenAI 兼容的模型列表（用于「同步模型列表」）
 *   POST /model/update   本模块不使用：换 Key 采用「先新增、后删除旧部署」，保证新 Key 写入失败时旧 Key 仍可用。
 *
 * 安全约束（PRODUCT 0.4）：任何错误对象里都不包含请求体或 LiteLLM 的响应原文（可能回显 Key）。
 */

export class LiteLLMUnavailableError extends Error {
  constructor(public readonly reason: 'network' | 'timeout' | 'server_error' | 'not_configured') {
    super(`LiteLLM unavailable (${reason})`);
    this.name = 'LiteLLMUnavailableError';
  }
}

export class LiteLLMRejectedError extends Error {
  constructor(public readonly status: number) {
    super(`LiteLLM rejected the request (HTTP ${status})`);
    this.name = 'LiteLLMRejectedError';
  }
}

export interface NewDeployment {
  /** 由 Core 生成，写入 model_info.id，作为 LiteLLM 部署 id */
  id: string;
  modelName: string;
  model: string;
  apiKey: string;
  apiBase?: string;
  /** 写进 model_info，方便在 LiteLLM 里反查（不含敏感内容） */
  info?: Record<string, string>;
}

export interface LiteLLMAdminOptions {
  baseUrl: string;
  masterKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class LiteLLMAdmin {
  readonly #base: string;
  readonly #masterKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: LiteLLMAdminOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#masterKey = opts.masterKey;
    this.#timeoutMs = opts.timeoutMs ?? 10_000;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.#masterKey);
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: unknown }> {
    if (!this.#masterKey) throw new LiteLLMUnavailableError('not_configured');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#masterKey}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // 不把原始错误（可能带请求信息）往外抛
      const name = (err as { name?: string }).name;
      throw new LiteLLMUnavailableError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok || okStatuses.includes(res.status)) return { status: res.status, json };
    if (res.status >= 500) throw new LiteLLMUnavailableError('server_error');
    throw new LiteLLMRejectedError(res.status);
  }

  async addDeployment(d: NewDeployment): Promise<void> {
    await this.#call('POST', '/model/new', {
      model_name: d.modelName,
      litellm_params: { model: d.model, api_key: d.apiKey, ...(d.apiBase ? { api_base: d.apiBase } : {}) },
      model_info: { id: d.id, ...(d.info ?? {}) },
    });
  }

  /** 删除部署；部署已不存在（404）视为成功。 */
  async deleteDeployment(id: string): Promise<void> {
    await this.#call('POST', '/model/delete', { id }, [404]);
  }

  /** 列出部署 id 与 model_name（不读取任何凭据字段）。 */
  async listDeployments(): Promise<Array<{ id: string; modelName: string }>> {
    const { json } = await this.#call('GET', '/model/info');
    const data = (json as { data?: Array<{ model_name?: string; model_info?: { id?: string } }> } | null)?.data ?? [];
    return data
      .filter((d) => typeof d.model_info?.id === 'string')
      .map((d) => ({ id: d.model_info!.id as string, modelName: String(d.model_name ?? '') }));
  }

  /** 同步模型列表（/v1/models），返回模型名。 */
  async syncModels(): Promise<string[]> {
    const { json } = await this.#call('GET', '/v1/models');
    const data = (json as { data?: Array<{ id?: string }> } | null)?.data ?? [];
    return data.map((d) => String(d.id ?? '')).filter(Boolean);
  }
}
