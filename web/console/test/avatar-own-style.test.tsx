import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, Figure, TONES } from '@/chat/Avatar';

// 阶段 4（负责人 S1–S3）：头像换成 Aroomo 自己的图形语言，不再像 sumus 的彩色小人（纯色身体 + 两只深色眼睛、黄/蓝/粉/青/绿/紫）。
const SUMUS_LIKE = ['#ffd23f', '#4f8ef7', '#f7748c', '#4cc8e6', '#43cf9c', '#a98bfa'];

describe('头像是 Aroomo 自己的样子', () => {
  it('没有「两只深色眼睛」，也不用 sumus 那六种颜色', () => {
    for (let t = 0; t < TONES; t++) {
      const { container, unmount } = render(<Figure tone={t} />);
      const fills = [...container.querySelectorAll('[fill]')].map((e) => e.getAttribute('fill')!.toLowerCase());
      expect(fills).not.toContain('#262626');
      for (const c of SUMUS_LIKE) expect(fills).not.toContain(c);
      unmount();
    }
  });
  it('负责人用 Aroomo 珊瑚色底', () => {
    const { container } = render(<Avatar name="负责人" kind="lead" />);
    expect(container.querySelector('[data-av-tile]')!.getAttribute('fill')).toBe('#d9532a');
  });
  it('成员不和负责人撞色；头像仍只是装饰（读屏不读）', () => {
    const { container } = render(<><Avatar name="Kimi" /><Avatar name="群" kind="group" /></>);
    const tile = container.querySelector('[data-av-tile]')!;
    expect(tile.getAttribute('fill')).not.toBe('#d9532a');
    for (const s of container.querySelectorAll('.av')) expect(s.getAttribute('aria-hidden')).toBe('true');
  });
});

// 阶段 4（负责人）：照 sumus 英文翻过来的 7 条文案改成 Aroomo 自己的话
import { readFileSync } from 'node:fs';
describe('不再用照 sumus 翻译的文案', () => {
  const src = ['Thread.tsx', 'Sidebar.tsx', 'panels.tsx', 'HeaderCard.tsx', 'ChatPage.tsx'].map((f) => readFileSync(`src/chat/${f}`, 'utf8')).join('\n');
  const css = readFileSync('src/chat/chat.css', 'utf8');
  it.each(['说点什么，开始这个话题', '一件新任务…', '} 正在回复…', "'搜索对话'", '改动立即生效', '查看成员', '查看群成员', "'查看所有成员'"])('源码里没有「%s」', (t) => {
    expect(src).not.toContain(t);
  });
  it('日期分隔不再用 Georgia 斜体', () => {
    expect(css).not.toMatch(/\.msg-day\s*\{[^}]*Georgia/);
  });
});
