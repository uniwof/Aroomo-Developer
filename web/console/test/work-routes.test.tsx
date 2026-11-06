/**
 * /work 切片 1 路由（docs/api/design-work-v1.md）：开关 WORK 打开时 /work、/work/<项目>、/work/<项目>?v=<版本> 各自有地址，
 * 来回换算一致；只给所有者（家人落到对话）。开关关着的情况见 work-flag-off.test.tsx（真开关，不 mock）。
 */
import { describe, expect, it, vi } from 'vitest';
import { OWNER_ONLY, pathOf, viewOf } from '@/chat/routes';

vi.mock('@/lib/work-flag', () => ({ WORK: true }));
vi.mock('@/lib/flags', () => ({ TASK_CARDS: false, QUICK_REPLIES: false, CONV_FILTER: false, SCHEDULE_PAGE: false, ASSISTANT_DRAFT: false, ASSISTANTS: false, SAVED_CHATS: false, SKELETON_SHIMMER: false }));

describe('/work 的地址（开关开）', () => {
  it('项目列表、版本时间线、版本详情来回换算一致', () => {
    expect(viewOf('/work', '')).toEqual({ kind: 'work' });
    expect(pathOf({ kind: 'work' })).toBe('/work');
    expect(viewOf('/work/p%201', '')).toEqual({ kind: 'work', project: 'p 1' });
    expect(pathOf({ kind: 'work', project: 'p 1' })).toBe('/work/p%201');
    expect(viewOf('/work/p1', '?v=v%202')).toEqual({ kind: 'work', project: 'p1', version: 'v 2' });
    expect(pathOf({ kind: 'work', project: 'p1', version: 'v 2' })).toBe('/work/p1?v=v%202');
    // 末尾斜杠照常认；多一层路径不是 /work 的地址
    expect(viewOf('/work/', '')).toEqual({ kind: 'work' });
    expect(viewOf('/work/p1/x', '')).toEqual({ kind: 'chat' });
  });
  it('只给所有者', () => {
    expect(OWNER_ONLY).toContain('work');
  });
});
