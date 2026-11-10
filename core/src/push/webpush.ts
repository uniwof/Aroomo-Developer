/**
 * X-08 网页推送的协议部分：VAPID（RFC 8292）签名 + aes128gcm 消息加密（RFC 8291 / RFC 8188）。
 * 只用 node:crypto，不加依赖（ponytail 第 4 条：几十行能写的不加包；web-push 包会带进 10+ 个间接依赖）。
 * 加密按 RFC 8291 第 5 节 / 附录 A 的测试向量验证（core/test/push-webpush.test.ts）。
 */
import { createECDH, createPrivateKey, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto';

export const b64u = {
  enc: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  dec: (s: string): Buffer => Buffer.from(s, 'base64url'),
};

export interface VapidKeys {
  /** 65 字节未压缩公钥（0x04 开头），base64url */
  publicKey: string;
  /** 32 字节私钥，base64url */
  privateKey: string;
  /** mailto: 或 https: 联系方式（推送服务出问题时联系谁） */
  subject: string;
}

/**
 * 生成一对 VAPID 密钥（scripts/gen-vapid-keys.mjs 用同样的写法；这里给测试用）。
 * getPrivateKey() 会去掉前导零（首字节为 0 时约 1/256 只有 31 字节），这里左补零到固定 32 字节（#348）。
 * test.privateKey 可注入，只为确定性测试；正式调用不传。
 */
export function generateVapidKeys(test?: { privateKey: Buffer }): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(test.privateKey);
  else ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  return { publicKey: b64u.enc(ecdh.getPublicKey()), privateKey: b64u.enc(Buffer.concat([Buffer.alloc(32 - d.length), d])) };
}

/** 校验密钥形状：公钥 65 字节且以 0x04 开头、私钥 32 字节，并且两者是一对 */
export function vapidKeysValid(publicKey: string, privateKey: string): boolean {
  try {
    const pub = b64u.dec(publicKey);
    const priv = b64u.dec(privateKey);
    if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
}

function vapidPrivateKey(k: VapidKeys): KeyObject {
  const pub = b64u.dec(k.publicKey);
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: k.privateKey, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

/** Authorization 头：`vapid t=<ES256 JWT>, k=<公钥>`；aud = 推送地址的源，有效期 12 小时（上限 24 小时） */
export function vapidAuthorization(endpoint: string, k: VapidKeys, now: Date): string {
  const header = b64u.enc(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.enc(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 12 * 3600, sub: k.subject })));
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: vapidPrivateKey(k), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u.enc(sig)}, k=${k.publicKey}`;
}

/**
 * aes128gcm 加密（单条记录，rs = 4096）。salt、发送方临时密钥可注入，只为对上 RFC 测试向量；正式调用不传。
 * 订阅公钥不在 P-256 曲线上时 computeSecret 会抛错（RFC 8291 第 7 节要求校验）。
 */
export function encryptPayload(
  plaintext: Uint8Array,
  sub: { p256dh: string; auth: string },
  test?: { salt: Buffer; asPrivate: Buffer },
): Buffer {
  const uaPublic = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  const ecdh = createECDH('prime256v1');
  if (test) ecdh.setPrivateKey(test.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = test?.salt ?? randomBytes(16);
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}
