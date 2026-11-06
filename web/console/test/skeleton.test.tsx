import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { App } from '@/App';
import { AppSkeleton } from '@/components/Skeleton';
import { COOKIE_SESSION, session } from '@/lib/api';
import { SKELETON_SHIMMER } from '@/lib/flags';

const indexHtml = readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');

describe('打开对话页的骨架屏（所有者 11-05）', () => {
  it('index.html 里的静态骨架和 React 画的骨架逐字一致（JS 接手时不跳）', () => {
    const m = indexHtml.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(renderToStaticMarkup(<AppSkeleton shimmer={false} />));
  });

  it('读屏：外层 aria-busy，里面一句「正在打开对话」，灰块全部 aria-hidden', () => {
    const { container } = render(<AppSkeleton />);
    const root = container.querySelector('[data-skeleton]')!;
    expect(root.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status')).toHaveTextContent('正在打开对话');
    for (const el of Array.from(root.children)) {
      if (el.getAttribute('role') === 'status') continue;
      expect(el.getAttribute('aria-hidden')).toBe('true');
    }
    // 除了那句话，没有别的可读文字
    expect(root.textContent).toBe('正在打开对话');
  });

  it('默认静态不动：开关关着，没有微光类；打开开关才加 .sk--shimmer', () => {
    expect(SKELETON_SHIMMER).toBe(false);
    const { container, rerender } = render(<AppSkeleton />);
    expect(container.querySelector('.sk--shimmer')).toBeNull();
    rerender(<AppSkeleton shimmer />);
    expect(container.querySelector('.sk.sk--shimmer')).not.toBeNull();
  });

  it('对话页包还在下载时显示骨架，不再是「正在打开对话…」一行字', async () => {
    session.set(COOKIE_SESSION);
    try {
      const { container } = render(
        <MemoryRouter initialEntries={['/chat']}>
          <App />
        </MemoryRouter>,
      );
      expect(container.querySelector('[data-skeleton]')).not.toBeNull();
      expect(screen.queryByText('正在打开对话…')).toBeNull();
      // 包到了：骨架换成真正的对话页
      expect(await screen.findByLabelText('输入消息', {}, { timeout: 15000 })).toBeInTheDocument();
      expect(container.querySelector('[data-skeleton]')).toBeNull();
    } finally {
      session.set(null);
    }
  }, 20000);
});
