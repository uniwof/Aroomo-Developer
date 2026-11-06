/**
 * 开关必须是一个个顶层常量（#323 负责人第二轮的发现）：构建器不内联对象属性，写成 FLAGS.x 时关着的功能照样进对话页包。
 * 这里只核源码写法；构建后的核对见 scripts/check-flags-shaken.mjs（check-chat-size.mjs 会调用）。
 */
import { describe, expect, it } from 'vitest';
import * as F from '@/lib/flags';
// @ts-expect-error 构建脚本是 .mjs，没有类型
import { readFlags } from '../scripts/check-flags-shaken.mjs';

describe('功能开关的写法', () => {
  it('flags.ts 只导出布尔常量，没有对象', () => {
    for (const [k, v] of Object.entries(F)) expect([k, typeof v]).toEqual([k, 'boolean']);
  });
  it('构建核对脚本读到的开关和模块导出一致（含 work-flag.ts 的 WORK）', () => {
    expect(readFlags()).toEqual({ ...F, WORK: false });
  });
});
