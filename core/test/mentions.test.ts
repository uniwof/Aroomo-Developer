import { describe, expect, it } from 'vitest';
import { parseMentions } from '../src/router/mentions.js';
import type { RoutableMember } from '../src/router/types.js';

const members: RoutableMember[] = [
  { id: 'gemini', name: 'Gemini', enabled: true },
  { id: 'gemini-pro', name: 'Gemini 2.5 Pro', aliases: ['gpro'], enabled: true },
  { id: 'groq', name: 'Groq', enabled: true },
  { id: 'gpt41', name: 'gpt-4.1', enabled: true },
];

describe('parseMentions', () => {
  it('没有 @ 时不算点名', () => {
    const r = parseMentions('帮我写一封邮件', members);
    expect(r).toEqual({ memberIds: [], unknown: [], body: '帮我写一封邮件', hasMention: false });
  });

  it('识别单个点名并去掉 @ 部分', () => {
    const r = parseMentions('@Groq 翻译这句话', members);
    expect(r.memberIds).toEqual(['groq']);
    expect(r.body).toBe('翻译这句话');
    expect(r.hasMention).toBe(true);
  });

  it('大小写不敏感，最长匹配优先', () => {
    const r = parseMentions('@gemini 2.5 pro 你好', members);
    expect(r.memberIds).toEqual(['gemini-pro']);
    expect(r.body).toBe('你好');
  });

  it('多个点名按出现顺序去重', () => {
    const r = parseMentions('@Groq @gpro 比较一下 @groq', members);
    expect(r.memberIds).toEqual(['groq', 'gemini-pro']);
  });

  it('全角＠和中文标点边界', () => {
    const r = parseMentions('＠Groq，你怎么看？', members);
    expect(r.memberIds).toEqual(['groq']);
    expect(r.body).toBe('，你怎么看？');
  });

  it('名字中的英文句点不被当成边界，句末句点可以', () => {
    expect(parseMentions('@gpt-4.1 hi', members).memberIds).toEqual(['gpt41']);
    expect(parseMentions('ask @Groq.', members).memberIds).toEqual(['groq']);
  });

  it('前缀不误匹配', () => {
    const r = parseMentions('@Groqq 在吗', members);
    expect(r.memberIds).toEqual([]);
    expect(r.unknown).toEqual(['Groqq']);
    expect(r.hasMention).toBe(true);
  });

  it('邮箱不算点名', () => {
    const r = parseMentions('发到 a@groq.com', members);
    expect(r.hasMention).toBe(false);
    expect(r.body).toBe('发到 a@groq.com');
  });

  it('孤立的 @ 不算点名', () => {
    expect(parseMentions('@ 你好', members).hasMention).toBe(false);
  });

  it('LobeHub 提及标签与手打 @ 等效（#210）', () => {
    const a = parseMentions('<mention name="@Groq" id="agt_1"/> 翻译这句话', members);
    expect(a.memberIds).toEqual(['groq']);
    expect(a.body).toBe('翻译这句话');
    const b = parseMentions('你好 <mention name="@Gemini 2.5 Pro" id="x"/>，帮忙看看', members);
    expect(b.memberIds).toEqual(['gemini-pro']);
    const c = parseMentions('<mention name="@gpro" id="x"></mention> hi', members);
    expect(c.memberIds).toEqual(['gemini-pro']);
  });

  it('提及标签匹配不到成员记为 unknown；代码块里的标签不动', () => {
    const r = parseMentions('<mention name="@gemini-38flash" id="agt_9"/> 在吗', members);
    expect(r.unknown).toEqual(['gemini-38flash']);
    const code = parseMentions('`<mention name="@Groq" id="1"/>` 这是代码', members);
    expect(code.hasMention).toBe(false);
  });
});
