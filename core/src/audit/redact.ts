/**
 * 写入审计日志前的密钥脱敏（PRODUCT 0.4：密钥不得进日志）。
 * 宁可多脱敏：命中就整段替换成 [REDACTED]。
 */

export const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Authorization: Bearer xxx / Basic xxx
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // OpenAI / Anthropic / DeepSeek / 通用 sk-、sk-proj-、sk-ant-（前面不能紧挨字母数字，避免 "risk-free"）
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
  // Google API key
  /AIza[0-9A-Za-z_-]{30,}/g,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // Slack
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Groq / xAI / Hugging Face / Replicate 等常见前缀
  /\b(?:gsk|xai|hf|r8)_[A-Za-z0-9]{20,}/g,
  // JWT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // key=value 形式的查询串或配置
  /\b(?:api[_-]?key|access[_-]?token|secret|password|token)=[^\s&"']{6,}/gi,
  // 长 hex（≥32）
  /(?<![A-Za-z0-9])[0-9a-fA-F]{32,}(?![A-Za-z0-9])/g,
  // 长 base64 / base64url（≥40，且同时含字母和数字）
  /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const re of PATTERNS) out = out.replace(re, REDACTED);
  return out;
}
