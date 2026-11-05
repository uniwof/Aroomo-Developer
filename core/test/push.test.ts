/**
 * X-08 推送提醒：默认关；只给所有者；订阅只存本账号；收件箱新条目触发推送，锁屏上只有固定短标题；
 * 订阅失效（410）自动删；迁移可回退。存储跑 memory + PGlite（+ CI 的真 PostgreSQL）。
 */
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { b64u, generateVapidKeys } from '../src/push/webpush.js';
import { openPglite } from './helpers/db.js';
import { twoAccountEnvs, twoAccounts, type DepsEnv, type TwoAccounts } from './helpers/two-accounts.js';

const VAPID = generateVapidKeys();
const ON = { PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: VAPID.publicKey, VAPID_PRIVATE_KEY: VAPID.privateKey, VAPID_SUBJECT: 'mailto:owner@example.test' };

/** 一台假的浏览器：自己的 ECDH 密钥 + auth，能解开推送 */
function device(host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub = { endpoint: `https://${host}/fcm/send/${randomBytes(8).toString('hex')}`, keys: { p256dh: b64u.enc(ecdh.getPublicKey()), auth: b64u.enc(auth) } };
  const decrypt = (body: Buffer): unknown => {
    const salt = body.subarray(0, 16);
    const idlen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(asPublic), auth, keyInfo, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = createDecipheriv('aes-128-gcm', cek, nonce);
    d.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    expect(plain.at(-1)).toBe(2);
    return JSON.parse(plain.subarray(0, -1).toString());
  };
  return { sub, decrypt };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

describe.each(twoAccountEnvs)('X-08 推送提醒（$name）', (env: DepsEnv) => {
  let t: TwoAccounts;
  const sent: Sent[] = [];
  let status = 201;
  const start = async (over: Record<string, string> = ON) => {
    sent.length = 0;
    status = 201;
    t = await twoAccounts(
      {
        name: env.name,
        make: async (now) => {
          const deps = await env.make(now);
          deps.pushFetch = (async (url: string, init: { headers: Record<string, string>; body: Buffer }) => {
            sent.push({ url, headers: init.headers, body: init.body });
            return new Response(null, { status });
          }) as unknown as typeof fetch;
          return deps;
        },
      },
      over,
    );
  };
  afterEach(async () => t?.close());
  const ownerItem = (over: Record<string, unknown> = {}) =>
    t.app.inbox.createInboxItem(
      { group: 'decision', kind: 'assistant.run.confirm', title: '资源周报 想调用付费模型 PaidBot，等你确认', summary: '成员：PaidBot', related: { type: 'assistant_run', id: 'r1' }, actions: [{ id: 'reject', label: '拒绝' }], ...over },
      async () => undefined,
    );

  it('默认关：GET 说没开、不给公钥；订阅 503；收件箱新条目不发', async () => {
    await start({});
    expect((await t.owner('GET', '/api/push')).json()).toEqual({ enabled: false, publicKey: null, devices: 0 });
    const r = await t.owner('POST', '/api/push/subscriptions', device().sub);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('PUSH_DISABLED');
    await ownerItem();
    await new Promise((res) => setTimeout(res, 20));
    expect(sent).toHaveLength(0);
  });

  it('所有者订阅：201 → 重复 200；状态只给设备数，响应里从不出现 endpoint', async () => {
    await start();
    const d = device();
    const a = await t.owner('POST', '/api/push/subscriptions', { ...d.sub, expirationTime: null });
    expect(a.statusCode).toBe(201);
    expect(a.body).not.toContain(d.sub.endpoint);
    expect((await t.owner('POST', '/api/push/subscriptions', d.sub)).statusCode).toBe(200);
    const s = await t.owner('GET', '/api/push');
    expect(s.json()).toEqual({ enabled: true, publicKey: VAPID.publicKey, devices: 1 });
    expect((await t.owner('POST', '/api/push/subscriptions/remove', { endpoint: d.sub.endpoint })).statusCode).toBe(200);
    expect((await t.owner('GET', '/api/push')).json().devices).toBe(0);
    // 再删一次也成功（重复点不报错）
    expect((await t.owner('POST', '/api/push/subscriptions/remove', { endpoint: d.sub.endpoint })).statusCode).toBe(200);
  });

  it('只接受浏览器推送服务的 https 地址和合法密钥（不能把 Core 当跳板）', async () => {
    await start();
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://evil.example/x', 'https://fcm.googleapis.com.evil.example/x', 'https://u:p@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://127.0.0.1/x']) {
      const r = await t.owner('POST', '/api/push/subscriptions', { ...device().sub, endpoint });
      expect(r.statusCode, endpoint).toBe(400);
    }
    for (const host of ['web.push.apple.com', 'updates.push.services.mozilla.com', 'wns2-sg2p.notify.windows.com']) {
      expect((await t.owner('POST', '/api/push/subscriptions', device(host).sub)).statusCode, host).toBe(201);
    }
    const bad = device().sub;
    expect((await t.owner('POST', '/api/push/subscriptions', { ...bad, keys: { ...bad.keys, auth: b64u.enc(randomBytes(12)) } })).statusCode).toBe(400);
    expect((await t.owner('POST', '/api/push/subscriptions', { ...bad, extra: 1 })).statusCode).toBe(400);
  });

  it('家人账号：所有推送接口 403（先判权限再校验请求体），也看不到所有者有几台设备', async () => {
    await start();
    await t.owner('POST', '/api/push/subscriptions', device().sub);
    expect((await t.xiao('GET', '/api/push')).statusCode).toBe(403);
    expect((await t.xiao('POST', '/api/push/subscriptions', device().sub)).statusCode).toBe(403);
    expect((await t.xiao('POST', '/api/push/subscriptions', { junk: true })).statusCode).toBe(403);
    expect((await t.xiao('POST', '/api/push/subscriptions/remove', { endpoint: 'https://fcm.googleapis.com/x' })).statusCode).toBe(403);
    expect((await t.xiao('POST', '/api/push/test')).statusCode).toBe(403);
    expect((await t.owner('GET', '/api/push')).json().devices).toBe(1);
  });

  it('收件箱「等你确认」→ 每台设备收到一条：只有固定短标题和收件箱链接，不含条目标题、成员名', async () => {
    await start();
    const a = device();
    const b = device('web.push.apple.com');
    await t.owner('POST', '/api/push/subscriptions', a.sub);
    await t.owner('POST', '/api/push/subscriptions', b.sub);
    const { item } = await ownerItem();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    const toA = sent.find((s) => s.url === a.sub.endpoint)!;
    expect(toA.headers['Content-Encoding']).toBe('aes128gcm');
    expect(toA.headers.Urgency).toBe('high');
    expect(toA.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(a.decrypt(toA.body)).toEqual({ title: '有事等你确认', url: '/console/chat?view=inbox', tag: item.id });
    expect(b.decrypt(sent.find((s) => s.url === b.sub.endpoint)!.body)).toEqual({ title: '有事等你确认', url: '/console/chat?view=inbox', tag: item.id });
    expect(toA.body.toString('latin1')).not.toContain('PaidBot');
  });

  it('助手运行完成 / 失败各发一句；去重命中、普通简报、家人的条目都不发', async () => {
    await start();
    const d = device();
    await t.owner('POST', '/api/push/subscriptions', d.sub);
    await ownerItem({ group: 'brief', kind: 'assistant.run.done', urgency: 'low', title: '资源周报 运行完成', actions: [], related: { type: 'assistant_run', id: 'r2' } });
    await ownerItem({ kind: 'assistant.run.failed', title: '资源周报 运行失败', actions: [], related: { type: 'assistant_run', id: 'r3' } });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((s) => (d.decrypt(s.body) as { title: string }).title).sort()).toEqual(['助手运行失败', '助手运行完成']);
    sent.length = 0;
    await ownerItem({ kind: 'assistant.run.failed', title: 'again', actions: [], related: { type: 'assistant_run', id: 'r3' } }); // 去重
    await ownerItem({ group: 'brief', kind: 'note', title: '普通简报', actions: [], related: { type: 'x', id: 'y' } });
    await ownerItem({ userId: t.xiaoId, related: { type: 'assistant_run', id: 'r9' } });
    await new Promise((res) => setTimeout(res, 30));
    expect(sent).toHaveLength(0);
  });

  it('推送服务说订阅没了（410）→ 删掉这行；其他失败不删', async () => {
    await start();
    await t.owner('POST', '/api/push/subscriptions', device().sub);
    status = 500;
    expect((await t.owner('POST', '/api/push/test')).json()).toEqual({ sent: 0 });
    expect((await t.owner('GET', '/api/push')).json().devices).toBe(1);
    status = 201;
    expect((await t.owner('POST', '/api/push/test')).json()).toEqual({ sent: 1 });
    status = 410;
    await t.owner('POST', '/api/push/test');
    expect((await t.owner('GET', '/api/push')).json().devices).toBe(0);
  });

  it('最多 10 台设备；已有的设备刷新不算新的', async () => {
    await start();
    const first = device();
    await t.owner('POST', '/api/push/subscriptions', first.sub);
    for (let i = 0; i < 9; i++) await t.owner('POST', '/api/push/subscriptions', device().sub);
    expect((await t.owner('POST', '/api/push/subscriptions', device().sub)).statusCode).toBe(409);
    expect((await t.owner('POST', '/api/push/subscriptions', first.sub)).statusCode).toBe(200);
  });
});

describe('迁移 0029 推送订阅', () => {
  it('up → down → up 可回退', async () => {
    const db = await openPglite();
    const has = async () => (await db.query(`SELECT 1 FROM pg_tables WHERE tablename = 'push_subscriptions' AND schemaname = current_schema()`)).rows.length;
    expect(await has()).toBe(1);
    await db.exec(readFileSync(fileURLToPath(new URL('../migrations/down/0029_push_subscriptions.down.sql', import.meta.url)), 'utf8'));
    expect(await has()).toBe(0);
    expect(await migrate(db)).toEqual(['0029_push_subscriptions.sql']);
    expect(await has()).toBe(1);
    await db.close();
  });
});
