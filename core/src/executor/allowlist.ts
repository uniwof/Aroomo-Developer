/**
 * 服务器端站点白名单（docs/executor-protocol.md：Core 派任务前校验一次，执行员本机再校验）。
 * 空名单 = 不限制（本机白名单默认空，才是真正的闸门）；有名单就必须命中。
 * 条目：域名（example.com，含其子域名）或 android-app://包名（精确）。
 */
export const MAX_ALLOWLIST = 100;

export function normalizeEntry(raw: string): string | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (/^android-app:\/\/[a-z0-9._]+$/.test(s)) return s;
  let host = s;
  if (/^https?:\/\//.test(s)) {
    try {
      host = new URL(s).hostname;
    } catch {
      return null;
    }
  }
  host = host.replace(/^\*\./, "").replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host))
    return null;
  return host;
}

/** 去重、规范化；遇到不合法的条目返回 bad */
export function normalizeList(raw: unknown[]): { list: string[]; bad: string[] } {
  const list: string[] = [];
  const bad: string[] = [];
  for (const r of raw) {
    const n = normalizeEntry(String(r));
    if (n === null) bad.push(String(r).slice(0, 80));
    else if (!list.includes(n)) list.push(n);
  }
  return { list, bad };
}

export function siteAllowed(site: string, list: string[]): boolean {
  if (list.length === 0) return true;
  if (site.startsWith("android-app://")) return list.includes(site.toLowerCase());
  let host: string;
  try {
    host = new URL(site).hostname.toLowerCase();
  } catch {
    return false;
  }
  return list.some((h) => !h.startsWith("android-app://") && (host === h || host.endsWith("." + h)));
}
