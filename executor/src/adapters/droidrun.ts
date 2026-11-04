/**
 * DroidRun（mobilerun，MIT）云手机 / 安卓适配器（D189、D192）：只做适配器和配置，不在服务器跑模拟器。
 *
 * 通过 bridges/droidrun_bridge.py（所有者电脑上的 Python + `pip install mobilerun`）运行：
 * - 任务 JSON 走 stdin（含访问 Core /v1 的设备令牌和本次凭据），不进命令行、不写文件；
 * - 凭据交给 DroidRun 的 type_secret（模型只见 secret id，不见值）；
 * - 只解析 __AROOMO__ 结果行，其余输出丢弃。
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DriverError } from '../ports/driver.js';
import { parseOutput, type ExecResult } from './ego-lite.js';

export interface PhoneResult {
  success: boolean;
  reason: string;
  steps: number;
}

export interface PhoneJob {
  goal: string;
  /** SECRET_ID → 值，只在内存 */
  credentials: Record<string, string>;
}

export interface PhonePort {
  readonly name: string;
  available(): Promise<boolean>;
  run(job: PhoneJob): Promise<PhoneResult>;
}

export type BridgeExec = (input: string, timeoutMs: number) => Promise<ExecResult>;

export interface DroidRunOptions {
  /** Python 解释器（Windows 常为 py 或 python） */
  python?: string;
  bridgePath?: string;
  /** 设备：USB / 网络 adb 序列号，或云手机后端 + 设备 id（按 Q3 选定的厂商填） */
  device?: { serial?: string; control_backend?: string; device_id?: string };
  coreUrl: string;
  getToken: () => string;
  model?: string;
  steps?: number;
  exec?: BridgeExec;
  timeoutMs?: number;
}

export const DEFAULT_BRIDGE = fileURLToPath(new URL('../../bridges/droidrun_bridge.py', import.meta.url));

export function spawnBridge(python: string, bridgePath: string): BridgeExec {
  return (input, timeoutMs) =>
    new Promise((resolve, reject) => {
      const shell = process.platform === 'win32' && !/[\\/]/.test(python);
      const child = spawn(python, [bridgePath], { stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new DriverError('TIMEOUT', 'DroidRun 运行超时'));
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (stdout.length < 2_000_000) stdout += d;
      });
      child.stderr.resume();
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new DriverError('NOT_INSTALLED', `无法启动 Python（${(e as NodeJS.ErrnoException).code ?? 'ERR'}）`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout });
      });
      child.stdin.end(input, 'utf8');
    });
}

export class DroidRunPhone implements PhonePort {
  readonly name = 'droidrun';
  readonly #o: DroidRunOptions;
  readonly #exec: BridgeExec;

  constructor(o: DroidRunOptions) {
    this.#o = { ...o, coreUrl: o.coreUrl.replace(/\/+$/, '') };
    this.#exec = o.exec ?? spawnBridge(o.python ?? (process.platform === 'win32' ? 'py' : 'python3'), o.bridgePath ?? DEFAULT_BRIDGE);
  }

  async available(): Promise<boolean> {
    try {
      return parseOutput<boolean>(await this.#exec(JSON.stringify({ probe: true }), 60_000)) === true;
    } catch {
      return false;
    }
  }

  async run(job: PhoneJob): Promise<PhoneResult> {
    const input = JSON.stringify({
      goal: job.goal,
      model: this.#o.model ?? 'aroomo/auto',
      api_base: `${this.#o.coreUrl}/v1`,
      api_key: this.#o.getToken(),
      credentials: job.credentials,
      device: this.#o.device ?? {},
      steps: this.#o.steps ?? 30,
    });
    return parseOutput<PhoneResult>(await this.#exec(input, this.#o.timeoutMs ?? 20 * 60_000));
  }
}

/** 字段名 → DroidRun secret id（大写、只留字母数字下划线） */
export function secretIdFor(field: string): string {
  return field.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}
