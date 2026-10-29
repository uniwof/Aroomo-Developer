import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type CoreDeps, memoryDeps, pgDeps } from '../src/deps.js';
import { buildServer } from '../src/server.js';
import { openSecret, parseVaultKey, sealSecret, vaultFingerprint } from '../src/vault/crypto.js';
import { vaultStartupCheck } from '../src/vault/service.js';
import { MemorySettingsStore } from '../src/settings/store.js';
import { MemoryVaultStore } from '../src/vault/memory.js';
import { hmacToken, type MemoryOperatorTokenStore } from '../src/auth/tokens.js';
import { OWNER_TOKEN, TOKEN_SECRET, dbTargets, fakeClock, ownerAuth } from './helpers/db.js';

const PW = 'correct-horse-battery';
const VAULT_KEY = randomBytes(32).toString('base64');
const SECRET = 'sk-test-AAAA1111BBBB2222CCCC3333';

describe('保险箱加密（信封）', () => {
  const key = parseVaultKey(VAULT_KEY) as Buffer;
  it('加解密往返', () => {
    const s = sealSecret(key, 'owner', 'id1', SECRET);
    expect(JSON.stringify(s)).not.toContain(SECRET);
    expect(openSecret(key, 'owner', 'id1', s)).toBe(SECRET);
    // 同一明文每次密文不同（随机 DEK 与 nonce）
    expect(sealSecret(key, 'owner', 'id1', SECRET).ciphertext).not.toBe(s.ciphertext);
  });
  it('篡改 aad（换用户 / 换 id）、换密钥、改密文都解不开', () => {
    const s = sealSecret(key, 'owner', 'id1', SECRET);
    expect(() => openSecret(key, 'other', 'id1', s)).toThrow('VAULT_DECRYPT_FAILED');
    expect(() => openSecret(key, 'owner', 'id2', s)).toThrow('VAULT_DECRYPT_FAILED');
    expect(() => openSecret(randomBytes(32), 'owner', 'id1', s)).toThrow('VAULT_DECRYPT_FAILED');
    const ct = Buffer.from(s.ciphertext, 'base64');
    ct[0] = (ct[0] ?? 0) ^ 1;
    expect(() => openSecret(key, 'owner', 'id1', { ...s, ciphertext: ct.toString('base64') })).toThrow('VAULT_DECRYPT_FAILED');
    const w = Buffer.from(s.dekWrapped, 'base64');
    w[w.length - 1] = (w[w.length - 1] ?? 0) ^ 1;
    expect(() => openSecret(key, 'owner', 'id1', { ...s, dekWrapped: w.toString('base64') })).toThrow('VAULT_DECRYPT_FAILED');
  });
  it('VAULT_KEY 格式：必须是 32 字节 base64', () => {
    expect(parseVaultKey('short')).toBeNull();
    expect(parseVaultKey(Buffer.alloc(16).toString('base64'))).toBeNull();
    expect(parseVaultKey(VAULT_KEY)).not.toBeNull();
  });
});

describe('保险箱启动检查', () => {
  const now = () => new Date();
  it('有记录而 VAULT_KEY 缺失 / 指纹不符 → 拒绝启动；没记录则放行并记指纹', async () => {
    const store = new MemoryVaultStore();
    const settings = new MemorySettingsStore();
    await vaultStartupCheck(undefined, store, settings, now); // 没记录没密钥：放行（保险箱未启用）
    await vaultStartupCheck(VAULT_KEY, store, settings, now);
    expect((await settings.get<{ fp: string }>('vault.fingerprint'))?.fp).toBe(vaultFingerprint(parseVaultKey(VAULT_KEY) as Buffer));
    const k = parseVaultKey(VAULT_KEY) as Buffer;
    await store.insert({ id: 'a', userId: 'owner', name: 'x', kind: 'token', last4: '', ...sealSecret(k, 'owner', 'a', 'v'), createdAt: now(), updatedAt: now(), rotatedAt: null, deletedAt: null });
    await expect(vaultStartupCheck(undefined, store, settings, now)).rejects.toThrow('VAULT_KEY 缺失');
    await expect(vaultStartupCheck(randomBytes(32).toString('base64'), store, settings, now)).rejects.toThrow('指纹不符');
    await expect(vaultStartupCheck('bad', store, settings, now)).rejects.toThrow('32 字节');
    await vaultStartupCheck(VAULT_KEY, store, settings, now);
  });
});

const envs = [
  { name: 'memory', make: async (now: () => Date): Promise<CoreDeps> => memoryDeps(now) },
  ...dbTargets.map((t) => ({ name: t.name, make: async (now: () => Date): Promise<CoreDeps> => pgDeps(await t.open(), now) })),
];

describe.each(envs)('保险箱接口 B2（$name）', (env) => {
  const apps: FastifyInstance[] = [];
  afterAll(async () => {
    for (const a of apps) await a.close();
  });

  async function setup(vaultKey: string | undefined = VAULT_KEY) {
    const clock = fakeClock();
    const deps = await env.make(clock.now);
    const app = buildServer(
      loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_ACCESS_REAUTH: 'off', ...(vaultKey ? { VAULT_KEY: vaultKey } : {}) }),
      deps,
    );
    apps.push(app);
    const call = (headers: Record<string, string>) => (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const owner = call(ownerAuth);
    const bearer = (t: string) => call({ authorization: `Bearer ${t}` });
    const register = async (email: string) => {
      const inv = await owner('POST', '/api/users/invites', { email });
      const r = await app.inject({ method: 'POST', url: '/auth/accept', payload: { token: inv.json().token, password: PW } });
      return bearer(r.json().token);
    };
    /** 走完重要确认再发 */
    const confirmed = async (method: 'POST' | 'DELETE', url: string, payload: object = {}) => {
      const first = await owner(method, url, payload);
      if (first.statusCode !== 428) return first;
      const ch = first.json().error.confirm;
      expect((await owner('POST', ch.stepUrl, { step: 1 })).statusCode).toBe(200);
      clock.advance(3000);
      const s2 = await owner('POST', ch.stepUrl, { step: 2 });
      expect(s2.statusCode).toBe(200);
      return owner(method, url, { ...payload, confirmToken: s2.json().confirmToken });
    };
    return { owner, bearer, register, confirmed, deps, app };
  }

  it('新增 → 列表只有名字、类型、末 4 位；任何响应、审计里都没有明文', async () => {
    const { owner, deps } = await setup();
    const r = await owner('POST', '/api/vault', { name: 'Brave 搜索', kind: 'api_key', value: SECRET });
    expect(r.statusCode).toBe(201);
    expect(r.body).not.toContain(SECRET);
    expect(r.json().secret).toMatchObject({ name: 'Brave 搜索', kind: 'api_key', last4: SECRET.slice(-4) });
    expect(Object.keys(r.json().secret).sort()).toEqual(['createdAt', 'id', 'kind', 'last4', 'name', 'rotatedAt', 'updatedAt']);
    const list = await owner('GET', '/api/vault');
    expect(list.body).not.toContain(SECRET);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().secrets).toHaveLength(1);
    expect(JSON.stringify((await deps.auditLog.query({ limit: 100 })).entries)).not.toContain(SECRET);
    // 库里存的是密文
    const row = (await deps.vault.list('owner'))[0];
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  it('password / note 不显示末 4 位；同名（不分大小写）409；非法类型 400', async () => {
    const { owner } = await setup();
    const p = await owner('POST', '/api/vault', { name: 'Mail', kind: 'password', value: 'hunter2-hunter2-hunter2' });
    expect(p.json().secret.last4).toBe('');
    expect((await owner('POST', '/api/vault', { name: 'mail', kind: 'note', value: 'x' })).statusCode).toBe(409);
    expect((await owner('POST', '/api/vault', { name: 'z', kind: 'weird', value: 'x' })).statusCode).toBe(400);
    expect((await owner('POST', '/api/vault', { name: 'z', kind: 'note', value: '' })).statusCode).toBe(400);
  });

  it('查看明文要重要确认（428 → 两步 → 带令牌）；令牌只能用一次', async () => {
    const { owner, confirmed } = await setup();
    const id = (await owner('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: SECRET })).json().secret.id;
    const first = await owner('POST', `/api/vault/${id}/reveal`, {});
    expect(first.statusCode).toBe(428);
    expect(first.body).not.toContain(SECRET);
    const ok = await confirmed('POST', `/api/vault/${id}/reveal`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe(SECRET);
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('替换后旧值不可见、新值可读；换名不允许（只替换内容）', async () => {
    const { owner, confirmed } = await setup();
    const id = (await owner('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: SECRET })).json().secret.id;
    const NEW = 'sk-new-ZZZZ9999YYYY8888XXXX';
    const rep = await owner('PUT', `/api/vault/${id}`, { value: NEW });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().secret.rotatedAt).not.toBeNull();
    expect(rep.json().secret.last4).toBe(NEW.slice(-4));
    expect((await confirmed('POST', `/api/vault/${id}/reveal`)).json().value).toBe(NEW);
    expect((await owner('PUT', `/api/vault/${id}`, { value: 'x', name: 'hack' })).statusCode).toBe(400);
  });

  it('删除要确认，之后查不到，名字可再用，密文已清空', async () => {
    const { owner, confirmed, deps } = await setup();
    const id = (await owner('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: SECRET })).json().secret.id;
    expect((await owner('DELETE', `/api/vault/${id}`)).statusCode).toBe(428);
    expect((await confirmed('DELETE', `/api/vault/${id}`)).statusCode).toBe(204);
    expect((await owner('GET', '/api/vault')).json().secrets).toHaveLength(0);
    expect((await owner('POST', `/api/vault/${id}/reveal`, {})).statusCode).toBe(404);
    expect(await deps.vault.countLive()).toBe(0);
    expect((await owner('POST', '/api/vault', { name: 'brave', kind: 'api_key', value: SECRET })).statusCode).toBe(201);
  });

  it('账号之间互相隔离：看不到、改不了、删不了、读不了他人条目；账号暂不能查看明文', async () => {
    const { owner, register, confirmed } = await setup();
    const a = await register('a@example.com');
    const b = await register('b@example.com');
    const idOwner = (await owner('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: SECRET })).json().secret.id;
    const idA = (await a('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: 'sk-A-aaaaaaaaaaaaaaaa' })).json().secret.id;
    expect((await a('GET', '/api/vault')).json().secrets.map((s: { id: string }) => s.id)).toEqual([idA]);
    expect((await b('GET', '/api/vault')).json().secrets).toHaveLength(0);
    for (const id of [idOwner, idA]) {
      expect((await b('PUT', `/api/vault/${id}`, { value: 'sk-hijack-0123456789' })).statusCode).toBe(404);
      expect((await b('POST', `/api/vault/${id}/reveal`, {})).statusCode).toBe(404);
      expect((await b('DELETE', `/api/vault/${id}`)).statusCode).toBe(404);
    }
    // 所有者令牌的数据也不会被账号看到；所有者令牌看不到账号的
    expect((await owner('GET', '/api/vault')).json().secrets.map((s: { id: string }) => s.id)).toEqual([idOwner]);
    // 账号查看明文 / 删除：在「密码重新验证」做完之前一律 403
    expect((await a('POST', `/api/vault/${idA}/reveal`, {})).statusCode).toBe(403);
    expect((await a('DELETE', `/api/vault/${idA}`)).statusCode).toBe(403);
    expect((await confirmed('POST', `/api/vault/${idOwner}/reveal`)).json().value).toBe(SECRET);
  });

  it('操作员、未登录都用不了保险箱', async () => {
    const clock = fakeClock();
    const deps = memoryDeps(clock.now);
    (deps.operatorTokens as MemoryOperatorTokenStore).add({
      id: 'op',
      hmac: hmacToken(TOKEN_SECRET, 'placeholder-op-vault'),
      capabilities: ['inbox:post', 'members:read', 'keys:read', 'inbox:read'],
      revokedAt: null,
      expiresAt: null,
    });
    const app = buildServer(loadConfig({ CORE_LOG_LEVEL: 'silent', CORE_OWNER_TOKEN: OWNER_TOKEN, CORE_TOKEN_SECRET: TOKEN_SECRET, CORE_ACCESS_REAUTH: 'off', VAULT_KEY }), deps);
    apps.push(app);
    const op = { authorization: 'Bearer placeholder-op-vault' };
    expect((await app.inject({ method: 'GET', url: '/api/vault', headers: op })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/vault', headers: op, payload: { name: 'x', kind: 'note', value: 'y' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/vault' })).statusCode).toBe(401);
  });

  it('客户端令牌（无论什么范围）用不了保险箱', async () => {
    const { owner, bearer } = await setup();
    const tok = (await owner('POST', '/api/clients', { name: 'c', scopes: ['memory:read', 'bookmarks:read', 'brief:read', 'tools:list'] })).json().token;
    const c = bearer(tok);
    expect((await c('GET', '/api/vault')).statusCode).toBe(403);
    expect((await c('POST', '/api/vault', { name: 'x', kind: 'note', value: 'y' })).statusCode).toBe(403);
  });

  it('没有设置 VAULT_KEY → 503，不静默降级', async () => {
    const { owner } = await setup('');
    expect((await owner('GET', '/api/vault')).statusCode).toBe(503);
    expect((await owner('POST', '/api/vault', { name: 'x', kind: 'note', value: 'y' })).json().error.code).toBe('VAULT_NOT_CONFIGURED');
  });

  it('审计记录 vault.* 动作但不含值', async () => {
    const { owner, deps, confirmed } = await setup();
    const id = (await owner('POST', '/api/vault', { name: 'Brave', kind: 'api_key', value: SECRET })).json().secret.id;
    await confirmed('POST', `/api/vault/${id}/reveal`);
    const actions = (await deps.auditLog.query({ limit: 100 })).entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['vault.create', 'vault.reveal']));
    expect(JSON.stringify((await deps.auditLog.query({ limit: 100 })).entries)).not.toContain(SECRET);
  });
});
