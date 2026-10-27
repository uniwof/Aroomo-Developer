import { beforeEach, describe, expect, it } from 'vitest';
import {
  audit,
  getGlobalAuditLog,
  InMemoryAuditLog,
  redactSecrets,
  setGlobalAuditLog,
} from '../src/audit/index.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';

describe('AuditLog Module', () => {
  let auditLog: InMemoryAuditLog;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    setGlobalAuditLog(auditLog);
  });

  describe('追加与查询 (Append & Query)', () => {
    it('应成功追加记录并生成 id 和 ts', async () => {
      const entry = await auditLog.append({
        actor: { type: 'operator', id: 'op-01' },
        action: 'key.create',
        target: { type: 'key', id: 'key-1' },
        result: 'ok',
        note: '创建新密钥',
      });

      expect(entry.id).toBeDefined();
      expect(typeof entry.id).toBe('string');
      expect(entry.ts).toBeGreaterThan(0);
      expect(entry.actor).toEqual({ type: 'operator', id: 'op-01' });
      expect(entry.action).toBe('key.create');
      expect(entry.target).toEqual({ type: 'key', id: 'key-1' });
      expect(entry.result).toBe('ok');
      expect(entry.note).toBe('创建新密钥');
    });

    it('应支持按 actor、action、target 与时间范围（from/to）过滤查询', async () => {
      const t1 = 1000;
      const t2 = 2000;
      const t3 = 3000;

      await auditLog.append({
        ts: t1,
        actor: { type: 'owner', id: 'owner-1' },
        action: 'member.add',
        target: { type: 'member', id: 'm1' },
        result: 'ok',
      });

      await auditLog.append({
        ts: t2,
        actor: { type: 'operator', id: 'op-1' },
        action: 'key.revoke',
        target: { type: 'key', id: 'k1' },
        result: 'ok',
      });

      await auditLog.append({
        ts: t3,
        actor: { type: 'system', id: 'sys-1' },
        action: 'member.add',
        target: { type: 'member', id: 'm2' },
        result: 'failed',
      });

      // 按 action 过滤
      const byAction = await auditLog.query({ action: 'member.add' });
      expect(byAction.total).toBe(2);
      expect(byAction.items.map((i) => i.target.id)).toEqual(['m2', 'm1']);

      // 按 actor 过滤
      const byActor = await auditLog.query({ actor: { type: 'owner', id: 'owner-1' } });
      expect(byActor.total).toBe(1);
      expect(byActor.items[0]?.actor.id).toBe('owner-1');

      // 按 actor 字符串过滤
      const byActorStr = await auditLog.query({ actor: 'op-1' });
      expect(byActorStr.total).toBe(1);

      // 按 target 过滤
      const byTarget = await auditLog.query({ target: { type: 'key', id: 'k1' } });
      expect(byTarget.total).toBe(1);

      // 按时间范围过滤
      const byTime = await auditLog.query({ from: 1500, to: 2500 });
      expect(byTime.total).toBe(1);
      expect(byTime.items[0]?.action).toBe('key.revoke');
    });
  });

  describe('分页游标稳定 (Pagination Cursor Stability)', () => {
    it('使用游标分页查询应保持结果稳定且不遗漏不重复', async () => {
      const baseTs = 10000;
      const totalEntries = 10;

      for (let i = 1; i <= totalEntries; i += 1) {
        await auditLog.append({
          ts: baseTs + i,
          actor: { type: 'member', id: `member-${i}` },
          action: 'inbox.read',
          target: { type: 'inbox', id: `msg-${i}` },
          result: 'ok',
        });
      }

      const allItems: string[] = [];
      let cursor: string | undefined;

      do {
        const res = await auditLog.query({ limit: 3, cursor });
        res.items.forEach((item) => allItems.push(item.id));
        cursor = res.nextCursor;
      } while (cursor);

      expect(allItems.length).toBe(totalEntries);
      const uniqueItems = new Set(allItems);
      expect(uniqueItems.size).toBe(totalEntries);
    });
  });

  describe('脱敏规则 (Secret Redaction Rules)', () => {
    it('正例 (≥5 个)：匹配各种密钥与敏感令牌形式应替换为 [REDACTED]', () => {
      const positiveCases = [
        {
          input: 'sk-proj-1234567890abcdefghijklmnopqrstuvwxyz',
          expected: '[REDACTED]',
          label: 'OpenAI/LiteLLM sk- Key',
        },
        {
          input: 'AIzaSyA1234567890abcdefghijklmnopqrst',
          expected: '[REDACTED]',
          label: 'Google Cloud AIza Key',
        },
        {
          input: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
          expected: '[REDACTED]',
          label: 'GitHub Personal Token ghp_',
        },
        {
          input: 'Authorization: Bearer my-secret-auth-token-1234567890',
          expected: 'Authorization: [REDACTED]',
          label: 'Bearer Token',
        },
        {
          input: '4f3a8b2c1d9e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a',
          expected: '[REDACTED]',
          label: 'Long Hex String (64 chars)',
        },
        {
          input: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
          expected: '[REDACTED]',
          label: 'JWT Token',
        },
      ];

      expect(positiveCases.length).toBeGreaterThanOrEqual(5);

      positiveCases.forEach(({ input, expected, label }) => {
        const redacted = redactSecrets(input);
        expect(redacted, `Failed for ${label}`).toBe(expected);
      });
    });

    it('反例 (≥5 个)：非密钥文本/ID/UUID不应误脱敏', () => {
      const negativeCases = [
        {
          input: 'placeholder-test-key-123',
          expected: 'placeholder-test-key-123',
          label: 'placeholder前缀假值',
        },
        {
          input: 'member.create',
          expected: 'member.create',
          label: '普通 action 标识',
        },
        {
          input: '018f3a8b-2c1d-4e5f-8a9b-0c1d2e3f4a5b',
          expected: '018f3a8b-2c1d-4e5f-8a9b-0c1d2e3f4a5b',
          label: '带连字符的 UUID',
        },
        {
          input: 'User member-01 performed operation successfully at timestamp 1700000000',
          expected: 'User member-01 performed operation successfully at timestamp 1700000000',
          label: '普通日志说明文字',
        },
        {
          input: 'commit-hash-7f3a8b2',
          expected: 'commit-hash-7f3a8b2',
          label: '短 git commit hash',
        },
        {
          input: 'operator-lead-id',
          expected: 'operator-lead-id',
          label: '操作员标识符',
        },
      ];

      expect(negativeCases.length).toBeGreaterThanOrEqual(5);

      negativeCases.forEach(({ input, expected, label }) => {
        const redacted = redactSecrets(input);
        expect(redacted, `Failed for ${label}`).toBe(expected);
      });
    });

    it('追加日志时应自动在所有字符串字段上应用脱敏规则', async () => {
      const entry = await auditLog.append({
        actor: { type: 'operator', id: 'sk-proj-actor-key-1234567890' },
        action: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
        target: { type: 'AIzaSyA1234567890abcdefghijklmnopqrst', id: '4f3a8b2c1d9e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a' },
        result: 'ok',
        note: 'User provided Bearer token-xyz-secret-123',
      });

      expect(entry.actor.id).toBe('[REDACTED]');
      expect(entry.action).toBe('[REDACTED]');
      expect(entry.target.type).toBe('[REDACTED]');
      expect(entry.target.id).toBe('[REDACTED]');
      expect(entry.note).toBe('User provided [REDACTED]');
    });
  });

  describe('接口禁止删除/修改方法 (Append-only Verification)', () => {
    it('运行时对象与原型上不应存在 update / delete / remove 等修改删除方法', () => {
      const forbiddenMethods = ['update', 'delete', 'remove', 'clear', 'modify', 'put'];

      const instanceAny = auditLog as unknown as Record<string, unknown>;
      const proto = Object.getPrototypeOf(auditLog) as Record<string, unknown>;
      const protoMethods = Object.getOwnPropertyNames(proto);
      const instanceKeys = Object.keys(instanceAny);

      forbiddenMethods.forEach((method) => {
        expect(instanceAny[method], `Instance should not have ${method}`).toBeUndefined();
        expect(proto[method], `Prototype should not have ${method}`).toBeUndefined();
        expect(protoMethods).not.toContain(method);
        expect(instanceKeys).not.toContain(method);
      });

      // 仅允许 append 和 query 方法
      expect(protoMethods.sort()).toEqual(['constructor', 'append', 'query'].sort());
    });
  });

  describe('便捷函数 audit()', () => {
    it('调用 audit() 应使用全局 AuditLog 追加审计记录', async () => {
      const entry = await audit('member.update', { type: 'member', id: 'm-100' }, 'ok', '更新成员配置');

      expect(entry.action).toBe('member.update');
      expect(entry.target).toEqual({ type: 'member', id: 'm-100' });
      expect(entry.result).toBe('ok');
      expect(entry.note).toBe('更新成员配置');
      expect(entry.actor).toEqual({ type: 'system', id: 'system' });

      const queried = await getGlobalAuditLog().query({ action: 'member.update' });
      expect(queried.total).toBe(1);
      expect(queried.items[0]?.id).toBe(entry.id);
    });
  });

  describe('HTTP API GET /api/audit', () => {
    it('GET /api/audit 应支持只读分页查询审计日志', async () => {
      const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent' }), auditLog);

      await auditLog.append({
        actor: { type: 'owner', id: 'user-01' },
        action: 'key.create',
        target: { type: 'key', id: 'k-1' },
        result: 'ok',
        note: '创建测试 Key',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/audit?action=key.create&limit=10',
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.total).toBe(1);
      expect(json.items[0].action).toBe('key.create');
      expect(json.items[0].actor).toEqual({ type: 'owner', id: 'user-01' });

      await app.close();
    });
  });
});
