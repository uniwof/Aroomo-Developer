/**
 * 落地方案 v2 阶段 0 验收：只有图标的按钮都要有读屏名字（aria-label / aria-labelledby / 可见文字）。
 * 打开对话页、新建菜单、设置弹窗各扫一遍。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatPage } from '@/chat/ChatPage';

function unnamed(root: ParentNode = document.body): string[] {
  return [...root.querySelectorAll<HTMLElement>('button, [role="button"], a[href], [role="radio"], [role="switch"], [role="tab"]')]
    .filter((el) => !el.closest('[aria-hidden="true"]'))
    .filter((el) => {
      if (el.getAttribute('aria-label')?.trim()) return false;
      const by = el.getAttribute('aria-labelledby');
      if (by && by.split(/\s+/).some((id) => document.getElementById(id)?.textContent?.trim())) return false;
      return !(el.textContent ?? '').trim();
    })
    .map((el) => el.outerHTML.slice(0, 120));
}

describe('读屏名字', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/members'
          ? new Response(JSON.stringify({ members: [{ id: 'm1', name: 'Kimi', aliases: [], capabilityTags: [], enabled: true, pinned: false, status: 'active', leadEligible: true }] }), { status: 200 })
          : new Response('{}', { status: 404 }),
      ),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('对话页、新建菜单、设置弹窗里，每个按钮都有读屏名字', async () => {
    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>,
    );
    await screen.findByRole('navigation', { name: '分类' });
    expect(unnamed()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    await screen.findByRole('button', { name: '和 Kimi 开新对话' });
    expect(unnamed()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const dlg = screen.getByRole('dialog', { name: '设置' });
    expect(unnamed(dlg)).toEqual([]);
  });
});
