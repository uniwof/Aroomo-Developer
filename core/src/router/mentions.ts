/**
 * 点名解析（D31）。
 *
 * 规则：
 * - 「@」或全角「＠」开头；前一个字符是字母/数字/下划线/点时不算点名（排除 a@b.com 这类邮箱）。
 * - 位于 Markdown 代码块（```...```）、行内代码（`...`）和 URL 中的 @ 不算点名。
 * - 支持带引号的名字：@"Gemini 2.5 Pro"、@「Gemini 2.5 Pro」等。
 * - 成员名和别名大小写不敏感，按最长匹配（"Gemini 2.5 Pro" 优先于 "Gemini"）。
 * - 名字后面必须是结尾、空白或标点，避免 "@Gem" 误匹配 "@Gemini"；英文句点只有后接空白/结尾时才算边界。
 * - 匹配不到成员的 @xxx 记为 unknown（仍算点名：D31「输入里有 @ 就是点名」）。
 */
import type { MentionParseResult, RoutableMember } from './types.js';

const AT_CHARS = new Set(['@', '＠']);
const WORDISH = /[\p{L}\p{N}_.]/u;
/** 名字后允许的边界：结尾、空白、常见中英文标点 */
const BOUNDARY = /[\s,，。!！?？:：;；、)）\]】"'”’」』]/u;

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '「': '」',
  '『': '』',
  '“': '”',
  '‘': '’',
};

export interface Candidate {
  label: string;
  lower: string;
  memberId: string;
  /** 预留给 P2 能力 @（例如 kind: 'capability'） */
  kind?: 'member' | 'capability';
}

function buildCandidates(members: RoutableMember[]): Candidate[] {
  const out: Candidate[] = [];
  for (const m of members) {
    for (const label of [m.name, ...(m.aliases ?? [])]) {
      const trimmed = label.trim();
      if (trimmed) {
        out.push({
          label: trimmed,
          lower: trimmed.toLowerCase(),
          memberId: m.id,
          kind: 'member',
        });
      }
    }
  }
  // 最长优先
  out.sort((a, b) => b.lower.length - a.lower.length);
  return out;
}

interface Range {
  start: number;
  end: number;
}

/** 查找需要忽略点名的区间：Markdown 代码块、行内代码、URL */
function findIgnoredRanges(text: string): Range[] {
  const ranges: Range[] = [];

  // 1. Markdown 代码块 (```...``` 或 ~~~...~~~)
  const codeBlockRegex = /(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  const isIgnored = (idx: number) => ranges.some((r) => idx >= r.start && idx < r.end);

  // 2. 行内代码 (`...`)
  const inlineCodeRegex = /`[^`\n]+`/g;
  while ((match = inlineCodeRegex.exec(text)) !== null) {
    if (!isIgnored(match.index)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  // 3. URL (http://... 或 https://...)
  const urlRegex = /https?:\/\/[^\s<>\u4e00-\u9fa5"`]+/g;
  while ((match = urlRegex.exec(text)) !== null) {
    if (!isIgnored(match.index)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return ranges;
}

/** text[idx] 是否是名字的结束边界。英文句点只有后面是结尾或空白时才算（"@gpt-4.1" 里的点不算）。 */
function isBoundary(text: string, idx: number): boolean {
  const ch = text[idx];
  if (ch === undefined) return true;
  if (ch === '.') {
    const next = text[idx + 1];
    return next === undefined || /\s/u.test(next);
  }
  return BOUNDARY.test(ch);
}

export function parseMentions(text: string, members: RoutableMember[]): MentionParseResult {
  const candidates = buildCandidates(members);
  const ignoredRanges = findIgnoredRanges(text);
  const isIgnored = (idx: number) => ignoredRanges.some((r) => idx >= r.start && idx < r.end);

  const memberIds: string[] = [];
  const unknown: string[] = [];
  let body = '';
  let hasMention = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i] as string;
    const prev = i > 0 ? text[i - 1] : undefined;

    if (!AT_CHARS.has(ch) || (prev !== undefined && WORDISH.test(prev)) || isIgnored(i)) {
      body += ch;
      i += 1;
      continue;
    }

    const start = i + 1;
    const nextChar = text[start];
    const quoteClose = nextChar !== undefined ? QUOTE_PAIRS[nextChar] : undefined;

    // A. 带引号的点名
    if (quoteClose !== undefined) {
      const nameStart = start + 1;
      const hit = candidates.find((c) => {
        const slice = text.slice(nameStart, nameStart + c.label.length);
        return (
          slice.toLowerCase() === c.lower && text[nameStart + c.label.length] === quoteClose
        );
      });

      if (hit) {
        hasMention = true;
        if (!memberIds.includes(hit.memberId)) memberIds.push(hit.memberId);
        i = nameStart + hit.label.length + 1;
        continue;
      }

      // 尝试匹配带引号的未知点名
      const lineEnd = text.indexOf('\n', nameStart);
      const closeIdx = text.indexOf(quoteClose, nameStart);
      if (closeIdx !== -1 && (lineEnd === -1 || closeIdx < lineEnd)) {
        const token = text.slice(nameStart, closeIdx).trim();
        if (token.length > 0) {
          hasMention = true;
          if (!unknown.includes(token)) unknown.push(token);
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // B. 不带引号的点名
    const hit = candidates.find((c) => {
      const slice = text.slice(start, start + c.label.length);
      return slice.toLowerCase() === c.lower && isBoundary(text, start + c.label.length);
    });

    if (hit) {
      hasMention = true;
      if (!memberIds.includes(hit.memberId)) memberIds.push(hit.memberId);
      i = start + hit.label.length;
      continue;
    }

    // 未知点名：取到下一个边界为止
    let j = start;
    while (j < text.length && !isBoundary(text, j) && !AT_CHARS.has(text[j] as string)) {
      j += 1;
    }
    const token = text.slice(start, j);
    if (token.length === 0) {
      // 孤立的 @，不算点名
      body += ch;
      i += 1;
      continue;
    }
    hasMention = true;
    if (!unknown.includes(token)) unknown.push(token);
    i = j;
  }

  return { memberIds, unknown, body: body.replace(/\s+/g, ' ').trim(), hasMention };
}
