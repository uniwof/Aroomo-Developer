/**
 * Key 管理业务（Issue #6）。
 * - 新增：先写 LiteLLM（POST /model/new），成功后再存本地元数据；本地失败则回滚删除 LiteLLM 部署。
 * - 换 Key（整条替换）：先新增新部署，成功后切换本地记录，再删除旧部署——新 Key 写入失败时旧 Key 不受影响。
 * - 只改名称 / 获取网址：只改本地元数据，不碰 LiteLLM。
 * - 确认（D73，修订 D63 的实现）：
 *   - 主人本人在界面上手动新增 / 换 Key（含改接口地址 / 模型）= 普通保存，不额外确认（只记 confirm.normal 审计）；
 *   - 智能体 / 操作员发起的新增 / 换 Key、任何人删除 Key = 重要确认（两次点击、3 秒、重新验证 Cloudflare Access），
 *     操作员不能完成重要确认（D62）→ 403；令牌绑定请求体的加盐摘要，确认 A 不能拿去提交 B；
 *   - 查看明文 / 导出：Core 没有这类接口（完整 Key 只在 LiteLLM，永不返回），将来要加必须走重要确认。
 *   只改名称 / 获取网址不需要确认。
 * - 删除：先删 LiteLLM 部署（已不存在视为成功），再删本地。
 * - 保存后同步一次模型列表（/v1/models）：失败只把状态记为 sync_failed，不报错。
 * - 完整 Key 只在本函数调用栈里短暂存在，不写本地库、不进响应、不进日志、不进审计、不进错误信息。
 */
import { randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { type ConfirmCtx, ConfirmService, MemoryChallengeStore } from '../confirm/confirm.js';
import { badRequest, HttpError, notFound } from '../http/errors.js';
import { type LiteLLMAdmin, LiteLLMRejectedError, LiteLLMUnavailableError } from './litellm.js';
import type { KeyRecord, KeyStore } from './types.js';

export interface CreateKeyInput {
  name: string;
  sourceUrl: string;
  apiKey: string;
  model: string;
  modelName?: string;
  apiBase?: string;
}

export interface UpdateKeyInput {
  name?: string;
  sourceUrl?: string;
  /** 提供则整条替换（新部署替换旧部署）；apiBase / model 只能随新 Key 一起改 */
  apiKey?: string;
  apiBase?: string | null;
  model?: string;
}

export function keyJson(k: KeyRecord) {
  return { id: k.id, name: k.name, sourceUrl: k.sourceUrl, last4: k.last4, status: k.status, updatedAt: k.updatedAt.toISOString() };
}

/** 把 LiteLLM 错误转成通用中文错误，不透传原文。 */
function gatewayError(err: unknown): never {
  if (err instanceof LiteLLMUnavailableError) {
    if (err.reason === 'not_configured') throw new HttpError(503, 'GATEWAY_NOT_CONFIGURED', '模型网关还没有配置好（缺少管理密钥），暂时不能管理 Key');
    throw new HttpError(503, 'GATEWAY_UNAVAILABLE', '模型网关暂时不可用，请稍后再试');
  }
  if (err instanceof LiteLLMRejectedError) {
    throw new HttpError(502, 'GATEWAY_REJECTED', '模型网关拒绝了这次操作，请检查模型名、接口地址和 Key 是否正确');
  }
  throw err;
}

const last4 = (key: string) => key.slice(-4);

function validateKey(apiKey: string): string {
  const k = apiKey.trim();
  // 太短的 Key 显示末 4 位就等于泄露了大半，直接拒绝
  if (k.length < 12 || /\s/.test(k)) throw badRequest('Key 格式不对（至少 12 个字符、不能含空格）', 'INVALID_KEY');
  return k;
}

export interface KeysHooks {
  /** 新增 Key 成功之后（例如：把这个模型放进候选，PRODUCT §9.1 入职流程）。失败不影响新增。 */
  afterCreate?: (rec: KeyRecord, audit: AuditFn) => Promise<void>;
  /** 删除 Key 成功之后（例如：这个模型已经没有 Key 了 → 停用对应成员，避免负责人指向一个调不通的模型）。失败不影响删除。 */
  afterDelete?: (rec: KeyRecord, audit: AuditFn) => Promise<void>;
  /** 换 Key 成功之后（例如：模型可能变了 → 刷新成员的模型事实）。失败不影响换 Key。 */
  afterReplace?: (rec: KeyRecord, audit: AuditFn) => Promise<void>;
}

export class KeysService {
  constructor(
    private readonly store: KeyStore,
    private readonly litellm: LiteLLMAdmin,
    private readonly now: () => Date,
    private readonly confirm: ConfirmService = new ConfirmService(new MemoryChallengeStore(), { now }),
    private readonly hooks: KeysHooks = {},
  ) {}

  async #confirmCredential(scope: string, title: string, consequences: string[], payload: unknown, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    await this.confirm.require({ scope, kind: 'credential', title, consequences, confirmLabel: '确认', payload }, ctx, audit);
  }

  /** D73：主人手动新增 / 编辑 = 普通保存；其他发起方 = 涉及凭据的重要确认 */
  async #confirmSave(scope: string, title: string, consequences: string[], payload: unknown, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    if (ctx.actor === 'owner') {
      await this.confirm.require({ scope, kind: 'normal', title }, ctx, audit);
      return;
    }
    await this.#confirmCredential(scope, title, consequences, payload, ctx, audit);
  }

  list(): Promise<KeyRecord[]> {
    return this.store.list();
  }

  async create(input: CreateKeyInput, ctx: ConfirmCtx, audit: AuditFn): Promise<KeyRecord> {
    const name = input.name.trim();
    if (!name) throw badRequest('名称不能为空', 'INVALID_NAME');
    const apiKey = validateKey(input.apiKey);
    await this.#confirmSave(
      'keys:create',
      `新增 Key「${name}」（末 4 位 ${last4(apiKey)}）`,
      ['这个 Key 会保存到模型网关，成员调用模型时会用它产生费用。', `调用会发往：${input.apiBase ?? '服务商默认地址'}`],
      input,
      ctx,
      audit,
    );
    const id = randomUUID();
    const deploymentId = `aroomo-${randomUUID()}`;
    const modelName = input.modelName?.trim() || input.model;
    try {
      await this.litellm.addDeployment({
        id: deploymentId,
        modelName,
        model: input.model,
        apiKey,
        ...(input.apiBase ? { apiBase: input.apiBase } : {}),
        info: { aroomo_key_id: id },
      });
    } catch (err) {
      await audit('keys.create', { type: 'key', id }, 'failed', (err as Error).name);
      gatewayError(err);
    }
    const now = this.now();
    const rec: KeyRecord = {
      id,
      name,
      sourceUrl: input.sourceUrl,
      last4: last4(apiKey),
      model: input.model,
      modelName,
      apiBase: input.apiBase ?? null,
      litellmModelId: deploymentId,
      status: 'active',
      modelsSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.store.insert(rec);
    } catch (err) {
      // 本地写失败：回滚 LiteLLM 里的部署，避免「看不见的 Key」
      await this.litellm.deleteDeployment(deploymentId).catch(() => undefined);
      await audit('keys.create', { type: 'key', id }, 'failed', 'local_store_failed');
      throw err;
    }
    await audit('keys.create', { type: 'key', id }, 'ok', `last4=${rec.last4}`);
    const synced = await this.#syncAfterSave(rec);
    if (this.hooks.afterCreate) {
      await this.hooks.afterCreate(synced, audit).catch(async (err: unknown) => {
        await audit('keys.create.hook', { type: 'key', id }, 'failed', (err as Error).name);
      });
    }
    return synced;
  }

  async update(id: string, patch: UpdateKeyInput, ctx: ConfirmCtx, audit: AuditFn): Promise<KeyRecord> {
    const cur = await this.store.get(id);
    if (!cur) throw notFound('找不到这个 Key');
    if (patch.apiKey === undefined && (patch.apiBase !== undefined || patch.model !== undefined)) {
      throw badRequest('修改接口地址或模型时需要同时重新填写 Key（整条替换）', 'KEY_REQUIRED');
    }
    let next: KeyRecord = {
      ...cur,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
    };
    if (!next.name) throw badRequest('名称不能为空', 'INVALID_NAME');

    if (patch.apiKey === undefined) {
      next = { ...next, updatedAt: this.now() };
      await this.store.update(next);
      await audit('keys.update', { type: 'key', id }, 'ok', 'metadata');
      return next;
    }

    const apiKey = validateKey(patch.apiKey);
    const model = patch.model ?? cur.model;
    const apiBase = patch.apiBase === undefined ? cur.apiBase : patch.apiBase;
    await this.#confirmSave(
      `keys:replace:${id}`,
      `替换 Key「${next.name}」（末 4 位 ${cur.last4} → ${last4(apiKey)}）`,
      ['旧 Key 会从模型网关里删除，之后的调用改用新 Key。', `调用会发往：${apiBase ?? '服务商默认地址'}`],
      { id, ...patch },
      ctx,
      audit,
    );
    const newDeployment = `aroomo-${randomUUID()}`;
    try {
      await this.litellm.addDeployment({
        id: newDeployment,
        modelName: cur.modelName,
        model,
        apiKey,
        ...(apiBase ? { apiBase } : {}),
        info: { aroomo_key_id: id },
      });
    } catch (err) {
      await audit('keys.replace', { type: 'key', id }, 'failed', (err as Error).name);
      gatewayError(err);
    }
    next = { ...next, model, apiBase, last4: last4(apiKey), litellmModelId: newDeployment, updatedAt: this.now() };
    await this.store.update(next);
    await audit('keys.replace', { type: 'key', id }, 'ok', `last4=${next.last4}`);
    try {
      await this.litellm.deleteDeployment(cur.litellmModelId);
    } catch (err) {
      // 旧部署没删掉：功能不受影响（新部署已生效），但要留痕便于人工清理
      await audit('keys.replace.cleanup', { type: 'litellm_deployment', id: cur.litellmModelId }, 'failed', (err as Error).name);
    }
    const synced = await this.#syncAfterSave(next);
    if (this.hooks.afterReplace) {
      await this.hooks.afterReplace(synced, audit).catch(async (err: unknown) => {
        await audit('keys.replace.hook', { type: 'key', id }, 'failed', (err as Error).name);
      });
    }
    return synced;
  }

  async delete(id: string, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    const cur = await this.store.get(id);
    if (!cur) throw notFound('找不到这个 Key');
    await this.#confirmCredential(
      `keys:delete:${id}`,
      `删除 Key「${cur.name}」（末 4 位 ${cur.last4}）`,
      ['Key 会从模型网关里永久删除，不能恢复；要再用需要重新填写。', '正在用这个 Key 的成员会无法调用模型。'],
      { id },
      ctx,
      audit,
    );
    try {
      await this.litellm.deleteDeployment(cur.litellmModelId);
    } catch (err) {
      await audit('keys.delete', { type: 'key', id }, 'failed', (err as Error).name);
      gatewayError(err);
    }
    await this.store.delete(id);
    await audit('keys.delete', { type: 'key', id }, 'ok', `last4=${cur.last4}`);
    if (this.hooks.afterDelete) {
      await this.hooks.afterDelete(cur, audit).catch(async (err: unknown) => {
        await audit('keys.delete.hook', { type: 'key', id }, 'failed', (err as Error).name);
      });
    }
  }

  async #syncAfterSave(rec: KeyRecord): Promise<KeyRecord> {
    let next: KeyRecord;
    try {
      await this.litellm.syncModels();
      next = { ...rec, status: 'active', modelsSyncedAt: this.now() };
    } catch {
      next = { ...rec, status: 'sync_failed' };
    }
    await this.store.update(next);
    return next;
  }
}
