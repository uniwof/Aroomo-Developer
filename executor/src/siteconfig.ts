/**
 * 白名单增删（给不方便编辑 JSON 的所有者用）：
 *   allow example.com / allow https://www.example.com/daily / allow "*.example.org"
 * 只改 config.json 的 allowlist.sites，其余内容原样保留。
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { normalizeSiteEntry } from './allowlist.js';

/** 接受主机名、通配主机名或完整网址，返回规范的白名单条目 */
export function siteEntryFrom(input: string): string {
  const t = input.trim();
  if (/^https?:\/\//i.test(t)) {
    const u = new URL(t);
    return normalizeSiteEntry(u.hostname);
  }
  return normalizeSiteEntry(t);
}

export function editSites(configFile: string, op: 'add' | 'remove', input: string): { changed: boolean; entry: string; sites: string[] } {
  const entry = siteEntryFrom(input);
  const raw = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>;
  const al = (raw.allowlist && typeof raw.allowlist === 'object' ? raw.allowlist : {}) as Record<string, unknown>;
  const sites = Array.isArray(al.sites) ? (al.sites as string[]).filter((x) => typeof x === 'string') : [];
  const has = sites.includes(entry);
  let next = sites;
  if (op === 'add' && !has) next = [...sites, entry];
  if (op === 'remove' && has) next = sites.filter((x) => x !== entry);
  const changed = next !== sites;
  if (changed) {
    raw.allowlist = { ...al, sites: next };
    // 先写临时文件再改名，断电也不会留下半截配置
    const tmp = `${configFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    renameSync(tmp, configFile);
  }
  return { changed, entry, sites: next };
}
