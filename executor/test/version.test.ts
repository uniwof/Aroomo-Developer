import { describe, expect, it } from 'vitest';
import { versionWithCommit } from '../src/version.js';

describe('versionWithCommit（hello 带提交，核版本不用进电脑）', () => {
  it('取到短提交就拼在版本号后面，且不超过 Core 的 32 字符上限', () => {
    const v = versionWithCommit('0.1.0', '.', () => '0254f8f\n');
    expect(v).toBe('0.1.0+0254f8f');
    expect(v.length).toBeLessThanOrEqual(32);
  });
  it('没有 git 或输出不是提交号时只回版本号，不抛错', () => {
    expect(versionWithCommit('0.1.0', '.', () => { throw new Error('no git'); })).toBe('0.1.0');
    expect(versionWithCommit('0.1.0', '.', () => 'fatal: not a git repository')).toBe('0.1.0');
  });
  it('真实仓库里能取到提交号', () => {
    expect(versionWithCommit('0.1.0')).toMatch(/^0\.1\.0(\+[0-9a-f]{7})?$/);
  });
});
