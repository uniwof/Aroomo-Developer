/**
 * Core 配置加载（PRODUCT §7.1：所有配置通过 .env 和 Core 的设置完成）。
 *
 * 规则：
 * - 只从环境变量读取；不读文件、不调用云厂商 SDK。
 * - 密钥类字段（LITELLM_MASTER_KEY、数据库连接串）永远不进日志：用 toSafeJSON() 输出。
 * - 时区默认 Asia/Shanghai（AUDIT P11：日期边界统一按用户时区）。
 */

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface CoreConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  timezone: string;
  /** LiteLLM 代理地址（容器网络内），例如 http://litellm:4000 */
  litellmBaseUrl: string;
  /** LiteLLM 管理密钥；只用于 Core → LiteLLM 的管理调用，绝不返回给客户端 */
  litellmMasterKey: string | undefined;
  /** Core 自己的数据库；未设置时使用内存存储（只适合开发 / 演示，重启即丢） */
  databaseUrl: string | undefined;
  /** 启动时自动执行数据库迁移（默认 true） */
  autoMigrate: boolean;
  /** 主人（P0 单用户）访问令牌；未设置时 /api/* 一律 503 */
  ownerToken: string | undefined;
  /** 操作员令牌 HMAC 用的服务端密钥；未设置时操作员令牌不可用 */
  tokenSecret: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function parsePort(raw: string | undefined, key: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${key} 必须是 1–65535 的整数`);
  const n = Number(raw);
  if (n < 1 || n > 65535) throw new ConfigError(`${key} 必须是 1–65535 的整数`);
  return n;
}

function parseUrl(raw: string, key: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${key} 不是合法的 URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConfigError(`${key} 只支持 http/https`);
  }
  return raw.replace(/\/+$/, '');
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: Env = process.env): CoreConfig {
  const logLevelRaw = (str(env, 'CORE_LOG_LEVEL') ?? 'info').toLowerCase();
  if (!LOG_LEVELS.includes(logLevelRaw as LogLevel)) {
    throw new ConfigError(`CORE_LOG_LEVEL 必须是 ${LOG_LEVELS.join('/')} 之一`);
  }

  const timezone = str(env, 'CORE_TIMEZONE') ?? 'Asia/Shanghai';
  if (!isValidTimezone(timezone)) throw new ConfigError('CORE_TIMEZONE 不是合法的 IANA 时区');

  const databaseUrl = str(env, 'CORE_DATABASE_URL');
  if (databaseUrl !== undefined && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('CORE_DATABASE_URL 必须以 postgres:// 或 postgresql:// 开头');
  }

  const ownerToken = str(env, 'CORE_OWNER_TOKEN');
  if (ownerToken !== undefined && ownerToken.length < 32) throw new ConfigError('CORE_OWNER_TOKEN 至少 32 个字符');
  const tokenSecret = str(env, 'CORE_TOKEN_SECRET');
  if (tokenSecret !== undefined && tokenSecret.length < 32) throw new ConfigError('CORE_TOKEN_SECRET 至少 32 个字符');
  const autoMigrateRaw = (str(env, 'CORE_AUTO_MIGRATE') ?? 'true').toLowerCase();
  if (!['true', 'false', '1', '0'].includes(autoMigrateRaw)) throw new ConfigError('CORE_AUTO_MIGRATE 必须是 true/false');

  return {
    host: str(env, 'CORE_HOST') ?? '0.0.0.0',
    port: parsePort(str(env, 'CORE_PORT'), 'CORE_PORT', 8080),
    logLevel: logLevelRaw as LogLevel,
    timezone,
    litellmBaseUrl: parseUrl(str(env, 'LITELLM_BASE_URL') ?? 'http://litellm:4000', 'LITELLM_BASE_URL'),
    litellmMasterKey: str(env, 'LITELLM_MASTER_KEY'),
    databaseUrl,
    autoMigrate: autoMigrateRaw === 'true' || autoMigrateRaw === '1',
    ownerToken,
    tokenSecret,
  };
}

/** 可以安全写进日志 / 健康检查的配置视图：密钥只报告「是否已设置」。 */
export function toSafeJSON(cfg: CoreConfig): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    logLevel: cfg.logLevel,
    timezone: cfg.timezone,
    litellmBaseUrl: cfg.litellmBaseUrl,
    litellmMasterKey: cfg.litellmMasterKey ? '(set)' : '(unset)',
    databaseUrl: cfg.databaseUrl ? '(set)' : '(unset)',
    autoMigrate: cfg.autoMigrate,
    ownerToken: cfg.ownerToken ? '(set)' : '(unset)',
    tokenSecret: cfg.tokenSecret ? '(set)' : '(unset)',
  };
}
