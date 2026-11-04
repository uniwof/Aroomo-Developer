/**
 * 配置：%APPDATA%\Aroomo\executor\config.json（Windows）或 ~/.config/aroomo/executor/config.json。
 * 环境变量 AROOMO_EXECUTOR_CONFIG 可指定别的路径。
 *
 * 设备令牌不写进 config.json：优先读环境变量 AROOMO_EXECUTOR_TOKEN，其次读 tokenFile
 * （默认同目录 device-token，安装说明要求只给当前 Windows 用户读权限）。任何地方都不打印令牌。
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Allowlist, normalizeSiteEntry, type AllowlistConfig } from './allowlist.js';
import type { LogLevel } from './logger.js';

export const BROWSER_ADAPTERS = ['ego-lite', 'playwright-mcp'] as const;
export type BrowserAdapterName = (typeof BROWSER_ADAPTERS)[number];

export interface ExecutorConfig {
  coreUrl: string;
  deviceName: string;
  tokenFile: string;
  allowlist: AllowlistConfig;
  /** 按顺序尝试，第一个可用的生效（主选在前） */
  browsers: BrowserAdapterName[];
  /** model：经 Core /v1 让模型规划（失败自动退回规则）；rule：只用规则，不把页面内容发给模型 */
  planner: { type: 'model' | 'rule'; model: string };
  /** 云手机 / 安卓（DroidRun）；enabled=false 时不接手机任务。device 按 Q3 选定的云手机厂商填 */
  phone: { enabled: boolean; python?: string; device?: { serial?: string; control_backend?: string; device_id?: string } };
  logLevel: LogLevel;
}

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Aroomo', 'executor');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'aroomo', 'executor');
}

export function configPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.AROOMO_EXECUTOR_CONFIG ?? join(defaultConfigDir(env, platform), 'config.json');
}

/**
 * 保守默认（Q5 未答）：白名单为空 = 不访问任何网站；不允许任何本机命令。
 * 所有者（或 Hark 远程协助）在 config.json 里加 3–5 个常用网站后才会真正干活。
 */
export function defaultConfig(dir: string): ExecutorConfig {
  return {
    coreUrl: 'https://app.pcmanai.com',
    deviceName: 'my-pc',
    tokenFile: join(dir, 'device-token'),
    allowlist: { sites: [], commands: [], apps: [] },
    browsers: ['ego-lite', 'playwright-mcp'],
    planner: { type: 'model', model: 'aroomo/auto' },
    phone: { enabled: false },
    logLevel: 'info',
  };
}

export function parseConfig(raw: unknown, dir: string): ExecutorConfig {
  const d = defaultConfig(dir);
  if (!raw || typeof raw !== 'object') throw new Error('配置文件不是 JSON 对象');
  const r = raw as Record<string, unknown>;
  const str = (k: string, def: string) => {
    const v = r[k];
    if (v === undefined) return def;
    if (typeof v !== 'string' || !v.trim()) throw new Error(`配置项 ${k} 必须是非空文字`);
    return v.trim();
  };
  const al = (r.allowlist ?? {}) as Record<string, unknown>;
  const arr = (v: unknown, name: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`配置项 ${name} 必须是文字列表`);
    return v as string[];
  };
  const sites = arr(al.sites, 'allowlist.sites');
  sites.forEach(normalizeSiteEntry); // 提前报格式错误
  const browsers = r.browsers === undefined ? d.browsers : arr(r.browsers, 'browsers');
  for (const b of browsers) if (!(BROWSER_ADAPTERS as readonly string[]).includes(b)) throw new Error(`不认识的浏览器适配器 ${b}`);
  const logLevel = str('logLevel', d.logLevel);
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error('logLevel 只能是 debug/info/warn/error');
  const coreUrl = str('coreUrl', d.coreUrl);
  new URL(coreUrl);
  if ('token' in r || 'deviceToken' in r) throw new Error('不要把令牌写进 config.json；请放在 device-token 文件或环境变量 AROOMO_EXECUTOR_TOKEN');
  const pl = (r.planner ?? {}) as Record<string, unknown>;
  const plannerType = pl.type === undefined ? d.planner.type : pl.type;
  if (plannerType !== 'model' && plannerType !== 'rule') throw new Error('planner.type 只能是 model 或 rule');
  const plannerModel = pl.model === undefined ? d.planner.model : pl.model;
  if (typeof plannerModel !== 'string' || !plannerModel.trim()) throw new Error('planner.model 必须是非空文字');
  return {
    coreUrl,
    deviceName: str('deviceName', d.deviceName),
    tokenFile: str('tokenFile', d.tokenFile),
    allowlist: { sites, commands: arr(al.commands, 'allowlist.commands'), apps: arr(al.apps, 'allowlist.apps'), allowHttp: al.allowHttp === true },
    browsers: browsers as BrowserAdapterName[],
    planner: { type: plannerType, model: plannerModel.trim() },
    phone: parsePhone(r.phone),
    logLevel: logLevel as LogLevel,
  };
}

function parsePhone(v: unknown): ExecutorConfig['phone'] {
  if (v === undefined) return { enabled: false };
  if (!v || typeof v !== 'object') throw new Error('phone 必须是对象');
  const p = v as Record<string, unknown>;
  const out: ExecutorConfig['phone'] = { enabled: p.enabled === true };
  if (p.python !== undefined) {
    if (typeof p.python !== 'string' || !p.python.trim()) throw new Error('phone.python 必须是非空文字');
    out.python = p.python.trim();
  }
  if (p.device !== undefined) {
    const d = p.device as Record<string, unknown>;
    const dev: NonNullable<ExecutorConfig['phone']['device']> = {};
    for (const k of ['serial', 'control_backend', 'device_id'] as const) {
      if (d[k] === undefined) continue;
      if (typeof d[k] !== 'string') throw new Error(`phone.device.${k} 必须是文字`);
      dev[k] = d[k] as string;
    }
    out.device = dev;
  }
  return out;
}

export function loadConfig(path = configPath()): ExecutorConfig {
  const dir = dirname(path);
  if (!existsSync(path)) throw new Error(`找不到配置文件：${path}（先运行 aroomo-executor init）`);
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), dir);
}

export function buildAllowlist(cfg: ExecutorConfig): Allowlist {
  return new Allowlist(cfg.allowlist);
}

/** 读令牌：每次调用现读，不缓存到对象字段 */
export function tokenReader(cfg: ExecutorConfig, env: NodeJS.ProcessEnv = process.env): () => string {
  return () => {
    const fromEnv = env.AROOMO_EXECUTOR_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    if (!existsSync(cfg.tokenFile)) throw new Error('没有设备令牌：请把控制台生成的执行员令牌保存到 device-token 文件');
    const v = readFileSync(cfg.tokenFile, 'utf8').trim();
    if (!v) throw new Error('device-token 文件是空的');
    return v;
  };
}
