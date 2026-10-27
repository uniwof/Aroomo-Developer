/**
 * 密钥脱敏 (Secret Redaction)
 * 匹配常见 Key 形态（sk-…、AIza…、ghp_…、Bearer 令牌、长 hex/base64 串）替换为 [REDACTED]
 */
export function redactSecrets(text: string): string {
  if (!text) return text;

  let result = text;

  // 1. Bearer 令牌 (e.g. Bearer my-secret-token)
  result = result.replace(/\bBearer\s+[a-zA-Z0-9_./=+-]+/gi, '[REDACTED]');

  // 2. sk- 开头 Key (OpenAI / Anthropic / LiteLLM 等, e.g. sk-proj-1234567890abcdefghijklmnopqrstuvwxyz)
  result = result.replace(/\bsk-[a-zA-Z0-9_./-]{10,}\b/g, '[REDACTED]');

  // 3. AIza 开头 Key (Google Cloud / Gemini, e.g. AIzaSyA1234567890abcdefghijklmnopqrst)
  result = result.replace(/\bAIza[a-zA-Z0-9_-]{20,}\b/g, '[REDACTED]');

  // 4. GitHub 令牌 (ghp_..., gho_..., ghu_..., ghs_..., ghr_...)
  result = result.replace(/\bgh[pousr]_[a-zA-Z0-9]{20,}\b/g, '[REDACTED]');

  // 5. JWT 令牌 (eyJ... . eyJ... . ...)
  result = result.replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]');

  // 6. 长 hex 串 (32 位及以上连续 0-9a-fA-F，排除带有 '-' 的 UUID)
  result = result.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED]');

  // 7. 长 Base64 / 密钥串 (40 位及以上连续 alphanum+/= 字符串)
  result = result.replace(/\b[a-zA-Z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');

  return result;
}
