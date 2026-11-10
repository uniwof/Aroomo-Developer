/**
 * Cloudflare Access Service Token（#365 方向 1a）：执行员经公网请求 <coreUrl>/api/executor/* 时带
 * CF-Access-Client-Id / CF-Access-Client-Secret 两个头。
 *  - Client ID 不是秘密，写在 config.json 的 cfAccess.clientId。
 *  - Client Secret 不写明文配置：Windows 用 DPAPI（当前用户）加密存在配置目录 cf-access-secret.dpapi
 *    （沿用项目已有做法：独立版主密钥 D78）；其他系统只认环境变量 AROOMO_CF_ACCESS_CLIENT_SECRET。
 *  - 任何错误消息、日志都不带 Secret 的值。
 * shortcut: DPAPI 经 powershell 子进程（Secret 走子进程环境变量，不进命令行）；以后有原生凭据库依赖再换。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecutorConfig } from './config.js';

export const CF_SECRET_ENV = 'AROOMO_CF_ACCESS_CLIENT_SECRET';
export const CF_SECRET_FILE = 'cf-access-secret.dpapi';

/** 跑一段 PowerShell，输入经环境变量 AROOMO_DPAPI_IN 传入，返回 stdout（测试替换） */
export type PsRunner = (script: string, input: string) => string;

export const realPs: PsRunner = (script, input) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, AROOMO_DPAPI_IN: input },
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15_000,
  }).trim();

const PROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:AROOMO_DPAPI_IN); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:AROOMO_DPAPI_IN); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

export function cfSecretPath(cfg: Pick<ExecutorConfig, 'tokenFile'>): string {
  return join(dirname(cfg.tokenFile), CF_SECRET_FILE);
}

/** 保存 Secret：Windows DPAPI 加密落盘；其他系统不落盘（改用环境变量） */
export function saveCfSecret(file: string, secret: string, platform: NodeJS.Platform = process.platform, ps: PsRunner = realPs): void {
  const s = secret.trim();
  if (!s) throw new Error('Cloudflare Access 密钥是空的');
  if (platform !== 'win32') throw new Error(`只有 Windows 能存进系统凭据库；其他系统请设环境变量 ${CF_SECRET_ENV}`);
  let enc: string;
  try {
    enc = ps(PROTECT, s);
  } catch {
    throw new Error('用 Windows DPAPI 加密 Cloudflare Access 密钥失败');
  }
  if (!enc) throw new Error('用 Windows DPAPI 加密 Cloudflare Access 密钥失败');
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${enc}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

/** 读 Secret 的函数：第一次用时读（环境变量优先，其次 DPAPI 文件），之后留在这个闭包里，不挂在对象字段上 */
export function cfSecretReader(cfg: Pick<ExecutorConfig, 'tokenFile'>, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, ps: PsRunner = realPs): () => string {
  let cached: string | undefined;
  return () => {
    if (cached) return cached;
    const fromEnv = env[CF_SECRET_ENV]?.trim();
    if (fromEnv) return (cached = fromEnv);
    const file = cfSecretPath(cfg);
    if (platform !== 'win32' || !existsSync(file)) {
      throw new Error(`没有 Cloudflare Access 密钥：Windows 上运行 cf-access 命令保存，其他系统设环境变量 ${CF_SECRET_ENV}`);
    }
    let v: string;
    try {
      v = ps(UNPROTECT, readFileSync(file, 'utf8').trim());
    } catch {
      throw new Error('解不开 Cloudflare Access 密钥（换了 Windows 用户？请重新运行 cf-access 命令）');
    }
    if (!v) throw new Error('Cloudflare Access 密钥是空的');
    return (cached = v);
  };
}

/** 把 clientId 写进 config.json 的 cfAccess（其余内容原样保留） */
export function setCfClientId(configFile: string, clientId: string): void {
  const id = clientId.trim();
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(id)) throw new Error('Client ID 格式不对');
  const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  raw.cfAccess = { clientId: id };
  const tmp = `${configFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  renameSync(tmp, configFile);
}
