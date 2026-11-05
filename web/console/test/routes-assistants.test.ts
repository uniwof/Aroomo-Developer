import { describe, expect, it } from 'vitest';
import { OWNER_ONLY, pathOf, viewOf } from '@/chat/routes';

// integrate/stage2 并入 #273 路由：助手详情、全部计划也有自己的地址（刷新、前进后退不丢），家人打开落到对话
describe('助手的地址', () => {
  it('详情 /assistants?assistant=<id>、全部计划 /assistants/schedule，来回换算一致', () => {
    expect(pathOf({ kind: 'assistant', id: 'a 1' })).toBe('/assistants?assistant=a%201');
    expect(viewOf('/assistants', '?assistant=a%201')).toEqual({ kind: 'assistant', id: 'a 1' });
    expect(pathOf({ kind: 'schedule' })).toBe('/assistants/schedule');
    expect(viewOf('/assistants/schedule', '')).toEqual({ kind: 'schedule' });
    expect(viewOf('/assistants', '')).toEqual({ kind: 'chat' });
  });
  it('只给所有者', () => {
    expect(OWNER_ONLY).toContain('assistant');
    expect(OWNER_ONLY).toContain('schedule');
  });
});
