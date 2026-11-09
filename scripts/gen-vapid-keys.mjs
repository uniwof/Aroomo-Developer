#!/usr/bin/env node
// X-08 推送提醒：生成一对 VAPID 密钥（P-256），打印成 .env 的三行。只用 node:crypto，不联网。
// 用法：node scripts/gen-vapid-keys.mjs [mailto:邮箱] >> 服务器的 .env（权限 600）。私钥绝不提交、不发到聊天里。
import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
// getPrivateKey() 去掉前导零（约 1/256 只有 31 字节，config 会拒）：左补零到 32 字节（#348）
const d = ecdh.getPrivateKey();
const privateKey = Buffer.concat([Buffer.alloc(32 - d.length), d]);
const subject = process.argv[2] ?? 'mailto:CHANGE_ME@example.com';
process.stdout.write(
  `VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}\nVAPID_PRIVATE_KEY=${privateKey.toString('base64url')}\nVAPID_SUBJECT=${subject}\n`,
);
