import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Allowlist } from '../src/components/Allowlist';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('站点白名单', () => {
  it('读取、去重保存、空=不限制', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') {
          const b = JSON.parse(String(init.body));
          bodies.push(b);
          return new Response(JSON.stringify(b));
        }
        return new Response(JSON.stringify({ sites: ['a.example'] }));
      }),
    );
    render(<Allowlist />);
    const box = (await screen.findByLabelText('站点列表')) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(box.value).toBe('a.example'));
    fireEvent.change(box, { target: { value: 'a.example\nb.example\na.example' } });
    fireEvent.click(screen.getByText('保存站点'));
    await screen.findByText(/只允许这 2 个站点/);
    expect(bodies[0]).toEqual({ sites: ['a.example', 'b.example'] });
    fireEvent.change(box, { target: { value: '' } });
    fireEvent.click(screen.getByText('保存站点'));
    await screen.findByText(/不限制站点/);
  });
});
