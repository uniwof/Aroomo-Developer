import { describe, expect, it } from 'vitest';
import { CAPABILITIES, OPERATOR_WHITELIST } from '../src/auth/capabilities.js';
import { createTokenVerifier, hmacToken, MemoryOperatorTokenStore, principalCan } from '../src/auth/tokens.js';
import { fakeClock, OWNER_TOKEN, TOKEN_SECRET } from './helpers/db.js';

describe('令牌与白名单（D36）', () => {
  const clock = fakeClock();
  const store = new MemoryOperatorTokenStore();
  store.add({ id: 'op', hmac: hmacToken(TOKEN_SECRET, 'placeholder-op-a'), capabilities: ['inbox:read', 'keys:read'], revokedAt: null, expiresAt: new Date('2026-10-28T00:00:00Z') });
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
    expect(principalCan(p!, 'inbox:read')).toBe(true);
    expect(principalCan(p!, 'keys:read')).toBe(false); // 不在白名单
    expect(principalCan(p!, 'inbox:act')).toBe(false); // 在白名单但未授权
  });

  it('白名单不含 Key、彻底删除、不可逆确认、审计读取', () => {
    for (const c of ['keys:read', 'keys:write', 'keys:delete', 'members:purge', 'members:delete', 'inbox:confirm-irreversible', 'audit:read'] as const) {
      expect(OPERATOR_WHITELIST.has(c)).toBe(false);
    }
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
