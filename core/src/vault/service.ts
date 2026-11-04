import { randomUUID } from 'node:crypto';
import type { AuditFn } from '../audit/types.js';
import { type ConfirmCtx, ConfirmService } from '../confirm/confirm.js';
import { badRequest, conflict, HttpError, notFound } from '../http/errors.js';
import type { SettingsStore } from '../settings/store.js';
import { openSecret, parseVaultKey, sealSecret, vaultFingerprint } from './crypto.js';
import { MAX_SECRETS_PER_USER, NameTakenError, type PublicSecret, SECRET_KINDS, type SecretKind, type SecretRecord, VALUE_MAX, type VaultStore } from './types.js';

const FP_KEY = 'vault.fingerprint';

export const publicSecret = (r: SecretRecord): PublicSecret => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  last4: r.last4,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  rotatedAt: r.rotatedAt ? r.rotatedAt.toISOString() : null,
});

/** 只给 api_key / token 显示末 4 位，且值够长时才显示（太短等于泄露大半）；密码和备注不显示 */
const last4Of = (kind: SecretKind, value: string): string => ((kind === 'api_key' || kind === 'token') && value.length >= 12 ? value.slice(-4) : '');

/**
 * 启动检查（HUB.md 2.2）：库里有记录而 VAULT_KEY 缺失 / 格式不对 / 指纹不符 → 拒绝启动；不静默降级。
 * 没有记录且给了合法 VAULT_KEY：记下指纹（以后换密钥会被发现）。
 */
export async function vaultStartupCheck(vaultKey: string | undefined, store: VaultStore, settings: SettingsStore, now: () => Date): Promise<void> {
  const rows = await store.countAll();
  const key = vaultKey ? parseVaultKey(vaultKey) : null;
  if (vaultKey && !key) throw new Error('VAULT_KEY 必须是 32 字节的 base64（43 个字符）');
  if (rows > 0 && !key) throw new Error('保险箱里已有记录，但 VAULT_KEY 缺失：拒绝启动（找回原来的 VAULT_KEY，它在服务器 .env 里）');
  if (!key) return;
  const fp = vaultFingerprint(key);
  const stored = (await settings.get<{ fp: string }>(FP_KEY))?.fp;
  if (stored && stored !== fp && rows > 0) throw new Error('VAULT_KEY 与保险箱记录不匹配（指纹不符）：拒绝启动，避免旧记录再也解不开');
  if (stored !== fp) await settings.set(FP_KEY, { fp }, now());
}

export class VaultService {
  readonly #key: Buffer | null;

  constructor(
    vaultKey: string | undefined,
    private readonly store: VaultStore,
    private readonly now: () => Date,
    private readonly confirm: ConfirmService,
  ) {
    this.#key = vaultKey ? parseVaultKey(vaultKey) : null;
  }

  get enabled(): boolean {
    return this.#key !== null;
  }

  #k(): Buffer {
    if (!this.#key) throw new HttpError(503, 'VAULT_NOT_CONFIGURED', '保险箱还没有启用（服务器没有设置 VAULT_KEY）');
    return this.#key;
  }

  async list(userId: string): Promise<PublicSecret[]> {
    this.#k();
    return (await this.store.list(userId)).map(publicSecret);
  }

  async create(userId: string, input: { name: string; kind: string; value: string }, audit: AuditFn): Promise<PublicSecret> {
    const key = this.#k();
    const name = String(input.name ?? '').trim();
    if (!name || name.length > 64) throw badRequest('名字需要 1–64 个字');
    if (!(SECRET_KINDS as readonly string[]).includes(input.kind)) throw badRequest('类型不对', 'INVALID_KIND');
    const value = this.#value(input.value);
    if ((await this.store.list(userId)).length >= MAX_SECRETS_PER_USER) throw conflict('保险箱里的条目太多了', 'VAULT_FULL');
    const id = randomUUID();
    const at = this.now();
    const kind = input.kind as SecretKind;
    const rec: SecretRecord = { id, userId, name, kind, last4: last4Of(kind, value), ...sealSecret(key, userId, id, value), createdAt: at, updatedAt: at, rotatedAt: null, deletedAt: null };
    try {
      await this.store.insert(rec);
    } catch (err) {
      if (err instanceof NameTakenError) throw conflict('已经有同名的条目', 'NAME_TAKEN');
      throw err;
    }
    await audit('vault.create', { type: 'vault', id }, 'ok', `${kind} ${name}`);
    return publicSecret(rec);
  }

  #value(v: unknown): string {
    const s = typeof v === 'string' ? v : '';
    if (!s || s.length > VALUE_MAX) throw badRequest(`内容需要 1–${VALUE_MAX} 个字符`, 'INVALID_VALUE');
    return s;
  }

  /** 替换内容（用户手动填写 = 普通保存，不弹重要确认；没有读回明文） */
  async replace(userId: string, id: string, value: string, audit: AuditFn): Promise<PublicSecret> {
    const key = this.#k();
    const cur = await this.store.get(userId, id);
    if (!cur) throw notFound('找不到这个条目');
    const v = this.#value(value);
    const at = this.now();
    const sealed = sealSecret(key, userId, id, v);
    if (!(await this.store.replace(userId, id, sealed, last4Of(cur.kind, v), at))) throw notFound('找不到这个条目');
    await audit('vault.replace', { type: 'vault', id }, 'ok');
    const next = await this.store.get(userId, id);
    return publicSecret(next as SecretRecord);
  }

  /** 查看明文：重要确认（D63）。操作员、客户端令牌到不了这里（路由层拒绝）；账号暂时 403（密码重新验证未做，HUB 7.1 第 1 步） */
  async reveal(userId: string, id: string, ctx: ConfirmCtx, audit: AuditFn): Promise<string> {
    const key = this.#k();
    const cur = await this.store.get(userId, id);
    if (!cur) throw notFound('找不到这个条目');
    await this.confirm.require(
      { scope: `vault.reveal:${id}`, kind: 'credential', title: `查看「${cur.name}」的明文`, consequences: ['明文会显示在屏幕上，看完请关闭页面'], confirmLabel: '确认查看', payload: { id } },
      ctx,
      audit,
    );
    let plain: string;
    try {
      plain = openSecret(key, userId, id, cur);
    } catch {
      await audit('vault.reveal', { type: 'vault', id }, 'failed', 'decrypt');
      throw new HttpError(500, 'VAULT_DECRYPT_FAILED', '这个条目解不开（VAULT_KEY 不对或数据被改动）');
    }
    await audit('vault.reveal', { type: 'vault', id }, 'ok');
    return plain;
  }

  async delete(userId: string, id: string, ctx: ConfirmCtx, audit: AuditFn): Promise<void> {
    this.#k();
    const cur = await this.store.get(userId, id);
    if (!cur) throw notFound('找不到这个条目');
    await this.confirm.require(
      { scope: `vault.delete:${id}`, kind: 'irreversible', title: `删除「${cur.name}」`, consequences: ['删除后无法恢复', '用到它的工具会调用失败'], confirmLabel: '确认删除', payload: { id } },
      ctx,
      audit,
    );
    await this.store.erase(userId, id, this.now());
    await audit('vault.delete', { type: 'vault', id }, 'ok');
  }

  /**
   * 工具网关专用（进程内）：取出明文给网关用，用完即丢；永远不经过路由返回。
   * 找不到 / 解不开返回 null。
   */
  async resolveForGateway(userId: string, id: string): Promise<string | null> {
    const key = this.#key;
    if (!key) return null;
    const cur = await this.store.get(userId, id);
    if (!cur) return null;
    try {
      return openSecret(key, userId, id, cur);
    } catch {
      return null;
    }
  }

  /** 登记工具时检查：这个 secret 属于该用户且存在 */
  async exists(userId: string, id: string): Promise<boolean> {
    return (await this.store.get(userId, id)) !== null;
  }
}
