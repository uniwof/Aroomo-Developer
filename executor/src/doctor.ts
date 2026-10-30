/**
 * doctor：一条命令排查“为什么没在干活”。逐项给出 正常/有问题 和一句下一步，纯文字，读屏软件友好。
 * 探测函数可替换（测试用）；不打印令牌，不发起任何网页任务。
 */

import { spawnEgoExec, type EgoExec } from './adapters/ego-lite.js';
import { buildAllowlist, type ExecutorConfig, tokenReader } from './config.js';

export interface DoctorItem {
  name: string;
  ok: boolean;
  /** 有问题时的下一步；正常时可为空 */
  hint: string;
  /** 只是提醒，不算失败 */
  warn?: boolean;
}

export interface DoctorProbes {
  nodeVersion: string;
  coreHealth(url: string): Promise<{ ok: boolean; status?: number }>;
  ego: EgoExec;
  npxOk(): Promise<boolean>;
}

export function realProbes(): DoctorProbes {
  return {
    nodeVersion: process.versions.node,
    coreHealth: async (url) => {
      try {
        const r = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5000) });
        return { ok: r.ok, status: r.status };
      } catch {
        return { ok: false };
      }
    },
    ego: spawnEgoExec(),
    npxOk: () =>
      import('node:child_process').then(
        ({ spawn }) =>
          new Promise<boolean>((resolve) => {
            const c = spawn('npx', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
            const t = setTimeout(() => {
              c.kill();
              resolve(false);
            }, 15000);
            c.on('error', () => {
              clearTimeout(t);
              resolve(false);
            });
            c.on('close', (code) => {
              clearTimeout(t);
              resolve(code === 0);
            });
          }),
      ),
  };
}

export async function runDoctor(cfg: ExecutorConfig, p: DoctorProbes): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const major = Number(p.nodeVersion.split('.')[0]);
  items.push({ name: `Node 版本 ${p.nodeVersion}`, ok: major >= 22, hint: '需要 Node 22 或更新，请重新运行安装脚本' });

  let tokenOk = false;
  try {
    tokenOk = tokenReader(cfg)().length > 0;
  } catch {
    tokenOk = false;
  }
  items.push({ name: '设备令牌', ok: tokenOk, hint: '到控制台「本机执行员」生成令牌，保存到 device-token 文件' });

  const sites = buildAllowlist(cfg).siteCount;
  items.push({ name: `白名单网站 ${sites} 个`, ok: sites > 0, warn: true, hint: '名单是空的，不会访问任何网站；用 allow <网站> 加入' });

  const core = await p.coreHealth(cfg.coreUrl);
  items.push({ name: 'Core 连通', ok: core.ok, hint: core.status ? `Core 返回 HTTP ${core.status}，稍后再试` : '连不上 Core，检查网络和 coreUrl' });

  if (cfg.browsers.includes('ego-lite')) {
    let ok = false;
    try {
      const r = await p.ego('1;', 15000);
      ok = r.code === 0;
    } catch {
      ok = false;
    }
    items.push({ name: 'ego lite 浏览器', ok, warn: cfg.browsers.length > 1, hint: '没找到 ego-browser，请先安装并打开 ego lite；也可改用 playwright-mcp' });
  }
  if (cfg.browsers.includes('playwright-mcp')) {
    items.push({ name: 'Playwright 备用浏览器（npx）', ok: await p.npxOk(), warn: cfg.browsers.length > 1, hint: '找不到 npx，请确认 Node 已装好' });
  }
  return items;
}

/** 渲染成逐行文字；返回 [文字, 退出码]（有“有问题”的非提醒项则为 2） */
export function renderDoctor(items: DoctorItem[]): [string, number] {
  const lines = items.map((i) => (i.ok ? `正常：${i.name}` : `${i.warn ? '提醒' : '有问题'}：${i.name}。${i.hint}`));
  const bad = items.filter((i) => !i.ok && !i.warn).length;
  lines.push(bad === 0 ? '检查完毕：可以开始干活。' : `检查完毕：有 ${bad} 项要处理，处理后再运行 doctor。`);
  return [lines.join('\n'), bad === 0 ? 0 : 2];
}
