import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/router/mentions.js';
import type { RoutableMember } from '../src/router/types.js';

const members: RoutableMember[] = [
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'gemini-pro', name: 'Gemini 2.5 Pro', aliases: ['gpro'], enabled: true },
  { id: 'groq', name: 'Groq', aliases: ['groq-bot'], enabled: true },
  { id: 'gpt41', name: 'gpt-4.1', enabled: true },
  { id: 'emoji-bot', name: 'Bot🤖', aliases: ['🤖bot'], enabled: true },
  { id: 'turkish-bot', name: 'İstanbul', enabled: true },
];

describe('parseMentions table-driven tests', () => {
  interface TestCase {
    name: string;
    input: string;
    expectedMemberIds: string[];
    expectedUnknown: string[];
    expectedBody: string;
    expectedHasMention: boolean;
  }

  const cases: TestCase[] = [
    // --- 基础点名 ---
    {
      name: '没有 @ 时不算点名',
      input: '帮我写一封邮件',
      expectedMemberIds: [],
      expectedUnknown: [],
      expectedBody: '帮我写一封邮件',
      expectedHasMention: false,
    },
    {
      name: '识别单个点名并去掉 @ 部分',
      input: '@Groq 翻译这句话',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '翻译这句话',
      expectedHasMention: true,
    },
    {
      name: '行首 @ 点名',
      input: '@Groq 你好',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '你好',
      expectedHasMention: true,
    },
    {
      name: '换行后的 @ 点名',
      input: '第一行\n@Groq 第二行内容',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '第一行 第二行内容',
      expectedHasMention: true,
    },

    // --- 大小写与最长匹配前缀冲突 ---
    {
      name: '大小写不敏感，最长匹配优先（Gemini 2.5 Pro 优先于 Gemini）',
      input: '@gemini 2.5 pro 你好',
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '你好',
      expectedHasMention: true,
    },
    {
      name: '短前缀只有在不构成完整长名时单独匹配',
      input: '@Gemini 你好',
      expectedMemberIds: ['gemini'],
      expectedUnknown: [],
      expectedBody: '你好',
      expectedHasMention: true,
    },
    {
      name: '多个点名按出现顺序去重',
      input: '@Groq @gpro 比较一下 @groq',
      expectedMemberIds: ['groq', 'gemini-pro'],
      expectedUnknown: [],
      expectedBody: '比较一下',
      expectedHasMention: true,
    },

    // --- 带引号的名字 ---
    {
      name: '双引号名字 @"Gemini 2.5 Pro"',
      input: '@"Gemini 2.5 Pro" 请回答',
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '请回答',
      expectedHasMention: true,
    },
    {
      name: '单引号名字 @\'Gemini 2.5 Pro\'',
      input: "@'Gemini 2.5 Pro' 请回答",
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '请回答',
      expectedHasMention: true,
    },
    {
      name: '中文直角引号 @「Gemini 2.5 Pro」',
      input: '@「Gemini 2.5 Pro」请回答',
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '请回答',
      expectedHasMention: true,
    },
    {
      name: '中文双角引号 @『Gemini 2.5 Pro』',
      input: '@『Gemini 2.5 Pro』请回答',
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '请回答',
      expectedHasMention: true,
    },
    {
      name: '中文双弯引号 @“Gemini 2.5 Pro”',
      input: '@“Gemini 2.5 Pro” 请回答',
      expectedMemberIds: ['gemini-pro'],
      expectedUnknown: [],
      expectedBody: '请回答',
      expectedHasMention: true,
    },
    {
      name: '带引号的未知成员 @"Unknown Model"',
      input: '@"Unknown Model" 分析数据',
      expectedMemberIds: [],
      expectedUnknown: ['Unknown Model'],
      expectedBody: '分析数据',
      expectedHasMention: true,
    },

    // --- Code Blocks & Code Inline ---
    {
      name: 'Markdown 多行代码块中的 @ 不算点名',
      input: '请看代码：\n```python\n@app.route("/")\ndef index(): pass\n```\n@Groq 解释一下',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '请看代码： ```python @app.route("/") def index(): pass ``` 解释一下',
      expectedHasMention: true,
    },
    {
      name: 'Markdown 行内代码中的 @ 不算点名',
      input: '请在终端运行 `git config @user` 然后问 @Groq',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '请在终端运行 `git config @user` 然后问',
      expectedHasMention: true,
    },

    // --- URL 里的 @ ---
    {
      name: 'URL 中的 @ (https://x.com/@user) 不算点名',
      input: '参考 https://x.com/@user/status/123 问 @Groq',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '参考 https://x.com/@user/status/123 问',
      expectedHasMention: true,
    },
    {
      name: '仅包含 URL @ 时 hasMention 为 false',
      input: '主页是 http://github.com/@aroomo',
      expectedMemberIds: [],
      expectedUnknown: [],
      expectedBody: '主页是 http://github.com/@aroomo',
      expectedHasMention: false,
    },

    // --- Unicode & 长度/索引边界 ---
    {
      name: 'Unicode toLowerCase 改变长度字符（İstanbul）处理正常，索引不偏移',
      input: '@İstanbul 你好',
      expectedMemberIds: ['turkish-bot'],
      expectedUnknown: [],
      expectedBody: '你好',
      expectedHasMention: true,
    },
    {
      name: 'Emoji 名字点名 @Bot🤖',
      input: '@Bot🤖 启动',
      expectedMemberIds: ['emoji-bot'],
      expectedUnknown: [],
      expectedBody: '启动',
      expectedHasMention: true,
    },
    {
      name: 'Emoji 别名点名 @🤖bot',
      input: '@🤖bot 启动',
      expectedMemberIds: ['emoji-bot'],
      expectedUnknown: [],
      expectedBody: '启动',
      expectedHasMention: true,
    },

    // --- 中英文混排与全角/半角标点 ---
    {
      name: '全角＠和中文标点边界',
      input: '＠Groq，你怎么看？',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: '，你怎么看？',
      expectedHasMention: true,
    },
    {
      name: '名字中的英文句点不被当成边界，句末句点可以',
      input: '请问 @gpt-4.1. 谢谢',
      expectedMemberIds: ['gpt41'],
      expectedUnknown: [],
      expectedBody: '请问 . 谢谢',
      expectedHasMention: true,
    },
    {
      name: '中文感叹号与问号边界',
      input: '@Groq！好的？@Gemini？',
      expectedMemberIds: ['groq', 'gemini'],
      expectedUnknown: [],
      expectedBody: '！好的？？',
      expectedHasMention: true,
    },

    // --- 边界与误匹配测试 ---
    {
      name: '前缀不误匹配（@Groqq 不匹配 Groq）',
      input: '@Groqq 在吗',
      expectedMemberIds: [],
      expectedUnknown: ['Groqq'],
      expectedBody: '在吗',
      expectedHasMention: true,
    },
    {
      name: '邮箱不算点名',
      input: '发到 a@groq.com',
      expectedMemberIds: [],
      expectedUnknown: [],
      expectedBody: '发到 a@groq.com',
      expectedHasMention: false,
    },
    {
      name: '孤立的 @ 不算点名',
      input: '@ 你好',
      expectedMemberIds: [],
      expectedUnknown: [],
      expectedBody: '@ 你好',
      expectedHasMention: false,
    },
    {
      name: '多个孤立的 @ 与有效点名混排',
      input: 'Email: test@example.com @ @Groq hi',
      expectedMemberIds: ['groq'],
      expectedUnknown: [],
      expectedBody: 'Email: test@example.com @ hi',
      expectedHasMention: true,
    },
    {
      name: '未知点名与已知点名混合',
      input: '@Groq @Unknown1 @Gemini @Unknown2 比较',
      expectedMemberIds: ['groq', 'gemini'],
      expectedUnknown: ['Unknown1', 'Unknown2'],
      expectedBody: '比较',
      expectedHasMention: true,
    },
  ];

  cases.forEach((tc) => {
    it(tc.name, () => {
      const res = parseMentions(tc.input, members);
      expect(res.memberIds).toEqual(tc.expectedMemberIds);
      expect(res.unknown).toEqual(tc.expectedUnknown);
      expect(res.body).toBe(tc.expectedBody);
      expect(res.hasMention).toBe(tc.expectedHasMention);
    });
  });
});
