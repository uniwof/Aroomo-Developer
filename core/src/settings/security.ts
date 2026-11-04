/**
 * 敏感内容保护开关（DECISIONS D38「敏感内容默认不外发」；PRODUCT §8.3 设置「安全」；docs/ops/OLD-VS-NEW.md #81）。
 * - 默认开。开着时：命中敏感信息（密码、银行卡号、API Key、身份证号等）的消息按「敏感」路由——
 *   不发给外部智能体成员，外部智能体也不能当负责人接手（router/route.ts）。
 * - 关掉会降低保护：只有主人本人能改（操作员禁止项 settings:sensitive:write，D62），并写审计。
 */
import type { AuditFn } from '../audit/types.js';
import type { SettingsStore } from './store.js';

const KEY = 'security';

export interface SecurityState {
  sensitiveProtect: boolean;
}

export class SecurityService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly now: () => Date,
  ) {}

  async get(): Promise<SecurityState> {
    const v = await this.settings.get<Partial<SecurityState>>(KEY);
    return { sensitiveProtect: v?.sensitiveProtect !== false };
  }

  async set(next: SecurityState, audit: AuditFn): Promise<SecurityState> {
    await this.settings.set(KEY, { sensitiveProtect: next.sensitiveProtect }, this.now());
    await audit('settings.sensitive_protect', { type: 'setting', id: 'sensitiveProtect' }, 'ok', next.sensitiveProtect ? 'on' : 'off');
    return this.get();
  }
}

/**
 * 最小的敏感信息识别（PRODUCT §8.3「命中敏感词自动标记」的第一步；只看最后一条用户消息）：
 * 明说的密码 / 口令、常见 API Key 形态、能通过 Luhn 校验的银行卡号、18 位身份证号。
 * 宁可漏判也不乱判；更完整的识别（如 Presidio，PRODUCT §6）以后再做。
 */
export function looksSensitive(text: string): boolean {
  if (!text) return false;
  if (/(密码|口令|password|passwd|pwd)\s*[:：=是为]\s*\S{4,}/i.test(text)) return true;
  if (/\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/.test(text)) return true;
  if (/(?<!\d)\d{17}[\dXx](?!\d)/.test(text)) return true;
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    if (luhn(m[0].replace(/\D/g, ''))) return true;
  }
  return false;
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
