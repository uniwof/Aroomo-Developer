/**
 * Aroomo Shell 配置：只从环境变量读取（Docker 版由 compose 传入；Windows 独立版由安装程序设置，D76）。
 * 密钥（CORE_OWNER_TOKEN）不进日志。
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { isLoopbackHost } from './autologin.js';
import type { AccessJwtConfig } from './executor-gate.js';

export type AuthMode = 'core-session' | 'lobe-session' | 'off';

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
   * core-session（服务器版 compose 默认）：Aroomo 页面和 /aroomo/api 要求已登录 Aroomo Core 账号（aroomo_session Cookie，经 Core /api/auth/me 校验）；
   * lobe-session（代码默认，只留给冻结的 Windows 独立版和回退）：要求已登录 LobeHub；
   * off：不校验（只用于测试）。
   */
  auth: AuthMode;
  /** 新访客默认语言（写 LOBE_LOCALE cookie） */
  defaultLocale: string;
  /** 静态资源目录（图标 / Aroomo 页面） */
  publicDir: string;
  /** 控制台（web/console/dist）目录；不存在时 /console 返回 404 提示 */
  consoleDir: string;
  /**
   * 所有者的 LobeHub 用户 id（SHELL_OWNER_USER_ID，#245）：只有这个用户登录才附加所有者令牌；其他人 403。
   * 服务器版生产必填；获取方法：所有者登录后访问 /api/auth/get-session，看 user.id。未设置时一律 403（独立版见 localOwner）。
   */
  ownerUserId: string | undefined;
  /**
   * core-session：所有者的 Core 账号邮箱（SHELL_OWNER_EMAIL，小写）。只有这个邮箱、且 role=admin 的账号能用控制台和 /aroomo/api；
   * 未设置时一律 403（默认拒绝，同 #245）。lobe-session 不用它。
   */
  ownerEmail: string | undefined;
  /** 会话校验结果缓存时长 */
  sessionCacheMs: number;
  /**
   * Windows 独立版：本机主人自动登录（D78）。只在 SHELL_HOST 是本机回环地址时允许；Docker / 服务器版不设置。
   */
  localOwner: { email: string; password: string; origin?: string } | undefined;
  /**
   * 允许的 Host 头（小写主机名，不含端口）。独立版开了本机自动登录时默认只认 localhost / 127.0.0.1（D80-2：防 DNS 重绑定冒充本机）；
   * 服务器版不限制（undefined）。可用 SHELL_ALLOWED_HOSTS（逗号分隔）覆盖。
   */
  allowedHosts: string[] | undefined;
  /**
   * 真实来源 IP 从哪个头取（SHELL_CLIENT_IP_HEADER：cf-connecting-ip 或 x-real-ip）。只在直连方是本机 / 容器网络（私有地址）时才信，
   * 公网直连来的请求一律用直连地址。转给 Core 登录 / MCP 做限速用（#259 负责人必改 2）。未设置 = 只用直连地址。
   */
  clientIpHeader: 'cf-connecting-ip' | 'x-real-ip' | undefined;
  /**
   * 执行员公网通路（#365 方向 1a）：/api/executor/* 直通 Core 前，Shell 自己校验 Cloudflare Access JWT。
   * SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN / _AUD / _CLIENT_ID 三项都设才开；都不设 = 这条路径整条关闭（404）；只设一部分 = 拒绝启动。
   */
  executorAccess: AccessJwtConfig | undefined;
  /** 执行员通路鉴权前按 IP 限速：每分钟最多几次（SHELL_EXECUTOR_RATE_PER_MIN，默认 120） */
  executorRatePerMin: number;
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
  if (auth !== 'core-session' && auth !== 'lobe-session' && auth !== 'off') throw new ConfigError('SHELL_AUTH 只能是 core-session、lobe-session 或 off');
  // #245：auth=off 只用于测试；生产环境开着它等于谁都能拿所有者令牌，直接拒绝启动
  if (auth === 'off' && str(env, 'NODE_ENV') === 'production') throw new ConfigError('生产环境不允许 SHELL_AUTH=off');
  const token = str(env, 'CORE_OWNER_TOKEN');
  const host = str(env, 'SHELL_HOST') ?? '0.0.0.0';
  const ownerEmail = str(env, 'SHELL_LOCAL_OWNER_EMAIL');
  const ownerPassword = str(env, 'SHELL_LOCAL_OWNER_PASSWORD');
  let localOwner: ShellConfig['localOwner'];
  if (ownerEmail || ownerPassword) {
    // LobeHub 自动登录只属于旧的 lobe-session（Windows 独立版）；Core 账号模式下不允许，免得误以为还在生效
    if (auth === 'core-session') throw new ConfigError('SHELL_AUTH=core-session 不支持本机主人自动登录（SHELL_LOCAL_OWNER_*），请去掉这两项');
    if (!ownerEmail || !ownerPassword) throw new ConfigError('SHELL_LOCAL_OWNER_EMAIL 和 SHELL_LOCAL_OWNER_PASSWORD 必须同时设置');
    if (!isLoopbackHost(host)) throw new ConfigError('本机主人自动登录只能在 SHELL_HOST 为 127.0.0.1 / ::1 / localhost 时开启');
    if (ownerPassword.length < 8 || ownerPassword.length > 64) throw new ConfigError('SHELL_LOCAL_OWNER_PASSWORD 长度必须是 8–64');
    const pub = str(env, 'SHELL_PUBLIC_URL');
    localOwner = { email: ownerEmail, password: ownerPassword, origin: pub ? url(pub, 'SHELL_PUBLIC_URL').origin : undefined };
  }
  const hostsRaw = str(env, 'SHELL_ALLOWED_HOSTS');
  const allowedHosts = hostsRaw
    ? hostsRaw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    : localOwner
      ? ['localhost', '127.0.0.1']
      : undefined;
  const ipHeader = str(env, 'SHELL_CLIENT_IP_HEADER')?.toLowerCase();
  if (ipHeader !== undefined && ipHeader !== 'cf-connecting-ip' && ipHeader !== 'x-real-ip') {
    throw new ConfigError('SHELL_CLIENT_IP_HEADER 只能是 cf-connecting-ip 或 x-real-ip');
  }
  const exTeam = str(env, 'SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN')?.toLowerCase();
  const exAud = str(env, 'SHELL_EXECUTOR_ACCESS_AUD');
  const exClient = str(env, 'SHELL_EXECUTOR_ACCESS_CLIENT_ID');
  let executorAccess: AccessJwtConfig | undefined;
  if (exTeam || exAud || exClient) {
    if (!exTeam || !exAud || !exClient) {
      throw new ConfigError('SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN、SHELL_EXECUTOR_ACCESS_AUD、SHELL_EXECUTOR_ACCESS_CLIENT_ID 必须同时设置（或都不设，关闭执行员通路）');
    }
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(exTeam)) throw new ConfigError('SHELL_EXECUTOR_ACCESS_TEAM_DOMAIN 只写域名，如 example.cloudflareaccess.com');
    executorAccess = { teamDomain: exTeam, aud: exAud, clientId: exClient };
  }
  const rateRaw = str(env, 'SHELL_EXECUTOR_RATE_PER_MIN') ?? '120';
  if (!/^\d+$/.test(rateRaw) || Number(rateRaw) < 1 || Number(rateRaw) > 6000) throw new ConfigError('SHELL_EXECUTOR_RATE_PER_MIN 必须是 1–6000 的整数');
  return {
    host,
    port: Number(portRaw),
    lobeUpstream: url(str(env, 'LOBE_UPSTREAM') ?? 'http://lobe:3210', 'LOBE_UPSTREAM'),
    coreUpstream: url(str(env, 'CORE_UPSTREAM') ?? 'http://core:8080', 'CORE_UPSTREAM'),
    coreOwnerToken: token && token !== 'CHANGE_ME' ? token : undefined,
    auth,
    defaultLocale: str(env, 'SHELL_DEFAULT_LOCALE') ?? 'zh-CN',
    publicDir: str(env, 'SHELL_PUBLIC_DIR') ?? defaultPublicDir(),
    consoleDir: str(env, 'SHELL_CONSOLE_DIR') ?? '/app/console',
    ownerUserId: str(env, 'SHELL_OWNER_USER_ID'),
    ownerEmail: str(env, 'SHELL_OWNER_EMAIL')?.toLowerCase(),
    sessionCacheMs: 30_000,
    localOwner,
    allowedHosts,
    clientIpHeader: ipHeader,
    executorAccess,
    executorRatePerMin: Number(rateRaw),
  };
}
