/**
 * 点名解析（DECISIONS D31；PRODUCT §8.3「输入框」、§9.4.1）。
 *
 * 规则：
 * - 「@」或全角「＠」开头；前一个字符是字母 / 数字 / 下划线 / 点时不算点名（排除 a@b.com 这类邮箱）。
 * - 行首、换行后、空白或标点后的 @ 都算。
 * - Markdown 代码块（``` / ~~~）和行内代码（`…`）里的 @ 不算；URL 里的 @（https://x.com/@user）不算。
 * - 名字可以加引号：@"Gemini 2.5 Pro"、@「Gemini 2.5 Pro」、@“Gemini 2.5 Pro”、@『…』。
 * - 成员名和别名大小写不敏感，按最长匹配（"Gemini 2.5 Pro" 优先于 "Gemini"）；
 *   大小写比较逐个码点进行，toLowerCase() 改变长度（如土耳其语 İ）时索引仍正确。
 * - 名字后面必须是边界：结尾、空白、标点、emoji，或文字体系切换（"@Groq你好" 的 Groq 与「你」之间）；
 *   英文句点只有后接空白 / 结尾时才算边界（"@gpt-4.1" 里的点不算）。
 * - 匹配不到成员的 @xxx 记为 unknown（仍算点名：D31「输入里有 @ 就是点名」）。
 *
 * 扩展点：解析出的每个点名是一个 MentionToken（kind 目前为 member / unknown）。
 * 以后的能力 @（「@生图」，P2）只需新增一个 kind 和对应的 resolver，不用改扫描逻辑。
 */
import type { MentionParseResult, RoutableMember } from './types.js';

const AT_CHARS = new Set(['@', '＠']);
/** 邮箱判断：@ 前面紧挨这些字符时不算点名 */
const EMAIL_PREV = /[\p{L}\p{N}_.]/u;
/** 名字内部可以出现的字符（用于判断「名字是否结束」） */
const NAME_CHAR = /[\p{L}\p{N}\p{M}_+\-.]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const QUOTES: Record<string, string> = { '"': '"', '「': '」', '“': '”', '『': '』' };

export type MentionKind = 'member' | 'unknown';

export interface MentionToken {
  kind: MentionKind;
  /** @ 的位置（UTF-16 下标，指向原文） */
  start: number;
  /** 点名结束位置（不含） */
  end: number;
  /** 原文片段，例如 "@Gemini 2.5 Pro" */
  raw: string;
  /** 用户写的名字（去掉 @ 和引号） */
  name: string;
  quoted: boolean;
  memberId?: string;
}

export interface ParseResultWithTokens extends MentionParseResult {
  tokens: MentionToken[];
}

interface Candidate {
  label: string;
  lower: string;
  memberId: string;
}

function buildCandidates(members: RoutableMember[]): Candidate[] {
  const out: Candidate[] = [];
  for (const m of members) {
    for (const label of [m.name, ...(m.aliases ?? [])]) {
      const trimmed = label.trim();
      if (trimmed) out.push({ label: trimmed, lower: trimmed.toLowerCase(), memberId: m.id });
    }
  }
  out.sort((a, b) => b.lower.length - a.lower.length);
  return out;
}

/** 前一个码点（正确处理代理对）。 */
function prevCodePoint(text: string, idx: number): string | undefined {
  if (idx <= 0) return undefined;
  const lo = text.charCodeAt(idx - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && idx >= 2) {
    const hi = text.charCodeAt(idx - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return text.slice(idx - 2, idx);
  }
  return text[idx - 1];
}

function codePointAt(text: string, idx: number): string | undefined {
  const cp = text.codePointAt(idx);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

/**
 * 从 text[start] 开始逐码点小写比较，看是否等于 labelLower；
 * 等于则返回原文中的结束下标，否则 -1。小写后长度变化时下标仍然指向原文。
 */
function matchAt(text: string, start: number, labelLower: string): number {
  let i = start;
  let acc = '';
  while (acc.length < labelLower.length && i < text.length) {
    const ch = codePointAt(text, i) as string;
    acc += ch.toLowerCase();
    i += ch.length;
    if (!labelLower.startsWith(acc)) return -1;
  }
  return acc === labelLower ? i : -1;
}

/** text[idx] 是否是名字的结束边界；lastChar 是名字的最后一个字符。 */
function isBoundary(text: string, idx: number, lastChar: string | undefined): boolean {
  const ch = codePointAt(text, idx);
  if (ch === undefined) return true;
  if (AT_CHARS.has(ch)) return true;
  if (ch === '.') {
    const next = text[idx + 1];
    return next === undefined || /\s/u.test(next);
  }
  if (!NAME_CHAR.test(ch)) return true; // 空白、标点、emoji 等
  // 文字体系切换：拉丁名字后紧跟中日韩文字，或中日韩名字（没有空格习惯）后跟任何文字
  if (lastChar !== undefined && (CJK.test(lastChar) || CJK.test(ch)) && CJK.test(lastChar) !== CJK.test(ch)) return true;
  if (lastChar !== undefined && CJK.test(lastChar)) return true;
  return false;
}

/** 代码块、行内代码、URL 的区间：这些区间里的 @ 不算点名，正文原样保留。 */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // 围栏代码块：行首 ``` 或 ~~~，到同样的围栏或文末
  const fence = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;
  for (const m of text.matchAll(fence)) {
    const s = (m.index ?? 0) + (m[1]?.length ?? 0);
    ranges.push([s, (m.index ?? 0) + m[0].length]);
  }
  const inFence = (i: number) => ranges.some(([s, e]) => i >= s && i < e);
  // 行内代码：成对的反引号串
  const inline = /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
  for (const m of text.matchAll(inline)) {
    const s = m.index ?? 0;
    if (!inFence(s)) ranges.push([s, s + m[0].length]);
  }
  // URL
  const url = /\b(?:https?:\/\/|www\.)[^\s<>"'，。！？、）」』]+/giu;
  for (const m of text.matchAll(url)) {
    const s = m.index ?? 0;
    if (!ranges.some(([a, b]) => s >= a && s < b)) ranges.push([s, s + m[0].length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

function tryQuoted(text: string, at: number, candidates: Candidate[]): MentionToken | null {
  const open = text[at + 1];
  if (open === undefined) return null;
  const close = QUOTES[open];
  if (!close) return null;
  const endQuote = text.indexOf(close, at + 2);
  const nl = text.indexOf('\n', at + 2);
  if (endQuote < 0 || (nl >= 0 && nl < endQuote)) return null;
  const name = text.slice(at + 2, endQuote).trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const end = endQuote + 1;
  const lower = name.toLowerCase();
  const hit = candidates.find((c) => c.lower === lower);
  return {
    kind: hit ? 'member' : 'unknown',
    start: at,
    end,
    raw: text.slice(at, end),
    name,
    quoted: true,
    ...(hit ? { memberId: hit.memberId } : {}),
  };
}

function tryPlain(text: string, at: number, candidates: Candidate[]): MentionToken | null {
  const start = at + (text[at] as string).length;
  for (const c of candidates) {
    const end = matchAt(text, start, c.lower);
    if (end < 0) continue;
    const last = prevCodePoint(text, end);
    if (!isBoundary(text, end, last)) continue;
    return { kind: 'member', start: at, end, raw: text.slice(at, end), name: text.slice(start, end), quoted: false, memberId: c.memberId };
  }
  // 未知点名：取到下一个边界为止
  let j = start;
  let last: string | undefined;
  while (j < text.length) {
    if (j > start && isBoundary(text, j, last)) break;
    const ch = codePointAt(text, j) as string;
    if (j === start && (!NAME_CHAR.test(ch) || ch === '.')) break;
    last = ch;
    j += ch.length;
  }
  if (j === start) return null; // 孤立的 @
  return { kind: 'unknown', start: at, end: j, raw: text.slice(at, j), name: text.slice(start, j), quoted: false };
}

/** 完整解析结果（含每个点名的位置），供需要高亮 / 能力 @ 的调用方使用。 */
export function parseMentionTokens(text: string, members: RoutableMember[]): ParseResultWithTokens {
  const candidates = buildCandidates(members);
  const ranges = protectedRanges(text);
  const tokens: MentionToken[] = [];
  let r = 0;
  let i = 0;
  while (i < text.length) {
    while (r < ranges.length && (ranges[r] as [number, number])[1] <= i) r += 1;
    const range = ranges[r];
    if (range && i >= range[0]) {
      i = range[1];
      continue;
    }
    const ch = text[i] as string;
    if (!AT_CHARS.has(ch)) {
      i += 1;
      continue;
    }
    const prev = prevCodePoint(text, i);
    if (prev !== undefined && EMAIL_PREV.test(prev)) {
      i += 1;
      continue;
    }
    const tok = tryQuoted(text, i, candidates) ?? tryPlain(text, i, candidates);
    if (!tok) {
      i += 1;
      continue;
    }
    tokens.push(tok);
    i = tok.end;
  }

  const memberIds: string[] = [];
  const unknown: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'member' && t.memberId && !memberIds.includes(t.memberId)) memberIds.push(t.memberId);
    if (t.kind === 'unknown' && !unknown.includes(t.name)) unknown.push(t.name);
  }

  return { memberIds, unknown, body: stripTokens(text, tokens), hasMention: tokens.length > 0, tokens };
}

/** 去掉点名片段得到正文；保留换行和代码块原样，只吃掉点名后多出来的空格。 */
function stripTokens(text: string, tokens: MentionToken[]): string {
  let out = '';
  let pos = 0;
  for (const t of tokens) {
    out += text.slice(pos, t.start);
    pos = t.end;
    const atLineStart = out.length === 0 || /[ \t\n]$/.test(out);
    if (atLineStart) {
      while (pos < text.length && (text[pos] === ' ' || text[pos] === '\t' || text[pos] === '\u3000')) pos += 1;
    }
  }
  out += text.slice(pos);
  return out
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/u, ''))
    .join('\n')
    .trim();
}

/**
 * LobeHub 点选 @ 菜单生成的提及标签：<mention name="@X" id="agt_..."/>（#210）。
 * 改写成手打的 @"X"，与手打等效；id 能对上成员时用成员名（改名后仍然准）。代码块 / URL 里的不动。
 */
export function normalizeMentionTags(text: string, members: RoutableMember[]): string {
  if (!text.includes('<mention')) return text;
  const ranges = protectedRanges(text);
  const tag = /<mention\b([^>]*?)\/?>(?:\s*<\/mention>)?/giu;
  const attr = (src: string, key: string): string | undefined =>
    new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu').exec(src)?.slice(1).find((v) => v !== undefined);
  return text.replace(tag, (all, attrs: string, offset: number) => {
    if (ranges.some(([a, b]) => offset >= a && offset < b)) return all;
    const id = attr(attrs, 'id');
    const byId = id ? members.find((m) => m.id === id) : undefined;
    const name = (byId?.name ?? attr(attrs, 'name') ?? '').replace(/^[@＠]/u, '').replace(/"/g, '').trim();
    if (!name) return all;
    const prev = offset > 0 ? text[offset - 1] : undefined;
    return `${prev !== undefined && EMAIL_PREV.test(prev) ? ' ' : ''}@"${name}"`;
  });
}

/** 只返回点名结果（不含 token 位置）。 */
export function parseMentions(rawText: string, members: RoutableMember[]): MentionParseResult {
  const text = normalizeMentionTags(rawText, members);
  const r = parseMentionTokens(text, members);
  return { memberIds: r.memberIds, unknown: r.unknown, body: r.body, hasMention: r.hasMention };
}
