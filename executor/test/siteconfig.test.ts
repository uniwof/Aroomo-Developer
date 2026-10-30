import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { editSites, siteEntryFrom } from '../src/siteconfig.js';

let dir: string;
let file: string;
let prev: string | undefined;
let lines: string[];
const realWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ex-site-'));
  file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({ coreUrl: 'https://core.example.test', deviceName: 'x', allowlist: { sites: ['a.example.com'], commands: [] } }));
  prev = process.env.AROOMO_EXECUTOR_CONFIG;
  process.env.AROOMO_EXECUTOR_CONFIG = file;
  lines = [];
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  if (prev === undefined) delete process.env.AROOMO_EXECUTOR_CONFIG;
  else process.env.AROOMO_EXECUTOR_CONFIG = prev;
});

describe('白名单增删', () => {
  it('网址、大小写、通配都规范成条目', () => {
    expect(siteEntryFrom('https://WWW.Example.com/daily?x=1')).toBe('www.example.com');
    expect(siteEntryFrom(' *.Example.org ')).toBe('*.example.org');
    expect(() => siteEntryFrom('http://127.0.0.1/')).toThrow();
    expect(() => siteEntryFrom('not a site')).toThrow();
  });
  it('加入、重复加入、移除；其余配置原样保留', () => {
    expect(editSites(file, 'add', 'https://b.example.com/x').changed).toBe(true);
    expect(editSites(file, 'add', 'b.example.com').changed).toBe(false);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.allowlist.sites).toEqual(['a.example.com', 'b.example.com']);
    expect(cfg.coreUrl).toBe('https://core.example.test');
    expect(cfg.allowlist.commands).toEqual([]);
    expect(editSites(file, 'remove', 'a.example.com').sites).toEqual(['b.example.com']);
    expect(editSites(file, 'remove', 'zzz.example.com').changed).toBe(false);
  });
  it('命令行 allow / sites / disallow', async () => {
    expect(await main(['allow', 'https://c.example.net/'])).toBe(0);
    expect(await main(['sites'])).toBe(0);
    expect(lines.join('')).toContain('c.example.net');
    expect(await main(['disallow', 'c.example.net'])).toBe(0);
    expect(await main(['allow', '10.0.0.1'])).toBe(1);
    expect(await main(['allow'])).toBe(64);
    expect(JSON.parse(readFileSync(file, 'utf8')).allowlist.sites).toEqual(['a.example.com']);
  });
});
