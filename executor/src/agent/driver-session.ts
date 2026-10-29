/**
 * 把 DriverSession（原语）+ Planner 包成任务处理器要的 BrowserSession（自然语言 act / detectBlocker）。
 * 这样换浏览器驱动（ego lite → Playwright MCP）或换规划器都不碰 tasks/。
 */

import type { Blocker, BrowserPort, BrowserSession, FillField, OpenOptions } from '../ports/browser.js';
import type { BrowserDriver, DriverSession } from '../ports/driver.js';
import type { ScreenshotSummary } from '../protocol.js';
import { detectBlockerInSnapshot, validatePlan, type Planner } from './planner.js';

const MAX_ROUNDS = 6;

class PlannedSession implements BrowserSession {
  /** 最近一次 fill 调用带进来的字段值，供规划器的 valueKey 取用；只在内存 */
  #pending = new Map<string, string>();

  constructor(
    private readonly drv: DriverSession,
    private readonly planner: Planner,
    private readonly redact: (text: string) => string = (t) => t,
  ) {}

  currentUrl() {
    return this.drv.url();
  }
  goto(url: string) {
    return this.drv.goto(url);
  }

  async fill(fields: FillField[]) {
    // 处理器在 act 之前调用 fill：把值暂存，真正落到页面在 act 里按快照定位
    for (const f of fields) this.#pending.set(f.target, f.value);
  }

  async act(instruction: string): Promise<string> {
    // 询问类说明（处理器用来判断状态）：只读快照回答，不做任何点击
    if (/^(判断|如果页面)/.test(instruction)) {
      const snap = await this.drv.snapshot();
      const onLoginForm = /textbox\s+"[^"]*(密码|password)/i.test(snap);
      if (instruction.startsWith('如果页面')) return onLoginForm ? '需要登录' : '已登录';
      return onLoginForm ? '失败：仍停在登录页' : '成功';
    }
    const done: string[] = [];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const snapshot = await this.drv.snapshot();
      const blocked = detectBlockerInSnapshot(snapshot);
      if (blocked) return `需要你处理：${blocked.note}`;
      const steps = validatePlan(await this.planner.plan({ instruction, snapshot: this.redact(snapshot), availableFields: [...this.#pending.keys()], round }));
      let acted = false;
      for (const s of steps) {
        if (s.op === 'done') return done.length ? done.join('；') : (s.note ?? '完成');
        if (s.op === 'blocked') return `需要你处理：${s.note ?? '页面需要人工操作'}`;
        if (!s.ref) continue;
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
    const b = detectBlockerInSnapshot(await this.drv.snapshot());
    if (!b || b.op !== 'blocked') return null;
    return { reason: b.blocker ?? 'other', message: b.note ?? '页面需要人工操作' };
  }

  async screenshot(): Promise<ScreenshotSummary> {
    const [url, info] = await Promise.all([this.drv.url().catch(() => ''), this.drv.screenshotInfo().catch(() => ({ width: 0, height: 0 }))]);
    const title = await this.drv.title().catch(() => '');
    const summary = `页面 ${url}${title ? `（${title.slice(0, 60)}）` : ''}`;
    return { summary: this.redact(summary), width: info.width, height: info.height, ...('sha256' in info && info.sha256 ? { sha256: info.sha256 } : {}) };
  }

  async close() {
    this.#pending.clear();
    await this.drv.close();
  }
}

/** 把一个浏览器驱动 + 规划器暴露成任务要的 BrowserPort */
export class DriverBrowserPort implements BrowserPort {
  readonly name: string;
  constructor(
    private readonly driver: BrowserDriver,
    private readonly planner: Planner,
  ) {
    this.name = driver.name;
  }
  available() {
    return this.driver.available();
  }
  async open(opts: OpenOptions = {}): Promise<BrowserSession> {
    const label = opts.label ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    return new PlannedSession(await this.driver.open(label), this.planner, opts.redact);
  }
}
