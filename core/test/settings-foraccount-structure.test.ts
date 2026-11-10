import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('结构：forAccount( 只能在 settings/store.ts 里调用（#345）', () => {
  it('core/src 其余文件不得调用 forAccount(', () => {
    const bad = walk(join(__dirname, '..', 'src'))
      .filter((f) => !f.endsWith(join('settings', 'store.ts')))
      .filter((f) => /\.forAccount\s*\(/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('store.ts 内只有 scopedSettings 调用 forAccount(', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'settings', 'store.ts'), 'utf8');
    const i = src.indexOf('export function scopedSettings');
    expect(i).toBeGreaterThan(0);
    const before = src.slice(0, i);
    expect(/\.forAccount\s*\(/.test(before)).toBe(false);
  });
});
