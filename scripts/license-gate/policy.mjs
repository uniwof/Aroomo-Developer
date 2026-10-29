// D179 可商用许可证闸门：判定逻辑（无第三方依赖，便于单测）。
// 规则：命中禁用 → 失败；全部在白名单 → 通过；其余（未知、自定义、GPL 等）→ 失败，需在 allow 文件逐包登记理由。

/** 允许的 SPDX 标识（可商用、无授权费、无品牌限制）。BSL-1.0 是 Boost，不是 BUSL。 */
export const ALLOWED = new Set([
  'MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'BlueOak-1.0.0', 'Python-2.0', 'PSF-2.0', 'CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0',
  'Unlicense', 'WTFPL', 'Zlib', 'BSL-1.0', 'MPL-2.0', 'Artistic-2.0', 'X11',
]);

/** 直接失败的许可证（AGPL、SSPL、BUSL、Commons Clause、非商用、品牌/社区限制）。 */
export const DENY_PATTERNS = [
  /AGPL|Affero/i,
  /SSPL|Server Side Public/i,
  /BUSL|Business Source/i,
  /Commons[\s-]*Clause/i,
  /Elastic-2\.0|Elastic License/i,
  /RSAL/i,
  /PolyForm/i,
  /Non[\s-]*Commercial|-NC\b|-NC-|\bNC\b/i,
  /LobeHub/i,
  /Confluent Community/i,
];

export function isDenied(expr) {
  return DENY_PATTERNS.some((re) => re.test(expr));
}

function normalize(id) {
  return id.trim().replace(/^\(+|\)+$/g, '').replace(/\+$/, '').trim();
}

/**
 * 判定一个许可证表达式。
 * @returns {{ok: boolean, reason: 'allowed'|'denied'|'unknown'}}
 */
export function judge(raw) {
  const expr = typeof raw === 'string' ? raw.trim() : '';
  if (!expr || /^UNLICENSED$/i.test(expr) || /^SEE LICENSE/i.test(expr)) {
    return { ok: false, reason: 'unknown' };
  }
  const flat = expr.replace(/[()]/g, ' ');
  // 有 OR：任一选项可用即可（我们按该选项使用）；全部被禁才算禁用。
  if (/\sOR\s/i.test(flat)) {
    const opts = flat.split(/\sOR\s/i).map((o) => o.trim()).filter(Boolean);
    if (opts.some((o) => judge(o).ok)) return { ok: true, reason: 'allowed' };
    if (opts.every((o) => isDenied(o))) return { ok: false, reason: 'denied' };
    return { ok: false, reason: 'unknown' };
  }
  if (isDenied(flat)) return { ok: false, reason: 'denied' };
  const parts = flat.split(/\sAND\s/i).map(normalize).filter(Boolean);
  if (parts.length > 0 && parts.every((p) => ALLOWED.has(p.replace(/\s+WITH\s+.*$/i, '')))) {
    return { ok: true, reason: 'allowed' };
  }
  return { ok: false, reason: 'unknown' };
}

/** lockfile v2/v3 的 packages 字段 → [{name, version, license}]（跳过根包和 link）。 */
export function packagesFromLock(lock) {
  const out = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key || meta.link) continue;
    const name = meta.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let license = meta.license;
    if (license && typeof license === 'object') license = license.type;
    if (Array.isArray(meta.licenses)) license = meta.licenses.map((l) => l.type ?? l).join(' OR ');
    out.push({ name, version: meta.version ?? '', license: license ?? '', dev: !!meta.dev });
  }
  return out;
}

/**
 * allow 文件里逐包登记的例外：{ "包名": { "license": "...", "reason": "..." } }。
 * 禁用许可证不能登记例外。
 */
export function evaluate(pkgs, allow = {}) {
  const failures = [];
  for (const p of pkgs) {
    const r = judge(p.license);
    if (r.ok) continue;
    const ex = allow[p.name];
    if (r.reason !== 'denied' && ex && ex.reason && (ex.license ?? '') === (p.license ?? '')) continue;
    failures.push({ ...p, reason: r.reason });
  }
  return failures;
}
