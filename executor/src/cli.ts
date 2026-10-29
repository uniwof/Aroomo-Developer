#!/usr/bin/env node
/**
 * aroomo-executor 命令行
 *   init                 生成默认配置（白名单为空，保守）
 *   check                检查配置与令牌是否就绪（不打印令牌）
 *   status               检查配置、令牌，并试连 Core（不打印令牌）
 *   check-url <网址>     看某个网址是否在白名单里
 *   run                  连接 Core 并开始领取任务（Ctrl+C 退出）
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { DroidRunPhone } from './adapters/droidrun.js';
import { EgoLiteDriver } from './adapters/ego-lite.js';
import { PlaywrightMcpDriver } from './adapters/playwright-mcp.js';
import { DriverBrowserPort } from './agent/driver-session.js';
import { ModelPlanner } from './agent/model-planner.js';
import { RuleBasedPlanner, type Planner } from './agent/planner.js';
import { buildAllowlist, configPath, type ExecutorConfig, defaultConfig, loadConfig, tokenReader } from './config.js';
import { createLogger } from './logger.js';
import type { BrowserPort } from './ports/browser.js';
import { Runner } from './runner.js';
import { HttpTransport } from './transport.js';

export const VERSION = '0.1.0';

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}

/** 按配置顺序组装浏览器适配器（主选在前，不可用时自动用下一个） */
function browserPorts(cfg: ExecutorConfig, configDir: string): BrowserPort[] {
  const names = cfg.browsers;
  const planner: Planner =
    cfg.planner.type === 'model' ? new ModelPlanner({ baseUrl: cfg.coreUrl, getToken: tokenReader(cfg), model: cfg.planner.model }) : new RuleBasedPlanner();
  const ports: BrowserPort[] = [];
  for (const n of names) {
    if (n === 'ego-lite') ports.push(new DriverBrowserPort(new EgoLiteDriver(), planner));
    if (n === 'playwright-mcp') ports.push(new DriverBrowserPort(new PlaywrightMcpDriver({ profileDir: join(configDir, 'pw-profile') }), planner));
  }
  return ports;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  const path = configPath();
  switch (cmd) {
    case 'init': {
      if (existsSync(path)) {
        out(`配置已存在：${path}`);
        return 0;
      }
      mkdirSync(dirname(path), { recursive: true });
      const cfg = defaultConfig(dirname(path));
      cfg.deviceName = hostname();
      writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      out(`已生成配置：${path}`);
      out('下一步：1）在 allowlist.sites 里加上允许操作的网站；2）把控制台生成的执行员令牌保存到 device-token 文件。');
      return 0;
    }
    case 'check': {
      const cfg = loadConfig(path);
      const al = buildAllowlist(cfg);
      let tokenOk = false;
      try {
        tokenOk = tokenReader(cfg)().length > 0;
      } catch {
        tokenOk = false;
      }
      out(`配置：${path}`);
      out(`Core：${cfg.coreUrl}`);
      out(`白名单网站：${al.siteCount} 个${al.siteCount === 0 ? '（空：不会访问任何网站）' : ''}`);
      out(`设备令牌：${tokenOk ? '已就绪' : '缺少'}`);
      out(`浏览器适配器顺序：${cfg.browsers.join(' → ')}`);
      return tokenOk ? 0 : 2;
    }
    case 'status': {
      const cfg = loadConfig(path);
      let tokenOk = false;
      try {
        tokenOk = tokenReader(cfg)().length > 0;
      } catch {
        tokenOk = false;
      }
      out(`版本：${VERSION}`);
      out(`Core：${cfg.coreUrl}`);
      out(`设备令牌：${tokenOk ? '已就绪' : '缺少'}`);
      out(`白名单网站：${buildAllowlist(cfg).siteCount} 个`);
      let reach = false;
      try {
        const r = await fetch(new URL('/health', cfg.coreUrl), { signal: AbortSignal.timeout(5000) });
        reach = r.ok;
        out(`Core 连通：${r.ok ? '正常' : `异常（HTTP ${r.status}）`}`);
      } catch {
        out('Core 连通：无法连接');
      }
      return tokenOk && reach ? 0 : 2;
    }
    case 'check-url': {
      if (!arg) {
        out('用法：aroomo-executor check-url <网址>');
        return 64;
      }
      const d = buildAllowlist(loadConfig(path)).checkUrl(arg);
      out(d.ok ? `允许：${d.host}` : `不允许：${d.reason}`);
      return d.ok ? 0 : 1;
    }
    case 'run': {
      const cfg = loadConfig(path);
      const logger = createLogger({ level: cfg.logLevel });
      const transport = new HttpTransport({ baseUrl: cfg.coreUrl, getToken: tokenReader(cfg), version: VERSION });
      const browsers = browserPorts(cfg, dirname(path));
      if (browsers.length === 0) logger.warn('还没有可用的浏览器适配器，领到的网页任务会失败并回报原因');
      const phones = cfg.phone.enabled
        ? [new DroidRunPhone({ coreUrl: cfg.coreUrl, getToken: tokenReader(cfg), model: cfg.planner.model, ...(cfg.phone.python ? { python: cfg.phone.python } : {}), ...(cfg.phone.device ? { device: cfg.phone.device } : {}) })]
        : [];
      const runner = new Runner({
        transport,
        allowlist: buildAllowlist(cfg),
        browsers,
        phones,
        logger,
        deviceName: cfg.deviceName,
        platform: `${process.platform}-${process.arch}`,
        version: VERSION,
      });
      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await runner.run(ac.signal);
      return 0;
    }
    default:
      out('用法：aroomo-executor <init|check|status|check-url <网址>|run>');
      return cmd ? 64 : 0;
  }
}

const isMain = process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`出错：${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
