import { describe, expect, it } from 'vitest';
import { assertOperatorPolicy, CAPABILITIES, OPERATOR_DENYLIST, OPERATOR_WHITELIST } from '../src/auth/capabilities.js';
import { createTokenVerifier, hmacToken, MemoryOperatorTokenStore, principalCan } from '../src/auth/tokens.js';
import { fakeClock, OWNER_TOKEN, TOKEN_SECRET } from './helpers/db.js';

describe('令牌与白名单（D62）', () => {
  const clock = fakeClock();
  const store = new MemoryOperatorTokenStore();
  store.add({ id: 'op', hmac: hmacToken(TOKEN_SECRET, 'placeholder-op-a'), capabilities: ['inbox:post', 'members:read', 'keys:read', 'inbox:read', 'operator-tokens:issue'], revokedAt: null, expiresAt: new Date('2026-10-28T00:00:00Z') });
  store.add({ id: 'op-revoked', hmac: hmacToken(TOKEN_SECRET, 'placeholder-op-b'), capabilities: ['inbox:read'], revokedAt: new Date('2026-10-26T00:00:00Z'), expiresAt: null });
  const verify = createTokenVerifier({ ownerToken: OWNER_TOKEN, tokenSecret: TOKEN_SECRET, operatorTokens: store, now: clock.now });

  it('主人令牌拥有全部能力', async () => {
    const p = await verify(OWNER_TOKEN);
    expect(p?.type).toBe('owner');
    for (const c of CAPABILITIES) expect(principalCan(p!, c)).toBe(true);
  });

  it('操作员只拿到「令牌授权 ∩ 白名单」', async () => {
    const p = await verify('placeholder-op-a');
    expect(p?.type).toBe('operator');
    expect(principalCan(p!, 'inbox:post')).toBe(true);
    expect(principalCan(p!, 'members:read')).toBe(true);
    expect(principalCan(p!, 'keys:read')).toBe(false); // 不在白名单
    expect(principalCan(p!, 'inbox:read')).toBe(false); // D62 未列入允许项
    expect(principalCan(p!, 'operator-tokens:issue')).toBe(false); // 禁止项，令牌里写了也无效
    expect(principalCan(p!, 'tasks:execute-own')).toBe(false); // 在白名单但未授权
  });

  it('白名单 = D62 的四项允许', () => {
    expect([...OPERATOR_WHITELIST].sort()).toEqual(['inbox:post', 'members:read', 'tasks:execute-own', 'webagent:signup-login']);
  });

  it('禁止清单逐条覆盖 D62 的禁止项，且与白名单没有交集', () => {
    for (const c of [
      'keys:read-plaintext', 'keys:export', 'backups:read', 'backups:export', 'permissions:write', 'settings:sensitive:write',
      'official-domains:write', 'members:purge', 'keys:delete', 'keys:revoke', 'trial:cancel', 'payments:pay', 'payments:add-method',
      'audit:write', 'audit:delete', 'operator-tokens:issue', 'confirm:important',
    ] as const) {
      expect(OPERATOR_DENYLIST.has(c)).toBe(true);
      expect(OPERATOR_WHITELIST.has(c)).toBe(false);
    }
    expect(() => assertOperatorPolicy()).not.toThrow();
    expect(() => assertOperatorPolicy(new Set(['members:read', 'payments:pay']), OPERATOR_DENYLIST)).toThrow(/payments:pay/);
  });

  it('吊销、过期、未知令牌都无效', async () => {
    expect(await verify('placeholder-op-b')).toBeNull();
    expect(await verify('nope')).toBeNull();
    clock.set('2026-10-28T00:00:01Z');
    expect(await verify('placeholder-op-a')).toBeNull();
  });

  it('只存 HMAC：同一令牌不同密钥得到不同值', () => {
    expect(hmacToken('a'.repeat(32), 't')).not.toBe(hmacToken('b'.repeat(32), 't'));
  });
});
