/**
 * 点名解析的表驱动测试（Issue #8：≥30 个用例，含中英文混排、全角标点、emoji）。
 */
import { describe, expect, it } from 'vitest';
import { parseMentions, parseMentionTokens } from '../src/router/mentions.js';
import type { RoutableMember } from '../src/router/types.js';

const members: RoutableMember[] = [
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'gemini-pro', name: 'Gemini 2.5 Pro', aliases: ['gpro'], enabled: true },
  { id: 'groq', name: 'Groq', enabled: true },
  { id: 'gpt41', name: 'gpt-4.1', enabled: true },
  { id: 'qwen', name: '通义千问', aliases: ['千问'], enabled: true },
  { id: 'inci', name: 'İnci', enabled: true },
  { id: 'claude', name: 'Claude', aliases: ['克劳德'], enabled: true },
];

interface Case {
  name: string;
  text: string;
  ids: string[];
  unknown?: string[];
  body?: string;
  has?: boolean;
}

const cases: Case[] = [
  // —— 基础 ——
  { name: '无 @', text: '写一封邮件', ids: [], body: '写一封邮件', has: false },
  { name: '单个点名', text: '@Groq 翻译', ids: ['groq'], body: '翻译' },
  { name: '多个点名去重', text: '@Groq @Claude @groq 比较', ids: ['groq', 'claude'], body: '比较' },
  { name: '句中点名', text: '请 @Claude 看看', ids: ['claude'], body: '请 看看' },
  { name: '句末点名', text: '看看这个 @Groq', ids: ['groq'], body: '看看这个' },
  // —— 引号名 ——
  { name: '英文双引号', text: '@"Gemini 2.5 Pro" 你好', ids: ['gemini-pro'], body: '你好' },
  { name: '直角引号', text: '@「Gemini 2.5 Pro」你好', ids: ['gemini-pro'], body: '你好' },
  { name: '中文弯引号', text: '@“gemini 2.5 pro” 你好', ids: ['gemini-pro'], body: '你好' },
  { name: '书名号式引号', text: '@『通义千问』帮忙', ids: ['qwen'], body: '帮忙' },
  { name: '引号内未知名', text: '@"Llama 3" 在吗', ids: [], unknown: ['Llama 3'], body: '在吗' },
  { name: '引号不闭合按普通名处理', text: '@"Groq 你好', ids: [], unknown: [], body: '@"Groq 你好', has: false },
  // —— 行首 / 换行 ——
  { name: '换行后的 @', text: '第一行\n@Groq 第二行', ids: ['groq'], body: '第一行\n第二行' },
  { name: '多行各自点名', text: '@Groq 甲\n@Claude 乙', ids: ['groq', 'claude'], body: '甲\n乙' },
  // —— 代码 ——
  { name: '行内代码里的 @ 不算', text: '运行 `npm i @types/node` 就行', ids: [], body: '运行 `npm i @types/node` 就行', has: false },
  { name: '代码块里的 @ 不算', text: '```ts\n@Groq decorator\n```', ids: [], has: false },
  { name: '代码块外的 @ 仍算，代码块原样保留', text: '@Claude 看下\n```py\n@property\ndef x(): pass\n```', ids: ['claude'], body: '看下\n```py\n@property\ndef x(): pass\n```' },
  { name: '波浪线代码块', text: '~~~\n@Groq\n~~~\n@Groq 解释', ids: ['groq'], body: '~~~\n@Groq\n~~~\n解释' },
  { name: '双反引号行内代码', text: '``a @Groq b`` 是什么', ids: [], has: false },
  // —— URL / 邮箱 ——
  { name: 'URL 里的 @', text: '看 https://x.com/@Groq 这条', ids: [], body: '看 https://x.com/@Groq 这条', has: false },
  { name: 'www URL 里的 @', text: 'www.example.com/@claude/post', ids: [], has: false },
  { name: 'URL 后面的点名仍算', text: 'https://a.com/@x @Groq 总结', ids: ['groq'], body: 'https://a.com/@x 总结' },
  { name: '邮箱不算', text: '发到 me@groq.com', ids: [], has: false },
  // —— 大小写 / Unicode ——
  { name: '大小写不敏感', text: '@CLAUDE hi', ids: ['claude'], body: 'hi' },
  { name: 'İ 小写后变长，索引仍正确', text: '@İnci 你好', ids: ['inci'], body: '你好' },
  { name: '前文含 İ 不影响后面的点名', text: 'İstanbul İzmir @Groq hi', ids: ['groq'], body: 'İstanbul İzmir hi' },
  { name: '用小写 i 写 İnci 不匹配（不同字符）', text: '@inci hi', ids: [], unknown: ['inci'] },
  // —— 前缀冲突 ——
  { name: '最长匹配：Gemini 2.5 Pro', text: '@Gemini 2.5 Pro 写诗', ids: ['gemini-pro'], body: '写诗' },
  { name: '只写 Gemini 匹配短名', text: '@Gemini 2.0 写诗', ids: ['gemini'], body: '2.0 写诗' },
  { name: '前缀不误匹配', text: '@Groqq 在吗', ids: [], unknown: ['Groqq'] },
  { name: '名字里的点', text: '@gpt-4.1 hi', ids: ['gpt41'], body: 'hi' },
  { name: '句末英文句点是边界', text: 'ask @Groq.', ids: ['groq'] },
  // —— 中英文混排 / 全角标点 / emoji ——
  { name: '全角＠', text: '＠Groq，你怎么看？', ids: ['groq'], body: '，你怎么看？' },
  { name: '拉丁名后紧跟中文', text: '@Groq你好', ids: ['groq'], body: '你好' },
  { name: '中文名后紧跟中文', text: '@千问帮我写', ids: ['qwen'], body: '帮我写' },
  { name: '中文名最长匹配', text: '@通义千问 你好', ids: ['qwen'], body: '你好' },
  { name: '中文别名', text: '@克劳德：解释一下', ids: ['claude'], body: '：解释一下' },
  { name: 'emoji 紧跟名字', text: '@Groq😀 早', ids: ['groq'], body: '😀 早' },
  { name: 'emoji 在前', text: '🎉@Claude 恭喜', ids: ['claude'], body: '🎉 恭喜' },
  { name: '全角空格分隔', text: '@Groq　你好', ids: ['groq'], body: '你好' },
  { name: '中文顿号分隔多个点名', text: '@Groq、@Claude 都来', ids: ['groq', 'claude'], body: '、 都来' },
  { name: '括号里的点名', text: '（@Claude）看看', ids: ['claude'], body: '（）看看' },
  { name: '孤立的 @', text: '@ 你好', ids: [], has: false },
  { name: '连续 @@', text: '@@Groq', ids: ['groq'] },
];

describe('parseMentions 表驱动', () => {
  it('用例数 ≥ 30', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases)('$name', (c) => {
    const r = parseMentions(c.text, members);
    expect(r.memberIds).toEqual(c.ids);
    if (c.unknown) expect(r.unknown).toEqual(c.unknown);
    if (c.body !== undefined) expect(r.body).toBe(c.body);
    expect(r.hasMention).toBe(c.has ?? (c.ids.length > 0 || (c.unknown?.length ?? 0) > 0));
  });
});

describe('parseMentionTokens', () => {
  it('token 的位置指向原文（含 İ 的情况）', () => {
    const text = 'İİ @İnci 和 @"Gemini 2.5 Pro" 以及 @Nobody';
    const { tokens } = parseMentionTokens(text, members);
    expect(tokens.map((t) => [t.kind, t.raw, t.memberId ?? null, t.quoted])).toEqual([
      ['member', '@İnci', 'inci', false],
      ['member', '@"Gemini 2.5 Pro"', 'gemini-pro', true],
      ['unknown', '@Nobody', null, false],
    ]);
    for (const t of tokens) expect(text.slice(t.start, t.end)).toBe(t.raw);
  });
});
