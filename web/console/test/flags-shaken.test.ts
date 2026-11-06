/**
 * 开关摇树核对的名单（工单 #327，负责人 #326 审查的建议）：
 * - 每个开关要么在 MARKERS（构建后查它的标志文字不在对话页包里），要么在 NO_MARKER（写一句为什么不查），两边都没有就失败。
 * - WORK 的标志不能被 /workspace、/workflow 这类字样误判。
 * - ASSISTANTS 关着时 lib/assistants 不进对话页包（构建后由 MARKERS.ASSISTANTS 核对）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 构建脚本是 .mjs，没有类型
import { MARKERS, NO_MARKER, findLeaks, readFlags, uncovered } from '../scripts/check-flags-shaken.mjs';

describe('每个开关都被核对，或写明为什么不查', () => {
  it('现在的开关全有着落', () => {
    expect(uncovered(readFlags())).toEqual([]);
  });
  it('新加一个开关、两份名单都没写，就报出来', () => {
    expect(uncovered({ ...readFlags(), NEW_FLAG: false })).toEqual(['NEW_FLAG']);
  });
  it('NO_MARKER 每条都有原因，不和 MARKERS 重复，也不留已删掉的开关', () => {
    const flags = readFlags();
    for (const [k, why] of Object.entries(NO_MARKER as Record<string, string>)) {
      expect([k, typeof why === 'string' && why.trim().length > 5]).toEqual([k, true]);
      expect([k, k in MARKERS]).toEqual([k, false]);
      expect([k, k in flags]).toEqual([k, true]);
    }
  });
  it('ASSISTANTS 也查：关着时助手接口代码不能进对话页包', () => {
    expect(Object.keys(MARKERS)).toContain('ASSISTANTS');
  });
  it('TASK_CARDS、QUICK_REPLIES 也查（#329）：以后谁把它们直接 import 进对话页又没加开关，当场抓到', () => {
    for (const k of ['TASK_CARDS', 'QUICK_REPLIES']) {
      expect([k, k in MARKERS, k in NO_MARKER]).toEqual([k, true, false]);
    }
    const off = { ...readFlags(), TASK_CARDS: false, QUICK_REPLIES: false };
    expect(findLeaks('<p>花多少：{c.cost}</p>', off)).toHaveLength(1);
    expect(findLeaks('"我自己写…"', off)).toHaveLength(1);
  });
});

describe('标志文字的匹配', () => {
  const off = { ...readFlags(), WORK: false };
  it('WORK 关着时，/work 路由和 /work/ 地址算漏进包', () => {
    expect(findLeaks('[`/work`,`项目`,{kind:`work`}]', off)).toHaveLength(1);
    expect(findLeaks('`/work/${encodeURIComponent(e)}`', off)).toHaveLength(1);
    expect(findLeaks('/^\\/work(?:\\/([^/]+))?$/', off)).toHaveLength(1);
  });
  it('WORK 关着时，/workspace、/workflow、/work-x 不算', () => {
    expect(findLeaks('`/workspace` `/workflow` `/work-x`', off)).toEqual([]);
  });
  it('开关打开时它的标志文字可以在包里', () => {
    expect(findLeaks('`/work`', { ...off, WORK: true })).toEqual([]);
  });
});
