/**
 * 把 DriverSession（原语）+ Planner 包成任务处理器要的 BrowserSession（自然语言 act / detectBlocker）。
 * 这样换浏览器驱动（ego lite → Playwright MCP）或换规划器都不碰 tasks/。
 */

import type { Blocker, BrowserPort, BrowserSession, FillField, OpenOptions } from '../ports/browser.js';
import { DriverError, type BrowserDriver, type DriverSession } from '../ports/driver.js';
import type { ScreenshotSummary } from '../protocol.js';
import { detectBlockerInSnapshot, validatePlan, type Planner } from './planner.js';

/** 一次 act 最多规划几轮（每轮 = 快照 + 规划 + 动作） */
const MAX_ROUNDS = 6;
/** 单步（一次 act 或一次 goto / 检查 / 截图）的总时限（#382）：到点明确失败，不挂起、不当成功；整任务另有 runner 的 10 分钟看门狗 */
export const ACT_TIMEOUT_MS = 120_000;

export interface PlannedSessionOptions {
  actTimeoutMs?: number;
}

class PlannedSession implements BrowserSession {
  /** 最近一次 fill 调用带进来的字段值，供规划器的 valueKey 取用；只在内存 */
  #pending = new Map<string, string>();

  constructor(
    private readonly drv: DriverSession,
    private readonly planner: Planner,
    private readonly redact: (text: string) => string = (t) => t,
    private readonly actTimeoutMs = ACT_TIMEOUT_MS,
  ) {}

  currentUrl() {
    return this.#limit('读取页面地址', () => this.drv.url());
  }
  goto(url: string) {
    return this.#limit('打开网页', () => this.drv.goto(url));
  }

  async fill(fields: FillField[]) {
    // 处理器在 act 之前调用 fill：把值暂存，真正落到页面在 act 里按快照定位
    for (const f of fields) this.#pending.set(f.target, f.value);
  }

  /**
   * 每一步（act / detectBlocker / goto / 截图 / 关闭…）都限时：超时立刻以 ACT_TIMEOUT 失败；
   * 后台还没走完的循环在下一次驱动调用前停下（alive 检查），不再点页面。
   */
  async #limit<T>(what: string, fn: (alive: () => void) => Promise<T>): Promise<T> {
    let expired = false;
    const alive = () => {
      if (expired) throw new DriverError('ACT_TIMEOUT', '操作已超时停止');
    };
    const run = fn(alive);
    run.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        expired = true;
        rej(new DriverError('ACT_TIMEOUT', `「${what.slice(0, 20)}」超过 ${Math.round(this.actTimeoutMs / 1000)} 秒没有完成，已停止（浏览器可能卡住）`));
      }, this.actTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  act(instruction: string): Promise<string> {
    return this.#limit(instruction, (alive) => this.#actOnce(instruction, alive));
  }

  async #actOnce(instruction: string, alive: () => void): Promise<string> {
    // 询问类说明（处理器用来判断状态）：只读快照回答，不做任何点击
    if (/^(判断|如果页面)/.test(instruction)) {
      alive();
      const snap = await this.drv.snapshot();
      const onLoginForm = /textbox\s+"[^"]*(密码|password)/i.test(snap);
      if (instruction.startsWith('如果页面')) return onLoginForm ? '需要登录' : '已登录';
      return onLoginForm ? '失败：仍停在登录页' : '成功';
    }
    const done: string[] = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      alive();
      const snapshot = await this.drv.snapshot();
      const blocked = detectBlockerInSnapshot(snapshot);
      if (blocked) return `需要你处理：${blocked.note}`;
      alive();
      const steps = validatePlan(await this.planner.plan({ instruction, snapshot: this.redact(snapshot), availableFields: [...this.#pending.keys()], round, history: [...done] }));
      let acted = false;
      for (const s of steps) {
        if (s.op === 'done') return done.length ? done.join('；') : (s.note ?? '完成');
        if (s.op === 'blocked') return `需要你处理：${s.note ?? '页面需要人工操作'}`;
        if (!s.ref) continue;
        alive();
        if (s.op === 'fill') {
          const v = s.valueKey ? this.#pending.get(s.valueKey) : undefined;
          if (v === undefined) continue;
          await this.drv.fill(s.ref, v);
          done.push(`填写 ${s.valueKey}`);
          acted = true;
        } else if (s.op === 'click') {
          await this.drv.click(s.ref);
          done.push('点击');
          acted = true;
        } else if (s.op === 'press' && s.key) {
          await this.drv.press(s.ref, s.key);
          acted = true;
        }
      }
      if (!acted) break;
    }
    return done.length ? done.join('；') : '没有可执行的动作';
  }

  async detectBlocker(): Promise<Blocker | null> {
    const b = detectBlockerInSnapshot(await this.#limit('检查验证码', () => this.drv.snapshot()));
    if (!b || b.op !== 'blocked') return null;
    return { reason: b.blocker ?? 'other', message: b.note ?? '页面需要人工操作' };
  }

  screenshot(): Promise<ScreenshotSummary> {
    return this.#limit('截图', () => this.#screenshot());
  }

  async #screenshot(): Promise<ScreenshotSummary> {
    // 依次执行：驱动每次调用可能是新进程，并发会互相争抢同一个工作空间
    const url = await this.drv.url().catch(() => '');
    const info = await this.drv.screenshotInfo().catch(() => ({ width: 0, height: 0 }));
    const title = await this.drv.title().catch(() => '');
    const summary = `页面 ${url}${title ? `（${title.slice(0, 60)}）` : ''}`;
    return { summary: this.redact(summary), width: info.width, height: info.height, ...('sha256' in info && info.sha256 ? { sha256: info.sha256 } : {}) };
  }

  handOff(): Promise<boolean> {
    return this.#limit('交给你处理', () => this.drv.handOff());
  }

  async close() {
    this.#pending.clear();
    await this.#limit('关闭浏览器', () => this.drv.close());
  }
}

/** 把一个浏览器驱动 + 规划器暴露成任务要的 BrowserPort */
export class DriverBrowserPort implements BrowserPort {
  readonly name: string;
  constructor(
    private readonly driver: BrowserDriver,
    private readonly planner: Planner,
    private readonly opts: PlannedSessionOptions = {},
  ) {
    this.name = driver.name;
  }
  available() {
    return this.driver.available();
  }
  async open(opts: OpenOptions = {}): Promise<BrowserSession> {
    const label = opts.label ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    return new PlannedSession(await this.driver.open(label), this.planner, opts.redact, this.opts.actTimeoutMs);
  }
}
