/**
 * 浏览器驱动端口（底层原语）：ego lite / Playwright MCP 各实现一份，必须通过 test/driver-contract.ts。
 * 高层的「按自然语言操作」由 agent/planned-session.ts 在这些原语之上完成，换驱动不影响任务逻辑。
 *
 * 元素用快照里的引用（如 @12）定位：先 snapshot()，再对引用 click / fill。
 */

export interface DriverSession {
  goto(url: string): Promise<void>;
  url(): Promise<string>;
  title(): Promise<string>;
  /** 语义快照（页面转成带 @引用 的结构化文字），给规划模型看 */
  snapshot(): Promise<string>;
  click(ref: string): Promise<void>;
  /** value 只在内存里；实现不得记录、写盘或放进命令行参数 */
  fill(ref: string, value: string): Promise<void>;
  press(ref: string, key: string): Promise<void>;
  /** 截图尺寸（图片本体不出本机，合同 3.2） */
  screenshotInfo(): Promise<{ width: number; height: number }>;
  /** 把这个工作空间交给所有者手动操作（验证码等）；不支持返回 false */
  handOff(): Promise<boolean>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  readonly name: string;
  available(): Promise<boolean>;
  /** label 用于工作空间命名（如 aroomo-<任务id>），便于所有者在 ego lite 里认出来 */
  open(label: string): Promise<DriverSession>;
}

export class DriverError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/** 快照引用格式：ego lite 为 @数字，Playwright MCP 为 e12 / f1e3 这类字母数字；只允许字母数字，杜绝注入 */
export function assertRef(ref: string): string {
  if (!/^@?[A-Za-z0-9]{1,16}$/.test(ref)) throw new DriverError('BAD_REF', `元素引用格式不对：${ref.slice(0, 20)}`);
  return ref;
}
