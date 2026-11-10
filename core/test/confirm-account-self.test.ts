/** #346 负责人第 1 轮 M2 / M3 / M5 附：ConfirmService 单元反向用例、allowAccount 结构测试、actor 绑定那道护栏单独有证据。 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditFn } from '../src/audit/types.js';
import { type ChallengeRow, ConfirmService, type ConfirmSpec, isAccountSelf, MemoryChallengeStore } from '../src/confirm/confirm.js';

const now = () => new Date('2026-11-10' + 'T00:00:00.000Z');
const spec: ConfirmSpec = { scope: 'vault.reveal:x1', kind: 'credential', title: '查看', consequences: ['明文会显示'], allowAccount: true, payload: { id: 'x1' } };
const fam = { actor: 'user:fam1', canConfirmImportant: false, principalType: 'user' as const };

function svc(store = new MemoryChallengeStore()) {
  const audits: string[] = [];
  const audit: AuditFn = async (action, _t, result, note) => {
    audits.push(`${action}:${result}:${note ?? ''}`);
  };
  const s = new ConfirmService(store, { now, reauth: 'off', accountPassword: async () => {} });
  return { s, audit, audits, store };
}
const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    const x = e as { statusCode?: number; code?: string };
    return [x.statusCode, x.code];
  }
};

describe('#346 isAccountSelf / require：只有账号会话 + 声明了 allowAccount 才能本人确认', () => {
  it('凭据类型不是 user（arc_ / 操作员 / 设备令牌 / 没填）一律不是本人确认，即使 actor 看起来像 user:', () => {
    expect(isAccountSelf(spec, fam)).toBe(true);
    for (const principalType of ['client', 'operator', 'owner', undefined] as const)
      expect([principalType, isAccountSelf(spec, { ...fam, principalType })]).toEqual([principalType, false]);
    expect(isAccountSelf(spec, { ...fam, actor: 'client:c1' })).toBe(false);
    expect(isAccountSelf(spec, { ...fam, canConfirmImportant: true })).toBe(false); // 主人账号走主人那条路
    expect(isAccountSelf({ ...spec, allowAccount: undefined }, fam)).toBe(false);
  });

  it('伪造 actor=user: 的客户端上下文：403 + confirm.denied，不建卡', async () => {
    const t = svc();
    expect(await status(t.s.require(spec, { ...fam, principalType: 'client' }, t.audit))).toEqual([403, 'FORBIDDEN']);
    expect(t.audits).toEqual(['confirm.denied:denied:credential']);
  });

  it('M3 负向：家人请求没声明 allowAccount 的重要确认 → 403 + confirm.denied', async () => {
    const t = svc();
    expect(await status(t.s.require({ ...spec, allowAccount: undefined }, fam, t.audit))).toEqual([403, 'FORBIDDEN']);
    expect(t.audits).toEqual(['confirm.denied:denied:credential']);
  });

  it('没接密码核对：家人本人确认 503，失败即关闭', async () => {
    const s = new ConfirmService(new MemoryChallengeStore(), { now, reauth: 'off' });
    expect(await status(s.require(spec, fam, async () => {}))).toEqual([503, 'ACCOUNT_REAUTH_NOT_CONFIGURED']);
  });

  it('actor 绑定护栏单独有证据：存储层不按 actor 过滤（坏掉的 store）时，consume 里的 r.actor 比对仍拒 CONFIRM_INVALID', async () => {
    class LeakyStore extends MemoryChallengeStore {
      leaked: ChallengeRow | null = null;
      override async findByTokenHash(): Promise<ChallengeRow | null> {
        return this.leaked;
      }
    }
    const store = new LeakyStore();
    const t = svc(store);
    store.leaked = { id: 'c1', scope: spec.scope, actor: 'user:other', kind: 'credential', title: 't', consequences: ['x'], confirmLabel: '确认', payloadSalt: null, payloadDigest: null, requiresReauth: false, createdAt: now(), expiresAt: new Date(now().getTime() + 60_000), step1At: now(), tokenHash: 'h', tokenIssuedAt: now(), usedAt: null };
    expect(await status(t.s.require(spec, { ...fam, confirmToken: 'tok' }, t.audit))).toEqual([409, 'CONFIRM_INVALID']);
    expect(t.audits).toEqual(['confirm.rejected:failed:CONFIRM_INVALID']);
  });
});

describe('#346 M3 结构测试：allowAccount: true 只在保险箱 reveal / delete 两处', () => {
  it('src 里正好 2 处，都在 vault/service.ts；新增调用点要改这条并走 A+ 审查', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/allowAccount:\s*true/g)) hits.push(`${p.replace(/^.*src\//, 'src/')}@${m.index}`);
      }
    };
    walk(join(__dirname, '..', 'src'));
    expect(hits.map((h) => h.split('@')[0])).toEqual(['src/vault/service.ts', 'src/vault/service.ts']);
  });
});
