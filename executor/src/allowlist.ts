/**
 * 本机白名单（D62）：执行员只访问允许的站点、只运行允许的命令。
 *
 * 规则：
 * - 站点条目写主机名：`example.com` 只匹配 example.com 本身；`*.example.com` 匹配所有子域（不含 example.com 本身）。
 * - 只允许 https（`allowHttp` 打开后才允许 http，仅用于本机测试）。
 * - 不允许 IP 直连、localhost、带用户名密码的 URL（防止被引去访问内网）。
 * - 默认值保守：空名单 = 什么站都不访问（Q5 未答前，所有者在配置里自己加 3–5 个常用站）。
 */

import { createHash } from 'node:crypto';

export interface AllowlistConfig {
  sites: string[];
  commands: string[];
  allowHttp?: boolean;
}

export type AllowDecision = { ok: true; host: string } | { ok: false; reason: string };

const HOST_RE = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

export function normalizeSiteEntry(entry: string): string {
  const e = entry.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(e)) throw new Error(`白名单条目格式不对：${entry}（写主机名，如 example.com 或 *.example.com）`);
  return e;
}

function isIpLike(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

export class Allowlist {
  readonly #sites: string[];
  readonly #commands: Set<string>;
  readonly #allowHttp: boolean;

  constructor(cfg: AllowlistConfig) {
    this.#sites = [...new Set(cfg.sites.map(normalizeSiteEntry))].sort();
    this.#commands = new Set(cfg.commands.map((c) => c.trim()).filter(Boolean));
    this.#allowHttp = cfg.allowHttp === true;
  }

  get siteCount(): number {
    return this.#sites.length;
  }

  /** 名单指纹：hello 时上报，控制台可对比「服务器端名单」与「本机名单」是否一致；不泄露名单内容 */
  hash(): string {
    const h = createHash('sha256');
    h.update(JSON.stringify({ s: this.#sites, c: [...this.#commands].sort() }));
    return h.digest('hex').slice(0, 16);
  }

  checkUrl(raw: string): AllowDecision {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: '网址格式不对' };
    }
    if (u.protocol !== 'https:' && !(this.#allowHttp && u.protocol === 'http:')) return { ok: false, reason: `不允许的协议 ${u.protocol}` };
    if (u.username || u.password) return { ok: false, reason: '网址里不能带用户名或密码' };
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (isIpLike(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
      return { ok: false, reason: '不允许访问 IP、本机或局域网地址' };
    }
    for (const s of this.#sites) {
      if (s.startsWith('*.')) {
        const base = s.slice(2);
        if (host.endsWith(`.${base}`)) return { ok: true, host };
      } else if (host === s) {
        return { ok: true, host };
      }
    }
    return { ok: false, reason: `${host} 不在白名单里` };
  }

  /** 命令白名单按「完整命令名」精确匹配（不做前缀匹配，避免 `git` 放行 `git-evil`） */
  checkCommand(name: string): AllowDecision {
    const n = name.trim();
    return this.#commands.has(n) ? { ok: true, host: n } : { ok: false, reason: `命令 ${n} 不在白名单里` };
  }
}
