/**
 * #380（#369 负责人第 2 轮非必改）：`forAccount(` 只能在 settings/store.ts 的 scopedSettings 里调用。
 * PgSettingsStore 的账号范围由调用方声明；在别处直接 `store.forAccount(别人的 id)` 就能声明成别的账号，RLS 挡不住（docs/ops/RLS.md 局限）。
 * scopedSettings 从键名前缀换算账号，键和范围绑死。新增调用处要负责人审，并同步改本测试。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const STORE = 'settings/store.ts';
/** store.ts 里允许出现的两处声明：接口的可选方法、PgSettingsStore 的实现 */
const DECLS = [/^\s*forAccount\?\(userId: string\): SettingsStore;$/m, /^\s*forAccount\(userId: string\): SettingsStore \{$/m];

function walk(d: string): string[] {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** scopedSettings 函数体（到下一个顶层的 `}` 为止） */
function scopedBody(src: string): string {
  const start = src.indexOf('export function scopedSettings(');
  if (start < 0) return '';
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end < 0 ? undefined : end);
}

/** 返回违规处（文件:出现次数）；空数组 = 通过 */
function violations(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    let rest = text;
    if (rel === STORE) {
      const body = scopedBody(rest);
      if ((body.match(/forAccount/g) ?? []).length !== 2) bad.push(`${rel}:scopedSettings 里应正好是 store.forAccount ? store.forAccount(...) 一处`);
      rest = rest.replace(body, '');
      for (const d of DECLS) rest = rest.replace(d, '');
    }
    const n = (rest.match(/forAccount/g) ?? []).length;
    if (n > 0) bad.push(`${rel}:${n}`);
  }
  return bad;
}

const read = () => Object.fromEntries(walk(SRC).map((f) => [relative(SRC, f).replaceAll('\\', '/'), readFileSync(f, 'utf8')]));

describe('forAccount 只在 scopedSettings 里调用（#380）', () => {
  it('core/src 里没有别处调用（含 ?.()、[\'forAccount\'] 等写法）', () => {
    expect(violations(read())).toEqual([]);
  });

  it('回退自检：别处直接调用、可选链调用、scopedSettings 里换成别的写法，都要报出来', () => {
    const files = read();
    const store = files[STORE]!;
    expect(store).toBeDefined();
    expect(violations({ ...files, 'usage/x.ts': 'deps.settings.forAccount!(otherUserId).get("k")' })).toEqual(['usage/x.ts:1']);
    expect(violations({ ...files, 'work/y.ts': "s.forAccount?.(id); s['forAccount'](id)" })).toEqual(['work/y.ts:2']);
    expect(violations({ ...files, [STORE]: store + '\nexport const leak = (s: SettingsStore, id: string) => s.forAccount?.(id);\n' })).toEqual([`${STORE}:1`]);
    const noCall = store.replace('store.forAccount ? store.forAccount(settingsOwnerOf(k(\'\'))) : store', 'store');
    expect(noCall).not.toBe(store);
    expect(violations({ ...files, [STORE]: noCall })[0]).toMatch(/scopedSettings/);
  });
});
