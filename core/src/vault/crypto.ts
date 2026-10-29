/**
 * 保险箱信封加密（HUB.md 2.2）。
 * 每条记录一把随机 DEK（AES-256-GCM）加密明文；DEK 再用 VAULT_KEY 加密（同样 AES-256-GCM）后随记录存放。
 * 两层都把 aad = `${userId}\0${secretId}` 绑进认证标签：把 A 的密文拷到 B 名下或换 id，解密一律失败。
 * 全部以 base64 文本存放：ciphertext = 密文||标签；dekWrapped = 包装 nonce||密文||标签；nonce = 数据 nonce。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const NONCE = 12;
const TAG = 16;

export interface SealedSecret {
  ciphertext: string;
  dekWrapped: string;
  nonce: string;
}

/** VAULT_KEY：32 字节 base64。格式不对返回 null（调用方决定怎么拒绝）。 */
export function parseVaultKey(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(raw.trim())) return null;
  const buf = Buffer.from(raw.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return buf.length === 32 ? buf : null;
}

/** 指纹：SHA-256(VAULT_KEY) 前 8 字节（十六进制）。不是秘密，用来发现「换了密钥却没迁移」。 */
export const vaultFingerprint = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 16);

const aadOf = (userId: string, secretId: string) => Buffer.from(`${userId}\u0000${secretId}`, 'utf8');

function encrypt(key: Buffer, nonce: Buffer, aad: Buffer, plain: Buffer): Buffer {
  const c = createCipheriv(ALG, key, nonce);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

function decrypt(key: Buffer, nonce: Buffer, aad: Buffer, sealed: Buffer): Buffer {
  if (sealed.length < TAG) throw new Error('VAULT_DECRYPT_FAILED');
  const d = createDecipheriv(ALG, key, nonce);
  d.setAAD(aad);
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}

export function sealSecret(vaultKey: Buffer, userId: string, secretId: string, plaintext: string): SealedSecret {
  const aad = aadOf(userId, secretId);
  const dek = randomBytes(32);
  const nonce = randomBytes(NONCE);
  const wrapNonce = randomBytes(NONCE);
  const ciphertext = encrypt(dek, nonce, aad, Buffer.from(plaintext, 'utf8'));
  const wrapped = Buffer.concat([wrapNonce, encrypt(vaultKey, wrapNonce, aad, dek)]);
  dek.fill(0);
  return { ciphertext: ciphertext.toString('base64'), dekWrapped: wrapped.toString('base64'), nonce: nonce.toString('base64') };
}

/** 解不开（密钥不对、被篡改、aad 不符）一律抛同一个错误，不区分原因。 */
export function openSecret(vaultKey: Buffer, userId: string, secretId: string, s: SealedSecret): string {
  try {
    const aad = aadOf(userId, secretId);
    const w = Buffer.from(s.dekWrapped, 'base64');
    if (w.length < NONCE + TAG + 32) throw new Error('short');
    const dek = decrypt(vaultKey, w.subarray(0, NONCE), aad, w.subarray(NONCE));
    try {
      return decrypt(dek, Buffer.from(s.nonce, 'base64'), aad, Buffer.from(s.ciphertext, 'base64')).toString('utf8');
    } finally {
      dek.fill(0);
    }
  } catch {
    throw new Error('VAULT_DECRYPT_FAILED');
  }
}
