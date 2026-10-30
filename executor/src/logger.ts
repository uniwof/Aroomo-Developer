/**
 * 本地日志：一行一条 JSON，写到 stderr（Windows 计划任务 / 服务包装器负责落到日志文件）。
 * 所有消息先过 scrubTokens 和当前任务的 Redactor，绝不记录凭据、令牌、cookie、验证码。
 */

import { scrubTokens, type Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  withRedactor(r: Redactor): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(opts: { level?: LogLevel; sink?: LogSink; redactor?: Redactor } = {}): Logger {
  const min = ORDER[opts.level ?? 'info'];
  const sink: LogSink = opts.sink ?? ((line) => process.stderr.write(`${line}\n`));
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    let line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ?? {}) });
    line = scrubTokens(line);
    if (opts.redactor) line = opts.redactor.redact(line);
    sink(line);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    withRedactor: (r) => createLogger({ ...opts, redactor: r }),
  };
}
