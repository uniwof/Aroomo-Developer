/**
 * Playwright MCP 驱动（备选，D173/D192）：在所有者电脑上用 @playwright/mcp（微软，Apache-2.0）驱动本机 Chrome。
 *
 * - 默认 `npx -y @playwright/mcp@<固定版本> --browser chrome --user-data-dir <配置目录>/pw-profile`：
 *   独立的持久配置目录（登录状态留在本机，不碰所有者日常 Chrome 配置；同一目录同时只能一个实例）。
 * - 有界面运行，遇验证码时所有者可直接在那个窗口里处理（handOff 返回 false，走接管卡）。
 * - 填写的值经 stdin JSON 传给 MCP 服务，不进命令行；服务响应会回显代码（含值），一律不记录。
 */

import { join } from 'node:path';
import { assertRef, DriverError, type BrowserDriver, type DriverSession } from '../ports/driver.js';
import { resultText, StdioMcpClient, type McpClient } from './mcp-stdio.js';

export const PLAYWRIGHT_MCP_VERSION = '0.0.83';

export interface PlaywrightMcpOptions {
  /** 启动 MCP 客户端；测试里换成假的 */
  connect?: () => Promise<McpClient>;
  command?: string;
  args?: string[];
  /** 默认参数里的 --user-data-dir */
  profileDir?: string;
  /** 探测是否可用（默认看 npx 能否启动）；测试里可替换 */
  probe?: () => Promise<boolean>;
}

export function defaultPlaywrightArgs(profileDir: string): string[] {
  return ['-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--browser', 'chrome', '--user-data-dir', profileDir];
}

/** 从 Playwright MCP 文本响应里取「- Page URL: …」「- Page Title: …」 */
export function pageField(text: string, field: 'URL' | 'Title'): string | null {
  const m = text.match(new RegExp(`Page ${field}:\\s*(.+)`));
  return m ? (m[1] as string).trim() : null;
}

/** 取 yaml 代码块里的快照；没有代码块就返回全文 */
export function snapshotBody(text: string): string {
  const m = text.match(/```yaml\r?\n([\s\S]*?)```/);
  return m ? (m[1] as string) : text;
}

export class PlaywrightMcpDriver implements BrowserDriver {
  readonly name = 'playwright-mcp';
  readonly #o: PlaywrightMcpOptions;

  constructor(o: PlaywrightMcpOptions = {}) {
    this.#o = o;
  }

  #connect(): Promise<McpClient> {
    if (this.#o.connect) return this.#o.connect();
    const args = this.#o.args ?? defaultPlaywrightArgs(this.#o.profileDir ?? join(process.cwd(), 'pw-profile'));
    return StdioMcpClient.start(this.#o.command ?? 'npx', args);
  }

  async available(): Promise<boolean> {
    if (this.#o.probe) return this.#o.probe().catch(() => false);
    try {
      const c = await this.#connect();
      await c.close();
      return true;
    } catch {
      return false;
    }
  }

  async open(_label: string): Promise<DriverSession> {
    return new PlaywrightSession(await this.#connect());
  }
}

class PlaywrightSession implements DriverSession {
  #closed = false;
  constructor(private readonly c: McpClient) {}

  async #call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    if (this.#closed) throw new DriverError('CLOSED', '浏览器会话已关闭');
    return resultText(await this.c.callTool(name, args));
  }

  async goto(url: string) {
    await this.#call('browser_navigate', { url });
  }
  async url() {
    const u = pageField(await this.#call('browser_snapshot'), 'URL');
    if (!u) throw new DriverError('BAD_OUTPUT', '读不到页面地址');
    return u;
  }
  async title() {
    return pageField(await this.#call('browser_snapshot'), 'Title') ?? '';
  }
  async snapshot() {
    return snapshotBody(await this.#call('browser_snapshot'));
  }
  async click(ref: string) {
    await this.#call('browser_click', { target: assertRef(ref).replace(/^@/, ''), element: 'Aroomo' });
  }
  async fill(ref: string, value: string) {
    await this.#call('browser_type', { target: assertRef(ref).replace(/^@/, ''), text: value, element: 'Aroomo' });
  }
  async press(ref: string, key: string) {
    assertRef(ref);
    if (!/^[A-Za-z0-9+]{1,20}$/.test(key)) throw new DriverError('BAD_KEY', '按键格式不对');
    await this.#call('browser_press_key', { key });
  }
  async screenshotInfo() {
    const t = await this.#call('browser_evaluate', { function: '() => ({ width: window.innerWidth, height: window.innerHeight })' });
    const m = t.match(/\{\s*"width"\s*:\s*(\d+)\s*,\s*"height"\s*:\s*(\d+)\s*\}/);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
  }
  async handOff() {
    return false; // 有界面窗口，所有者直接在窗口里处理
  }
  async close() {
    if (this.#closed) return;
    await this.c.callTool('browser_close', {}).catch(() => undefined);
    await this.c.close();
    this.#closed = true;
  }
}
