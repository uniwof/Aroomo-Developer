/**
 * 写日志前清洗任意结构（PRODUCT 0.4：密钥不得进日志）。
 * - 字段名像密钥（key / token / secret / password / authorization / cookie）的值整体替换；
 * - 其余字符串再过一遍 redactSecrets（识别 sk-…、Bearer … 等形态）；
 * - 限制深度和长度，避免把大请求体整个写进日志。
 */
import { REDACTED, redactSecrets } from '../audit/redact.js';

const SENSITIVE_FIELD = /key|token|secret|passw|authorization|cookie|credential/i;

export function scrubForLog(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof v === 'string') return redactSecrets(v.length > 500 ? `${v.slice(0, 500)}…` : v);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrubForLog(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_FIELD.test(k) ? REDACTED : scrubForLog(val, depth + 1);
    }
    return out;
  }
  return v;
}
