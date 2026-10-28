/**
 * Aroomo Shell 配置：只从环境变量读取（Docker 版由 compose 传入；Windows 独立版由安装程序设置，D76）。
 * 密钥（CORE_OWNER_TOKEN）不进日志。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isLoopbackHost } from './autologin.js';

export type AuthMode = 'lobe-session' | 'off';

export interface ShellConfig {
  host: string;
  port: number;
  /** 官方 LobeHub 的地址（容器网络内 / 本机） */
  lobeUpstream: URL;
  /** Aroomo Core 的地址 */
  coreUpstream: URL;
  /** 转发 /aroomo/api/* 到 Core 时附加的主人令牌；未设置时 /aroomo/api 一律 503 */
  coreOwnerToken: string | undefined;
  /**
   * lobe-session（默认）：Aroomo 页面和 /aroomo/api 要求已登录 LobeHub（Better Auth 会话，经 LobeHub 校验）；
   * off：不校验（只用于测试）。
   */
  auth: AuthMode;
  /** 新访客默认语言（写 LOBE_LOCALE cookie） */
  defaultLocale: string;
  /** 静态资源目录（shell.js / shell.css / 图标 / Aroomo 页面） */
  publicDir: string;
  /** 会话校验结果缓存时长 */
  sessionCacheMs: number;
  /**
   * Windows 独立版：本机主人自动登录（D78）。只在 SHELL_HOST 是本机回环地址时允许；Docker / 服务器版不设置。
   */
  localOwner: { email: string; password: string; origin?: string } | undefined;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const str = (env: Env, k: string) => {
  const v = env[k]?.trim();
  return v ? v : undefined;
};

function url(raw: string, key: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${key} 不是合法的 URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${key} 只支持 http/https`);
  return u;
}

const defaultPublicDir = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function loadConfig(env: Env = process.env): ShellConfig {
  const portRaw = str(env, 'SHELL_PORT') ?? '3000';
  if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) throw new ConfigError('SHELL_PORT 必须是 1–65535 的整数');
  const auth = (str(env, 'SHELL_AUTH') ?? 'lobe-session') as AuthMode;
  if (auth !== 'lobe-session' && auth !== 'off') throw new ConfigError('SHELL_AUTH 只能是 lobe-session 或 off');
  const token = str(env, 'CORE_OWNER_TOKEN');
  const host = str(env, 'SHELL_HOST') ?? '0.0.0.0';
  const ownerEmail = str(env, 'SHELL_LOCAL_OWNER_EMAIL');
  const ownerPassword = str(env, 'SHELL_LOCAL_OWNER_PASSWORD');
  let localOwner: ShellConfig['localOwner'];
  if (ownerEmail || ownerPassword) {
    if (!ownerEmail || !ownerPassword) throw new ConfigError('SHELL_LOCAL_OWNER_EMAIL 和 SHELL_LOCAL_OWNER_PASSWORD 必须同时设置');
    if (!isLoopbackHost(host)) throw new ConfigError('本机主人自动登录只能在 SHELL_HOST 为 127.0.0.1 / ::1 / localhost 时开启');
    if (ownerPassword.length < 8 || ownerPassword.length > 64) throw new ConfigError('SHELL_LOCAL_OWNER_PASSWORD 长度必须是 8–64');
    const pub = str(env, 'SHELL_PUBLIC_URL');
    localOwner = { email: ownerEmail, password: ownerPassword, origin: pub ? url(pub, 'SHELL_PUBLIC_URL').origin : undefined };
  }
  return {
    host,
    port: Number(portRaw),
    lobeUpstream: url(str(env, 'LOBE_UPSTREAM') ?? 'http://lobe:3210', 'LOBE_UPSTREAM'),
    coreUpstream: url(str(env, 'CORE_UPSTREAM') ?? 'http://core:8080', 'CORE_UPSTREAM'),
    coreOwnerToken: token && token !== 'CHANGE_ME' ? token : undefined,
    auth,
    defaultLocale: str(env, 'SHELL_DEFAULT_LOCALE') ?? 'zh-CN',
    publicDir: str(env, 'SHELL_PUBLIC_DIR') ?? defaultPublicDir(),
    sessionCacheMs: 30_000,
    localOwner,
  };
}
