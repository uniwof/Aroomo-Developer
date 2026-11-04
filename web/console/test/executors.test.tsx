import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Executors, ago } from '../src/pages/Executors';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('本机执行员页', () => {
  it('显示在线/离线与任务，吊销要先确认', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/executors')
          return new Response(JSON.stringify({ executors: [{ id: 'e1', clientId: 'c1', deviceName: '书房电脑', platform: 'win32', version: '0.1', adapters: [], lastSeenAt: new Date().toISOString(), online: true }] }));
        if (url === '/api/tasks')
          return new Response(JSON.stringify({ tasks: [{ id: 't1', kind: 'checkin', site: 'https://a.example', status: 'running', lastStage: 'x', lastMessage: '正在打开页面', resultSummary: null, resultError: null, createdAt: new Date().toISOString() }] }));
        return new Response(null, { status: 204 });
      }),
    );
    render(<Executors />);
    await screen.findByText('书房电脑');
    expect(screen.getByText('● 在线')).toBeTruthy();
    expect(screen.getByText(/正在打开页面/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('吊销 书房电脑'));
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    fireEvent.click(await screen.findByText('确认吊销'));
    await screen.findByText(/已吊销/);
    expect(calls).toContain('DELETE /api/clients/c1');
  });
  it('相对时间', () => {
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 分钟前');
  });
});
