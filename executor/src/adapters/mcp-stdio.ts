/**
 * 最小 MCP stdio 客户端（JSON-RPC 2.0，一行一条消息），只实现执行员需要的 initialize / tools/call。
 * 不引第三方 SDK，保持执行员运行时零依赖；以后需要完整功能可换 @modelcontextprotocol/sdk（MIT）。
 * 服务器的响应可能回显填写的值（例如 Playwright MCP 会回显生成的代码），所以调用方不得记录原始响应。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { DriverError } from '../ports/driver.js';

export interface McpToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioMcpClient implements McpClient {
  #child: ChildProcessWithoutNullStreams;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #buf = '';
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.#onData(d));
    child.stderr.resume(); // 丢弃，可能含页面内容
    child.on('error', () => this.#failAll(new DriverError('NOT_INSTALLED', '无法启动 MCP 服务')));
    child.on('close', () => this.#failAll(new DriverError('MCP_CLOSED', 'MCP 服务已退出')));
  }

  static async start(command: string, args: string[], env?: NodeJS.ProcessEnv, initTimeoutMs = 60_000): Promise<StdioMcpClient> {
    // Windows 上 npx 等是 .cmd，需要经 shell；给了绝对路径（如 node.exe）就不经 shell，避免路径里的空格出错
    const shell = process.platform === 'win32' && !/[\\/]/.test(command);
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell, windowsHide: true, env: env ?? process.env });
    const c = new StdioMcpClient(child);
    await c.#request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aroomo-executor', version: '0.1.0' } }, initTimeoutMs);
    c.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return c;
  }

  #onData(d: string) {
    this.#buf += d;
    if (this.#buf.length > 16_000_000) this.#buf = '';
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.#pending.get(msg.id);
      if (!p) continue;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new DriverError('MCP_ERROR', String(msg.error.message ?? 'MCP 调用出错').slice(0, 200)));
      else p.resolve(msg.result);
    }
  }

  #failAll(e: Error) {
    this.#closed = true;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.#pending.clear();
  }

  #send(msg: unknown) {
    this.#child.stdin.write(`${JSON.stringify(msg)}\n`, 'utf8');
  }

  #request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new DriverError('MCP_CLOSED', 'MCP 服务已退出'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DriverError('TIMEOUT', `MCP 调用超时：${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<McpToolResult> {
    const r = (await this.#request('tools/call', { name, arguments: args }, timeoutMs)) as McpToolResult;
    if (r?.isError) throw new DriverError('TOOL_ERROR', `${name} 执行失败`);
    return r ?? {};
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill();
  }
}

export function resultText(r: McpToolResult): string {
  return (r.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}
