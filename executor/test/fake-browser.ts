/**
 * 假浏览器：给任务处理器和合同测试用。可脚本化：某些动作后出现验证码、跳到别的站等。
 */

import type { Blocker, BrowserPort, BrowserSession, FillField } from '../src/ports/browser.js';
import type { ScreenshotSummary } from '../src/protocol.js';

export interface FakeScript {
  /** 依次返回的障碍（每次 detectBlocker 取一个；取完为 null） */
  blockers?: (Blocker | null)[];
  /** act 的返回值（按包含的关键字匹配），默认「好的」 */
  actReplies?: Record<string, string>;
  /** goto 之后实际落在的 URL（模拟跳转） */
  redirectTo?: string;
  /** act 指令包含这个关键字时一直不返回（模拟浏览器卡死），直到会话被关闭 */
  hangOn?: string;
}

export class FakeSession implements BrowserSession {
  url = 'about:blank';
  filled: FillField[] = [];
  actions: string[] = [];
  closed = false;
  handOffs = 0;
  #blockers: (Blocker | null)[];
  #onClose: (() => void)[] = [];

  constructor(private readonly script: FakeScript) {
    this.#blockers = [...(script.blockers ?? [])];
  }

  async currentUrl() {
    return this.url;
  }
  async goto(url: string) {
    this.url = this.script.redirectTo ?? url;
  }
  async fill(fields: FillField[]) {
    this.filled.push(...fields);
  }
  async act(instruction: string) {
    this.actions.push(instruction);
    if (this.script.hangOn && instruction.includes(this.script.hangOn)) {
      await new Promise<void>((resolve) => {
        this.#onClose.push(resolve);
      });
      throw new Error('会话已关闭');
    }
    for (const [k, v] of Object.entries(this.script.actReplies ?? {})) if (instruction.includes(k)) return v;
    return '好的';
  }
  async detectBlocker() {
    return this.#blockers.length ? (this.#blockers.shift() ?? null) : null;
  }
  async screenshot(): Promise<ScreenshotSummary> {
    return { summary: `页面 ${this.url}`, width: 1280, height: 800 };
  }
  async handOff() {
    this.handOffs++;
    return true;
  }
  async close() {
    this.closed = true;
    for (const f of this.#onClose.splice(0)) f();
  }
}

export class FakeBrowser implements BrowserPort {
  sessions: FakeSession[] = [];
  constructor(
    readonly name = 'fake',
    private readonly script: FakeScript = {},
    private readonly isAvailable = true,
  ) {}
  async available() {
    return this.isAvailable;
  }
  async open() {
    const s = new FakeSession(this.script);
    this.sessions.push(s);
    return s;
  }
}
