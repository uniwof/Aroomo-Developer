/**
 * X-05 工具调用过程可见（功能补充 v1；格式见 docs/api/stream-parts.md）：Core 把上游模型报出来的工具调用
 * 变成一个数据块 `data-aroomo-tool`，跟着回复发给浏览器、跟着回复存进会话（meta.tools）。
 *
 * - 来源只有上游流里的结构化字段：`delta.executed_tools`（服务商替模型执行过的工具，带结果）和
 *   `delta.tool_calls`（模型想调用的函数；Core 现在不给成员开工具，所以记成「没开放」，不执行）。
 *   模型正文里漏出来的工具标记不算（runner 里已清理），浏览器发来的同名部件一律不认（X-23）。
 * - 脱敏在 Core 做完再发（D199 红线 1）：键名像 key / token / cookie / password 的值、看起来像密钥的长串、
 *   网址的查询参数和 #片段、网址里的账号密码，一律换成「已隐藏」。
 * - 详细程度按账号：所有者（scope = owner）看参数和结果摘录；家人账号只看一句结果摘要，参数和结果原文都不发、不存。
 */

export const TOOL_PART = 'data-aroomo-tool';
/** 一条回复里最多记几个工具调用（再多的只计数，不再展开） */
export const TOOL_MAX_PER_REPLY = 20;
const ARGS_MAX = 1000;
const RESULT_MAX = 1500;
const SUMMARY_MAX = 120;
export const HIDDEN = '【已隐藏】';

export type ToolDetail = 'full' | 'summary';
export type ToolState = 'done' | 'failed' | 'unavailable';

/** data-aroomo-tool 的 data（浏览器只读；家人账号没有 args / result） */
export interface ToolPartData {
  /** 这条回复里第几个工具调用（0 起） */
  index: number;
  /** 工具名（只留字母数字和 _ . -，≤64） */
  name: string;
  /** 人话：「搜了网页」 */
  label: string;
  state: ToolState;
  /** 结果条数（知道的时候才有） */
  count?: number;
  /** 一句结果摘要（≤120 字，已脱敏） */
  summary: string;
  /** 只给所有者：脱敏后的参数（JSON 文本，≤1000 字） */
  args?: string;
  /** 只给所有者：脱敏后的结果摘录（≤1500 字） */
  result?: string;
}

const SECRET_KEY = /(api[_-]?key|apikey|token|secret|passw(or)?d|pwd|cookie|authori[sz]ation|auth|session|credential|signature|^sig$|private[_-]?key|otp|验证码|密码|密钥)/i;
/** 看起来像密钥的串：常见前缀，或 32 位以上不带空格的十六进制 / base64 串 */
const SECRET_VALUE = /\b(?:sk|pk|rk|gsk|xai|ghp|gho|github_pat|glpat|AKIA|AIza|ya29|eyJ)[A-Za-z0-9_\-.]{12,}|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|\b[A-Fa-f0-9]{32,}\b|\b[A-Za-z0-9+_-]{40,}={0,2}/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** 路径里像凭据的一段：key=… / token:… 这类，或 24 位以上字母数字混排（如 /bot<令牌>/、/hooks/<密钥>）（Groq 小审） */
const SECRET_SEGMENT = /(?:api[_-]?key|key|token|secret|sig|signature|auth|password|passwd|session)[=:]|^(?=[A-Za-z0-9:_-]*\d)(?=[A-Za-z0-9:_-]*[A-Za-z])[A-Za-z0-9:_-]{24,}$/i;

/** 网址：去掉账号密码、查询参数、#片段，路径里像凭据的段换掉（留下域名和其余路径，够她认出是哪个网页） */
export function redactUrl(u: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/?#\s]*@)?([^/?#]*)([^?#]*)([?#].*)?$/i.exec(u);
  if (!m) return u;
  const path = m[3]!
    .split('/')
    .map((seg) => (SECRET_SEGMENT.test(seg) ? HIDDEN : seg))
    .join('/');
  return `${m[1]}${m[2]}${path}${m[4] ? '?…' : ''}`;
}

/** 一段文字：网址去参数，像密钥的串换掉 */
export function redactText(s: string): string {
  return s.replace(URL_RE, (u) => redactUrl(u)).replace(SECRET_VALUE, HIDDEN);
}

/** 结构化参数：键名像密钥的整值隐藏；字符串值按 redactText 处理；最多 4 层 */
export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactText(v);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 4) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redactValue(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) out[k] = SECRET_KEY.test(k) ? HIDDEN : redactValue(x, depth + 1);
    return out;
  }
  return String(v);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** 参数：上游给的是 JSON 文本（可能不完整）。能解析就按结构脱敏，不能就按文字脱敏 */
export function redactArgs(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return clip(redactText(raw), ARGS_MAX);
    }
  }
  return clip(JSON.stringify(redactValue(v)), ARGS_MAX);
}

const LABELS: Array<[RegExp, string]> = [
  [/search/i, '搜了网页'],
  [/(read|fetch|open|visit).*(web|page|url)|^(browser\.)?open$|webpage|fetch/i, '读了网页'],
  [/python|code|interpreter|exec/i, '运行了代码'],
  [/browser/i, '用了浏览器'],
];
export const safeName = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) : '') || 'tool';
export function toolLabel(name: string): string {
  return LABELS.find(([re]) => re.test(name))?.[1] ?? `用了工具 ${name}`;
}

/** 正在拼的一个工具调用（流里一个调用会分好几段来） */
interface Pending {
  name: string;
  args: string;
  output: string | null;
  count: number | undefined;
  executed: boolean;
}

/**
 * 从上游的 chat.completion.chunk 里收集工具调用；回复结束时 parts() 一次性产出数据块。
 * 按 (来源, index) 合并同一个调用的分段。不认识的格式忽略（不影响正文）。
 */
export class ToolCollector {
  readonly #calls = new Map<string, Pending>();
  readonly #order: string[] = [];
  #dropped = 0;

  #get(key: string): Pending | null {
    let p = this.#calls.get(key);
    if (!p) {
      if (this.#order.length >= TOOL_MAX_PER_REPLY) {
        this.#dropped++;
        return null;
      }
      p = { name: '', args: '', output: null, count: undefined, executed: false };
      this.#calls.set(key, p);
      this.#order.push(key);
    }
    return p;
  }

  /** 读一个 choice 的 delta（流式）或 message（非流式） */
  add(delta: Record<string, unknown> | undefined): void {
    if (!delta) return;
    const executed = Array.isArray(delta.executed_tools) ? (delta.executed_tools as Array<Record<string, unknown>>) : [];
    executed.forEach((t, i) => {
      if (!t || typeof t !== 'object') return;
      const p = this.#get(`x:${typeof t.index === 'number' ? t.index : i}`);
      if (!p) return;
      p.executed = true;
      if (typeof t.type === 'string' && !p.name) p.name = safeName(t.type);
      if (typeof t.name === 'string') p.name = safeName(t.name);
      if (typeof t.arguments === 'string' && t.arguments) p.args = t.arguments;
      else if (t.arguments && typeof t.arguments === 'object') p.args = JSON.stringify(t.arguments);
      if (typeof t.output === 'string') p.output = t.output;
      const results = (t.search_results as { results?: unknown } | undefined)?.results;
      if (Array.isArray(results)) p.count = results.length;
    });
    const calls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Array<Record<string, unknown>>) : [];
    calls.forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const p = this.#get(`f:${typeof c.index === 'number' ? c.index : i}`);
      if (!p) return;
      const fn = c.function as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof fn?.name === 'string' && fn.name) p.name = safeName(fn.name);
      if (typeof fn?.arguments === 'string') p.args = (p.args + fn.arguments).slice(0, 20_000);
    });
  }

  get size(): number {
    return this.#order.length;
  }

  /** 新出现一个调用、或某个调用拿到了结果时加 1（流里据此即时发一次，不为参数的每个字发） */
  get version(): number {
    let v = this.#order.length;
    for (const p of this.#calls.values()) if (p.output !== null) v++;
    return v;
  }

  parts(detail: ToolDetail): ToolPartData[] {
    return this.#order.map((k, index) => toPart(index, this.#calls.get(k)!, detail));
  }

  /** 超过上限没记下的个数 */
  get dropped(): number {
    return this.#dropped;
  }
}

function toPart(index: number, p: Pending, detail: ToolDetail): ToolPartData {
  const name = p.name || 'tool';
  const label = toolLabel(name);
  const state: ToolState = !p.executed ? 'unavailable' : p.output === null ? 'failed' : 'done';
  const count = p.count;
  const summary =
    state === 'unavailable'
      ? '这个工具还没有开放给成员，没有执行'
      : state === 'failed'
        ? '没有拿到结果'
        : count !== undefined
          ? `${count} 条结果`
          : clip(oneLine(redactText(p.output ?? '')), SUMMARY_MAX) || '已完成';
  const out: ToolPartData = { index, name, label, state, summary: clip(summary, SUMMARY_MAX), ...(count !== undefined ? { count } : {}) };
  if (detail === 'full') {
    const args = redactArgs(p.args);
    if (args) out.args = args;
    if (p.output) out.result = clip(redactText(p.output), RESULT_MAX);
  }
  return out;
}

/** 存库上限（conversation_messages.meta ≤ 20000 字，留出余量）：超了就从后往前先去结果、再去参数，摘要总是留着 */
export const TOOLS_STORE_MAX = 15_000;
export function fitForStorage(parts: ToolPartData[], max = TOOLS_STORE_MAX): ToolPartData[] {
  const out = parts.map((p) => ({ ...p }));
  for (const field of ['result', 'args'] as const) {
    for (let i = out.length - 1; i >= 0 && JSON.stringify(out).length > max; i--) delete out[i]![field];
  }
  return out;
}
