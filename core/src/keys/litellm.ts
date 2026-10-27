/**
 * LiteLLM 管理客户端（PRODUCT §8.3、DECISIONS v4.3）
 * 官方文档: https://docs.litellm.ai/docs/proxy/model_management
 *
 * 安全要求：
 * - 绝不出现在任何控制台日志或透传原始错误中。
 * - 任何 LiteLLM 返回的错误或网络通信失败均转为通用中文错误提示。
 */

export class LiteLLMError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode = 503) {
    super(message);
    this.name = 'LiteLLMError';
    this.statusCode = statusCode;
  }
}

export interface LiteLLMModelParams {
  model: string;
  apiKey?: string;
  apiBase?: string;
}

export interface LiteLLMModelConfig {
  modelName: string;
  litellmParams: LiteLLMModelParams;
  modelInfo?: Record<string, unknown>;
}

export interface LiteLLMModelInfoResponse {
  data?: Array<{
    model_name: string;
    model_info?: Record<string, unknown> & { id?: string };
    litellm_params?: Record<string, unknown>;
  }>;
}

export class LiteLLMAdminClient {
  private readonly baseUrl: string;
  private readonly masterKey: string | undefined;

  constructor(baseUrl: string, masterKey: string | undefined) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.masterKey = masterKey;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.masterKey) {
      headers['Authorization'] = `Bearer ${this.masterKey}`;
    }
    return headers;
  }

  private handleFetchError(err: unknown): never {
    if (err instanceof LiteLLMError) {
      throw err;
    }
    // 不泄露底层 fetch / ECONNREFUSED 堆栈或详细信息
    throw new LiteLLMError('LiteLLM 服务不可用，请检查 Gateway 部署与网络连接', 503);
  }

  /**
   * 新增模型部署 (/model/new)
   */
  async createModel(config: LiteLLMModelConfig): Promise<{ id: string }> {
    const url = `${this.baseUrl}/model/new`;
    const payload = {
      model_name: config.modelName,
      litellm_params: {
        model: config.litellmParams.model,
        api_key: config.litellmParams.apiKey,
        api_base: config.litellmParams.apiBase,
      },
      model_info: config.modelInfo ?? {},
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status >= 500) {
          throw new LiteLLMError('LiteLLM 服务不可用，请检查服务状态', 503);
        }
        throw new LiteLLMError('LiteLLM 请求处理失败，请检查配置参数', 400);
      }

      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const modelInfo = (body.model_info as Record<string, unknown>) ?? {};
      const id = (body.model_id as string) ?? (modelInfo.id as string) ?? (body.id as string) ?? config.modelName;

      return { id };
    } catch (err) {
      this.handleFetchError(err);
    }
  }

  /**
   * 修改模型部署 (/model/update)
   */
  async updateModel(
    id: string,
    config: Partial<LiteLLMModelConfig> & { modelName: string },
  ): Promise<void> {
    const url = `${this.baseUrl}/model/update`;
    const payload: Record<string, unknown> = {
      id,
      model_name: config.modelName,
    };

    if (config.litellmParams) {
      payload.litellm_params = {
        model: config.litellmParams.model,
        api_key: config.litellmParams.apiKey,
        api_base: config.litellmParams.apiBase,
      };
    }
    if (config.modelInfo) {
      payload.model_info = config.modelInfo;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status >= 500) {
          throw new LiteLLMError('LiteLLM 服务不可用，请检查服务状态', 503);
        }
        throw new LiteLLMError('LiteLLM 修改模型配置失败', 400);
      }
    } catch (err) {
      this.handleFetchError(err);
    }
  }

  /**
   * 删除模型部署 (/model/delete)
   */
  async deleteModel(id: string): Promise<void> {
    const url = `${this.baseUrl}/model/delete`;
    const payload = { id };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status >= 500) {
          throw new LiteLLMError('LiteLLM 服务不可用，请检查服务状态', 503);
        }
        throw new LiteLLMError('LiteLLM 删除模型配置失败', 400);
      }
    } catch (err) {
      this.handleFetchError(err);
    }
  }

  /**
   * 列出模型部署信息 (/model/info)
   */
  async getModelInfo(): Promise<LiteLLMModelInfoResponse> {
    const url = `${this.baseUrl}/model/info`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!res.ok) {
        if (res.status >= 500) {
          throw new LiteLLMError('LiteLLM 服务不可用，请检查服务状态', 503);
        }
        throw new LiteLLMError('LiteLLM 获取模型列表失败', 400);
      }

      return (await res.json()) as LiteLLMModelInfoResponse;
    } catch (err) {
      this.handleFetchError(err);
    }
  }

  /**
   * 同步模型列表占位调用 (/v1/models)
   * 用于 Key 保存后测试连接并刷新可用模型
   */
  async syncModels(): Promise<boolean> {
    const url = `${this.baseUrl}/v1/models`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
