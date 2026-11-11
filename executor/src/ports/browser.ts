/**
 * 浏览器端口（D192 可替换原则）：任务处理器只依赖这个接口。
 * 主选 ego lite（所有者本机，登录状态留在本机），备选 Playwright MCP；测试用 FakeBrowser。
 * 每个实现都必须通过 test/browser-contract.ts 的合同测试。
 */

import type { ScreenshotSummary, TakeoverReason } from '../protocol.js';

/** 页面上需要所有者亲自处理的障碍 */
export interface Blocker {
  reason: Extract<TakeoverReason, 'captcha' | '2fa' | 'payment' | 'other'>;
  message: string;
}

export interface FillField {
  /** 字段的人类可读描述或选择器，由适配器解释（ego lite 走自然语言，Playwright 走无障碍名称） */
  target: string;
  /** 只在内存里；适配器不得记录、不得写盘 */
  value: string;
  sensitive: boolean;
}

export interface BrowserSession {
  /** 当前页面 URL（导航后执行员会再做一次白名单校验） */
  currentUrl(): Promise<string>;
  goto(url: string): Promise<void>;
  fill(fields: FillField[]): Promise<void>;
  /** 自然语言动作，如「点击签到按钮」；返回适配器对结果的简短描述 */
  act(instruction: string): Promise<string>;
  /** 检测验证码 / 两步验证 / 付款页；没有障碍返回 null */
  detectBlocker(): Promise<Blocker | null>;
  screenshot(): Promise<ScreenshotSummary>;
  /** 把窗口交给所有者处理（ego lite 的 handOff）；不支持的实现可不提供，返回 false 表示所有者直接在已开的窗口里处理 */
  handOff?(): Promise<boolean>;
  close(): Promise<void>;
}

export interface OpenOptions {
  /** 工作空间标签（通常是任务 id） */
  label?: string;
  /** 页面文字离开本机（给规划模型）前的脱敏函数 */
  redact?: (text: string) => string;
}

export interface BrowserPort {
  /** 适配器名：ego-lite / playwright-mcp / fake */
  readonly name: string;
  /** 本机是否可用（ego lite 已安装、Playwright 可启动等）；不可用时执行员切换到备选 */
  available(): Promise<boolean>;
  /** 开一个隔离的工作空间（ego lite 的独立 Space；不碰所有者自己的标签页） */
  open(opts?: OpenOptions): Promise<BrowserSession>;
}

/** 探活 / 打开的默认时限（#382）：超时一律当不可用，不让一个卡住的可选适配器拖住整个任务 */
export const PROBE_TIMEOUT_MS = 30_000;
export const OPEN_TIMEOUT_MS = 60_000;

/** 在 ms 内没结果就以 TIMEOUT 失败；定时器不挡进程退出 */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** 探活：只有在时限内明确返回 true 才算可用；抛错、超时、返回非 true 都算不可用 */
export async function probe(port: BrowserPort, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  try {
    return (await within(port.available(), timeoutMs, `${port.name} 探活`)) === true;
  } catch {
    return false;
  }
}

/** 按顺序选第一个可用的适配器（主选在前） */
export async function pickBrowser(ports: BrowserPort[], timeoutMs = PROBE_TIMEOUT_MS): Promise<BrowserPort | null> {
  for (const p of ports) if (await probe(p, timeoutMs)) return p;
  return null;
}

/**
 * 按顺序找第一个「探活通过且能在时限内打开会话」的适配器（#382）：
 * 主选（如 ego lite）报可用但打开卡住 / 出错时，降级到下一个（如 playwright-mcp）。
 * 超时后才打开成功的会话会被立即关掉，不留后台窗口。
 */
export async function openBrowser(
  ports: BrowserPort[],
  opts: OpenOptions = {},
  t: { probeMs?: number; openMs?: number } = {},
): Promise<{ port: BrowserPort; session: BrowserSession } | null> {
  for (const port of ports) {
    if (!(await probe(port, t.probeMs))) continue;
    const opening = port.open(opts);
    try {
      return { port, session: await within(opening, t.openMs ?? OPEN_TIMEOUT_MS, `${port.name} 打开`) };
    } catch {
      opening.then((s) => s.close().catch(() => undefined)).catch(() => undefined);
    }
  }
  return null;
}
