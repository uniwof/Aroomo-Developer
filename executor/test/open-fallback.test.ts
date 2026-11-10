import { describe, expect, it } from 'vitest';
import { openFirstWorking, type BrowserPort } from '../src/ports/browser.js';

const sess = { close: async () => undefined } as never;
const mk = (name: string, open: () => Promise<never>, avail = true): BrowserPort => ({ name, available: async () => avail, open });

describe('适配器降级（#382）', () => {
  it('第一个适配器打开挂起 → 超时后降级到第二个', async () => {
    const a = mk('ego-lite', () => new Promise(() => undefined));
    const b = mk('playwright-mcp', async () => sess);
    const r = await openFirstWorking([a, b], {}, 50);
    expect(r?.port.name).toBe('playwright-mcp');
  });
  it('打开报错 → 降级；全失败返回 null，不挂起', async () => {
    const a = mk('ego-lite', async () => {
      throw new Error('x');
    });
    expect((await openFirstWorking([a], {}, 50))).toBeNull();
  });
});
