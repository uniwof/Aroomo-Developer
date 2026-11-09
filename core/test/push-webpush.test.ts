/** X-08：Web Push 加密对上 RFC 8291 第 5 节 / 附录 A 的测试向量；VAPID 签名能用公钥验过。 */
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64u, encryptPayload, generateVapidKeys, vapidAuthorization, vapidKeysValid } from '../src/push/webpush.js';

describe('Web Push 协议', () => {
  it('aes128gcm 加密结果和 RFC 8291 示例逐字节一致', () => {
    const out = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      { salt: b64u.dec('DGv6ra1nlYgDCS1FRnbzlw'), asPrivate: b64u.dec('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
    );
    expect(b64u.enc(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('订阅公钥不在 P-256 曲线上 → 抛错（不发）', () => {
    const bad = Buffer.alloc(65, 1);
    bad[0] = 4;
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: b64u.enc(bad), auth: 'BTBZMqHH6r4Tts7J_aSIgg' })).toThrow();
  });

  it('VAPID 私钥恒为 32 字节：首字节为 0 时左补零，仍和公钥成对、能签名（#348）', () => {
    const d = Buffer.alloc(32, 1);
    d[0] = 0;
    const k = generateVapidKeys({ privateKey: d });
    expect(b64u.dec(k.privateKey)).toEqual(d);
    expect(vapidKeysValid(k.publicKey, k.privateKey)).toBe(true);
    expect(() => vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', { ...k, subject: 'mailto:owner@example.test' }, new Date())).not.toThrow();
    for (let i = 0; i < 2000; i++) expect(b64u.dec(generateVapidKeys().privateKey).length).toBe(32);
  });

  it('VAPID：ES256 JWT 能用公钥验过；aud 是推送地址的源，exp ≤ 24 小时', () => {
    const k = { ...generateVapidKeys(), subject: 'mailto:owner@example.test' };
    expect(vapidKeysValid(k.publicKey, k.privateKey)).toBe(true);
    expect(vapidKeysValid(generateVapidKeys().publicKey, k.privateKey)).toBe(false);
    const now = new Date('2026-11-05T14:00:00Z');
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc?x=1', k, now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(k.publicKey);
    const claims = JSON.parse(b64u.dec(m[2]!).toString()) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.sub).toBe('mailto:owner@example.test');
    expect(claims.exp - now.getTime() / 1000).toBeLessThanOrEqual(24 * 3600);
    const pub = b64u.dec(k.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b64u.dec(m[3]!))).toBe(true);
  });
});
