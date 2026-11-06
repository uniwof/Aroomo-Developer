import { describe, expect, it } from 'vitest';
import { pathOf, viewOf } from '@/chat/routes';
import { SETTINGS_SECTIONS } from '@/chat/panels';

// bug：点「推送提醒」落到对话——/settings/push 不在路由的分区名单里。设置里每个分区都要能用地址打开、刷新不丢。
describe('设置分区的地址', () => {
  it('/settings/push 打开推送提醒', () => {
    expect(viewOf('/settings/push', '')).toEqual({ kind: 'settings', section: 'push' });
  });
  it('设置里每个分区都能来回换算', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(viewOf(pathOf({ kind: 'settings', section: s.id }), '')).toEqual({ kind: 'settings', section: s.id });
    }
  });
  it('不认识的分区仍落到对话', () => {
    expect(viewOf('/settings/nope', '')).toEqual({ kind: 'chat' });
  });
});
