/**
 * 脱敏器：本任务从保险箱取到的每个值都登记在这里；任何要写日志、发进度、回结果的文字都先过一遍。
 * 只存在内存里，任务结束调用 clear()。
 */

export const REDACTED = '[已隐藏]';

/** 太短的值（如 1–3 位）误伤率高，仍然登记，但只做整词替换 */
const MIN_SUBSTRING_LEN = 4;

export class Redactor {
  #values: string[] = [];

  add(value: string): void {
    if (!value) return;
    if (!this.#values.includes(value)) this.#values.push(value);
    // 长的先替换，避免短值把长值切碎后漏掉
    this.#values.sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.#values.length;
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.#values) {
      if (v.length >= MIN_SUBSTRING_LEN) {
        out = out.split(v).join(REDACTED);
      } else {
        const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'g'), REDACTED);
      }
    }
    return out;
  }

  /** 深度脱敏任意可 JSON 化的对象（进度、结果体） */
  redactDeep<T>(obj: T): T {
    if (this.#values.length === 0) return obj;
    return JSON.parse(this.redact(JSON.stringify(obj))) as T;
  }

  clear(): void {
    this.#values = [];
  }
}

/** 通用兜底：即使没登记，也把常见令牌形态抹掉（Bearer、长随机串），日志专用 */
export function scrubTokens(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk|ak|gsk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}\b/g, REDACTED);
}
