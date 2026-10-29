/**
 * ego lite 驱动（主选，D162）：通过本机 `ego-browser nodejs` 运行脚本控制 ego lite。
 *
 * - ego lite 浏览器由所有者自己安装（免费、不开源），我们不打包；ego-browser skill 为 MIT。
 * - 每次调用是一个新进程；工作空间（TaskSpace）和页面标签在浏览器里持久，按 spaceId 续用。
 * - 脚本一律经 stdin 传入（不走命令行参数、不写临时文件），所以填写的值不会出现在进程列表或磁盘上。
 * - ego-browser 运行的脚本拿不到我们的环境变量，所以值只能内嵌在 stdin 脚本里（JSON 转义）。
 * - 子进程原始输出不写日志；只解析带 __AROOMO__ 前缀的那一行。
 */

import { spawn } from 'node:child_process';
import { assertRef, DriverError, type BrowserDriver, type DriverSession } from '../ports/driver.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
}

/** 运行一段 ego-browser 脚本；测试里换成假的 */
export type EgoExec = (script: string, timeoutMs: number) => Promise<ExecResult>;

const MARK = '__AROOMO__';

export function spawnEgoExec(command = 'ego-browser'): EgoExec {
  return (script, timeoutMs) =>
    new Promise((resolve, reject) => {
      // 参数固定为 ['nodejs']，不含任何外部输入；Windows 上 ego-browser 可能是 .cmd，需要经 shell 启动
      const child = spawn(command, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new DriverError('TIMEOUT', 'ego-browser 运行超时'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (stdout.length < 4_000_000) stdout += d;
      });
      child.stderr.resume(); // 丢弃：可能含脚本片段
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new DriverError('NOT_INSTALLED', `无法启动 ego-browser（${(e as NodeJS.ErrnoException).code ?? 'ERR'}）`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
      child.stdin.end(script, 'utf8');
    });
}

/** 生成脚本：body 里用 task / page，最后用 __out(data) 回传 */
export function buildScript(space: string | number, body: string): string {
  return [
    `const __out = (o) => console.log(${JSON.stringify(MARK)} + JSON.stringify(o));`,
    'try {',
    `  const task = await taskSpace(${JSON.stringify(space)});`,
    '  const page = task.page("p1");',
    body,
    '} catch (e) {',
    '  __out({ ok: false, code: String((e && e.code) || "EGO_ERROR"), message: String((e && e.message) || e).slice(0, 300) });',
    '}',
  ].join('\n');
}

export function parseOutput<T>(r: ExecResult): T {
  const line = r.stdout
    .split(/\r?\n/)
    .reverse()
    .find((l) => l.startsWith(MARK));
  if (!line) throw new DriverError('NO_OUTPUT', `ego-browser 没有返回结果（退出码 ${String(r.code)}）`);
  let o: { ok: boolean; data?: T; code?: string; message?: string };
  try {
    o = JSON.parse(line.slice(MARK.length)) as typeof o;
  } catch {
    throw new DriverError('BAD_OUTPUT', 'ego-browser 返回格式不对');
  }
  if (!o.ok) throw new DriverError(o.code ?? 'EGO_ERROR', o.message ?? 'ego-browser 出错');
  return o.data as T;
}

export interface EgoLiteOptions {
  exec?: EgoExec;
  command?: string;
  timeoutMs?: number;
}

export class EgoLiteDriver implements BrowserDriver {
  readonly name = 'ego-lite';
  readonly #exec: EgoExec;
  readonly #timeout: number;

  constructor(o: EgoLiteOptions = {}) {
    this.#exec = o.exec ?? spawnEgoExec(o.command);
    this.#timeout = o.timeoutMs ?? 90_000;
  }

  async run<T>(space: string | number, body: string): Promise<T> {
    return parseOutput<T>(await this.#exec(buildScript(space, body), this.#timeout));
  }

  async available(): Promise<boolean> {
    try {
      const r = await this.#exec(`console.log(${JSON.stringify(MARK)} + JSON.stringify({ ok: true, data: typeof taskSpace === "function" }));`, 20_000);
      return parseOutput<boolean>(r) === true;
    } catch {
      return false;
    }
  }

  async open(label: string): Promise<DriverSession> {
    const name = `aroomo-${label.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'task'}`;
    const id = await this.run<number | string>(name, '  __out({ ok: true, data: task.spaceId });');
    return new EgoLiteSession(this, id);
  }
}

class EgoLiteSession implements DriverSession {
  #closed = false;
  constructor(
    private readonly d: EgoLiteDriver,
    private readonly space: number | string,
  ) {}

  async #run<T>(body: string): Promise<T> {
    if (this.#closed) throw new DriverError('CLOSED', '工作空间已关闭');
    return this.d.run<T>(this.space, body);
  }

  async goto(url: string) {
    await this.#run(`  await page.goto(${JSON.stringify(url)}, { waitUntil: "load" });\n  __out({ ok: true });`);
  }
  url() {
    return this.#run<string>('  __out({ ok: true, data: await page.url() });');
  }
  title() {
    return this.#run<string>('  __out({ ok: true, data: await page.title() });');
  }
  snapshot() {
    return this.#run<string>('  __out({ ok: true, data: String(await page.snapshot({ scope: "full_page" })) });');
  }
  async click(ref: string) {
    await this.#run(`  await page.click(${JSON.stringify(assertRef(ref))}, { label: "Aroomo" });\n  __out({ ok: true });`);
  }
  async fill(ref: string, value: string) {
    await this.#run(`  await page.fill(${JSON.stringify(assertRef(ref))}, ${JSON.stringify(value)}, { clearFirst: true });\n  __out({ ok: true });`);
  }
  async press(ref: string, key: string) {
    if (!/^[A-Za-z0-9+]{1,20}$/.test(key)) throw new DriverError('BAD_KEY', '按键格式不对');
    await this.#run(`  await page.press(${JSON.stringify(assertRef(ref))}, ${JSON.stringify(key)});\n  __out({ ok: true });`);
  }
  screenshotInfo() {
    return this.#run<{ width: number; height: number }>(
      '  const s = await page.evaluate("({ width: window.innerWidth, height: window.innerHeight })");\n  __out({ ok: true, data: s });',
    );
  }
  async handOff() {
    await this.#run('  await task.handOff();\n  __out({ ok: true });');
    return true;
  }
  async close() {
    if (this.#closed) return;
    await this.#run('  await task.finish({ keep: [] });\n  __out({ ok: true });').catch(() => undefined);
    this.#closed = true;
  }
}
