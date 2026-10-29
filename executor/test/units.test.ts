import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Allowlist } from '../src/allowlist.js';
import { Backoff } from '../src/backoff.js';
import { configPath, defaultConfig, defaultConfigDir, parseConfig, tokenReader } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { REDACTED, Redactor, scrubTokens } from '../src/redact.js';

describe('白名单', () => {
  const al = new Allowlist({ sites: ['example.com', '*.shop.cn'], commands: ['git'] });

  it('精确主机与子域通配', () => {
    expect(al.checkUrl('https://example.com/login').ok).toBe(true);
    expect(al.checkUrl('https://www.example.com/').ok).toBe(false);
    expect(al.checkUrl('https://a.shop.cn/').ok).toBe(true);
    expect(al.checkUrl('https://shop.cn/').ok).toBe(false);
    expect(al.checkUrl('https://evilshop.cn/').ok).toBe(false);
    expect(al.checkUrl('https://example.com.evil.io/').ok).toBe(false);
  });

  it('拒绝 http、IP、本机、带账号的网址', () => {
    expect(al.checkUrl('http://example.com/').ok).toBe(false);
    expect(al.checkUrl('https://127.0.0.1/').ok).toBe(false);
    expect(al.checkUrl('https://[::1]/').ok).toBe(false);
    expect(al.checkUrl('https://localhost/').ok).toBe(false);
    expect(al.checkUrl('https://u:p@example.com/').ok).toBe(false);
    expect(al.checkUrl('javascript:alert(1)').ok).toBe(false);
    expect(al.checkUrl('不是网址').ok).toBe(false);
  });

  it('空名单（保守默认）什么都不放行', () => {
    const empty = new Allowlist({ sites: [], commands: [] });
    expect(empty.checkUrl('https://example.com/').ok).toBe(false);
    expect(empty.checkCommand('git').ok).toBe(false);
  });

  it('命令精确匹配', () => {
    expect(al.checkCommand('git').ok).toBe(true);
    expect(al.checkCommand('git-evil').ok).toBe(false);
  });

  it('条目格式错误直接报错；指纹稳定且不含名单内容', () => {
    expect(() => new Allowlist({ sites: ['https://example.com'], commands: [] })).toThrow();
    const h1 = new Allowlist({ sites: ['b.com', 'a.com'], commands: [] }).hash();
    const h2 = new Allowlist({ sites: ['A.com', 'b.com.'], commands: [] }).hash();
    expect(h1).toBe(h2);
    expect(h1).not.toContain('a.com');
  });
});

describe('脱敏', () => {
  it('替换登记过的值，长值优先', () => {
    const r = new Redactor();
    r.add('hunter2hunter2');
    r.add('hunter2');
    expect(r.redact('pw=hunter2hunter2 x=hunter2')).toBe(`pw=${REDACTED} x=${REDACTED}`);
  });
  it('短值只做整词替换', () => {
    const r = new Redactor();
    r.add('123');
    expect(r.redact('code 123 and 41234')).toBe(`code ${REDACTED} and 41234`);
  });
  it('深度脱敏与清空', () => {
    const r = new Redactor();
    r.add('s3cr3t-value');
    expect(r.redactDeep({ a: { b: ['x s3cr3t-value'] } })).toEqual({ a: { b: [`x ${REDACTED}`] } });
    r.clear();
    expect(r.redact('s3cr3t-value')).toBe('s3cr3t-value');
  });
  it('兜底抹掉 Bearer 与常见 Key 形态', () => {
    expect(scrubTokens('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(scrubTokens('key sk-abcdefghijklmnopqrstu')).toBe(`key ${REDACTED}`);
  });
  it('日志经过脱敏', () => {
    const lines: string[] = [];
    const r = new Redactor();
    r.add('my-password-1');
    createLogger({ sink: (l) => lines.push(l) }).withRedactor(r).info('填写 my-password-1', { x: 'my-password-1' });
    expect(lines.join('')).not.toContain('my-password-1');
  });
});

describe('退避', () => {
  it('指数增长，有上限，可重置', () => {
    const b = new Backoff(1000, 8000, () => 0);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1000, 2000, 4000, 8000, 8000]);
    b.reset();
    expect(b.next()).toBe(1000);
    expect(new Backoff(1000, 8000, () => 1).next()).toBe(1300);
  });
});

describe('配置', () => {
  it('Windows 默认目录在 APPDATA 下', () => {
    expect(defaultConfigDir({ APPDATA: 'C:\\Users\\bb\\AppData\\Roaming' }, 'win32')).toContain(join('Aroomo', 'executor'));
    expect(configPath({ AROOMO_EXECUTOR_CONFIG: '/x/c.json' }, 'linux')).toBe('/x/c.json');
  });
  it('默认保守：空白名单', () => {
    const c = parseConfig({}, '/d');
    expect(c.allowlist.sites).toEqual([]);
    expect(c.allowlist.commands).toEqual([]);
    expect(c.browsers).toEqual(['ego-lite', 'playwright-mcp']);
    expect(defaultConfig('/d').tokenFile).toBe(join('/d', 'device-token'));
  });
  it('拒绝把令牌写进配置、拒绝未知适配器与坏条目', () => {
    expect(() => parseConfig({ token: 'x' }, '/d')).toThrow(/令牌/);
    expect(() => parseConfig({ browsers: ['selenium'] }, '/d')).toThrow();
    expect(() => parseConfig({ allowlist: { sites: ['http://a.com'] } }, '/d')).toThrow();
  });
  it('令牌：环境变量优先，其次文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-'));
    const cfg = parseConfig({ tokenFile: join(dir, 'device-token') }, dir);
    expect(() => tokenReader(cfg, {})()).toThrow();
    writeFileSync(cfg.tokenFile, 'file-token\n');
    expect(tokenReader(cfg, {})()).toBe('file-token');
    expect(tokenReader(cfg, { AROOMO_EXECUTOR_TOKEN: 'env-token' })()).toBe('env-token');
  });
});
