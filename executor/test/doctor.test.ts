import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../src/config.js';
import { renderDoctor, runDoctor, type DoctorProbes } from '../src/doctor.js';

function setup(token: string | null, sites: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'doc-'));
  const cfg = defaultConfig(dir);
  cfg.allowlist.sites = sites;
  if (token) writeFileSync(cfg.tokenFile, token);
  return cfg;
}
const okProbes = (over: Partial<DoctorProbes> = {}): DoctorProbes => ({
  nodeVersion: '22.4.0',
  coreHealth: async () => ({ ok: true, status: 200 }),
  ego: async () => ({ code: 0, stdout: '' }),
  npxOk: async () => true,
  ...over,
});

describe('doctor', () => {
  it('全部正常 → 退出码 0', async () => {
    const [text, code] = renderDoctor(await runDoctor(setup('dev-secret-token', ['example.com']), okProbes()));
    expect(code).toBe(0);
    expect(text).toContain('可以开始干活');
    expect(text).not.toContain('dev-secret-token');
  });

  it('缺令牌、Node 太旧、Core 连不上、ego 缺失 → 逐项给下一步', async () => {
    const probes = okProbes({
      nodeVersion: '20.1.0',
      coreHealth: async () => ({ ok: false }),
      ego: async () => {
        throw new Error('ENOENT');
      },
    });
    const [text, code] = renderDoctor(await runDoctor(setup(null, ['example.com']), probes));
    expect(code).toBe(2);
    expect(text).toContain('有问题：Node 版本 20.1.0');
    expect(text).toContain('有问题：设备令牌');
    expect(text).toContain('有问题：Core 连通');
    expect(text).toContain('提醒：ego lite 浏览器'); // 还有备用浏览器，只算提醒
  });

  it('空白名单只是提醒，不影响退出码', async () => {
    const [text, code] = renderDoctor(await runDoctor(setup('t', []), okProbes()));
    expect(code).toBe(0);
    expect(text).toContain('提醒：白名单网站 0 个');
  });
});
