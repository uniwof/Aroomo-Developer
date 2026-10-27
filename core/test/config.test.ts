import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, toSafeJSON } from '../src/config.js';

describe('loadConfig', () => {
  it('空环境使用默认值', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      timezone: 'Asia/Shanghai',
      litellmBaseUrl: 'http://litellm:4000',
    });
    expect(c.litellmMasterKey).toBeUndefined();
    expect(c.databaseUrl).toBeUndefined();
  });

  it('读取并规范化环境变量', () => {
    const c = loadConfig({
      CORE_PORT: '9090',
      CORE_LOG_LEVEL: 'DEBUG',
      CORE_TIMEZONE: 'Europe/Berlin',
      LITELLM_BASE_URL: 'http://litellm:4000/',
      LITELLM_MASTER_KEY: '  placeholder-not-a-real-key  ',
      CORE_DATABASE_URL: 'postgresql://core@postgres:5432/aroomo_core',
    });
    expect(c.port).toBe(9090);
    expect(c.logLevel).toBe('debug');
    expect(c.timezone).toBe('Europe/Berlin');
    expect(c.litellmBaseUrl).toBe('http://litellm:4000');
    expect(c.litellmMasterKey).toBe('placeholder-not-a-real-key');
  });

  it.each([
    [{ CORE_PORT: 'abc' }, 'CORE_PORT'],
    [{ CORE_PORT: '70000' }, 'CORE_PORT'],
    [{ CORE_LOG_LEVEL: 'loud' }, 'CORE_LOG_LEVEL'],
    [{ CORE_TIMEZONE: 'Mars/Base' }, 'CORE_TIMEZONE'],
    [{ LITELLM_BASE_URL: 'ftp://x' }, 'LITELLM_BASE_URL'],
    [{ LITELLM_BASE_URL: 'not a url' }, 'LITELLM_BASE_URL'],
    [{ CORE_DATABASE_URL: 'mysql://x' }, 'CORE_DATABASE_URL'],
  ])('非法值抛 ConfigError：%o', (env, key) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(key);
  });

  it('toSafeJSON 不暴露密钥', () => {
    const c = loadConfig({
      LITELLM_MASTER_KEY: 'placeholder-secret-value',
      CORE_DATABASE_URL: 'postgresql://u:placeholder-pass@postgres/db',
    });
    const s = JSON.stringify(toSafeJSON(c));
    expect(s).not.toContain('placeholder-secret-value');
    expect(s).not.toContain('placeholder-pass');
    expect(s).toContain('(set)');
  });
});

describe('loadConfig：令牌与迁移', () => {
  it('令牌过短报错；toSafeJSON 不输出令牌', () => {
    expect(() => loadConfig({ CORE_OWNER_TOKEN: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ CORE_TOKEN_SECRET: 'short' })).toThrow(ConfigError);
    const tok = 'placeholder-owner-token-0123456789abcdef';
    const c = loadConfig({ CORE_OWNER_TOKEN: tok });
    expect(c.ownerToken).toBe(tok);
    expect(JSON.stringify(toSafeJSON(c))).not.toContain(tok);
    expect(toSafeJSON(c).ownerToken).toBe('(set)');
  });

  it('CORE_AUTO_MIGRATE 默认 true，可关闭，非法值报错', () => {
    expect(loadConfig({}).autoMigrate).toBe(true);
    expect(loadConfig({ CORE_AUTO_MIGRATE: 'false' }).autoMigrate).toBe(false);
    expect(() => loadConfig({ CORE_AUTO_MIGRATE: 'maybe' })).toThrow(ConfigError);
  });
});
