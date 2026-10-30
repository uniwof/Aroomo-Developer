import type { AuditFn } from '../audit/types.js';
import { badRequest, notFound } from '../http/errors.js';
import { looksSensitive } from '../settings/security.js';
import { BODY_MAX, type MemoryEntry, type MemoryVersion, type PubMemStore, TOPIC_RE } from './types.js';

export class PubMemService {
  constructor(
    private readonly store: PubMemStore,
    private readonly now: () => Date,
  ) {}

  #topic(topic: string): string {
    if (!TOPIC_RE.test(topic)) throw badRequest('主题名只能用小写字母、数字、. _ -（1–64 位，数字或字母开头）', 'INVALID_TOPIC');
    return topic;
  }

  list(userId: string): Promise<MemoryEntry[]> {
    return this.store.list(userId);
  }

  async get(userId: string, topic: string): Promise<MemoryEntry> {
    const e = await this.store.get(userId, this.#topic(topic));
    if (!e) throw notFound('找不到这条公共记忆');
    return e;
  }

  async put(userId: string, topic: string, title: string, body: string, audit: AuditFn): Promise<MemoryEntry> {
    this.#topic(topic);
    const t = title.trim();
    if (!t || t.length > 128) throw badRequest('标题需要 1–128 个字');
    if (body.length > BODY_MAX) throw badRequest(`内容太长（最多 ${BODY_MAX} 字）`, 'BODY_TOO_LONG');
    // 公共记忆会给成员和外部客户端看：看起来像密码 / Key / 卡号的内容一律不让存
    if (looksSensitive(t) || looksSensitive(body)) {
      await audit('memory.write', { type: 'memory', id: topic }, 'denied', '疑似敏感信息');
      throw badRequest('内容里像是有密码、Key 或证件号，公共记忆会共享出去，不能存这些', 'SENSITIVE_CONTENT');
    }
    const e = await this.store.put(userId, topic, t, body, this.now());
    await audit('memory.write', { type: 'memory', id: topic }, 'ok', `v${e.version}`);
    return e;
  }

  async versions(userId: string, topic: string): Promise<MemoryVersion[]> {
    await this.get(userId, topic);
    return this.store.versions(userId, topic);
  }

  /** 回滚 = 把旧版本的内容作为新版本写入（历史不丢） */
  async rollback(userId: string, topic: string, version: number, audit: AuditFn): Promise<MemoryEntry> {
    const cur = await this.get(userId, topic);
    if (cur.version === version) return cur;
    const old = (await this.store.versions(userId, topic)).find((v) => v.version === version);
    if (!old) throw notFound('找不到这个版本（太旧的版本已清理）');
    const e = await this.store.put(userId, topic, old.title, old.body, this.now());
    await audit('memory.rollback', { type: 'memory', id: topic }, 'ok', `v${version} -> v${e.version}`);
    return e;
  }

  async delete(userId: string, topic: string, audit: AuditFn): Promise<void> {
    if (!(await this.store.delete(userId, this.#topic(topic)))) throw notFound('找不到这条公共记忆');
    await audit('memory.delete', { type: 'memory', id: topic }, 'ok');
  }
}
