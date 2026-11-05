/** 借用 Ekko 逻辑的隔离（third_party/ekko/BORROWED.md）：只能经 borrowed/ekko.ts 引用；借来的函数按 Aroomo 的用法工作。 */
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { handoffAllowed, HANDOFF_DEPTH_CAP, nextCronAt, notificationText, stripToolMarkup } from '../src/borrowed/ekko.js';

const CORE = fileURLToPath(new URL('..', import.meta.url));

describe('借用代码隔离：ESLint no-restricted-imports', () => {
  const eslint = new ESLint({ cwd: CORE });
  const lint = async (filePath: string, code: string) =>
    (await eslint.lintText(code, { filePath: `${CORE}${filePath}` }))[0]!.messages.filter((m) => m.ruleId === 'no-restricted-imports');

  it('业务代码直接 import third_party/ekko → lint 失败', async () => {
    const msgs = await lint('src/assistants/x.ts', "import { stripToolCallMarkup } from '../third_party/ekko/tool-call-markup.js';\nexport const f = stripToolCallMarkup;\n");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.message).toContain('borrowed/ekko.ts');
  });

  it('测试代码直接 import 也失败', async () => {
    expect(await lint('test/x.test.ts', "import '../src/third_party/ekko/schedule.js';\n")).toHaveLength(1);
  });

  it('只有 src/borrowed/ekko.ts 可以引用', async () => {
    expect(await lint('src/borrowed/ekko.ts', "export { stripToolCallMarkup } from '../third_party/ekko/tool-call-markup.js';\n")).toHaveLength(0);
  });
});

describe('borrowed/ekko.ts', () => {
  it('nextCronAt：每天 09:00（上海）在 08:00 之后是当天 09:00，09:00 本身之后是第二天', () => {
    expect(nextCronAt('0 9 * * *', 'Asia/Shanghai', new Date('2026-11-05T08:00:00+08:00')).toISOString()).toBe('2026-11-05T01:00:00.000Z');
    expect(nextCronAt('0 9 * * *', 'Asia/Shanghai', new Date('2026-11-05T09:00:00+08:00')).toISOString()).toBe('2026-11-06T01:00:00.000Z');
    // 每周一 09:00（2026-11-09 是周一）
    expect(nextCronAt('0 9 * * 1', 'Asia/Shanghai', new Date('2026-11-05T14:00:00+08:00')).toISOString()).toBe('2026-11-09T01:00:00.000Z');
  });

  it('转交深度上限 4', () => {
    expect(HANDOFF_DEPTH_CAP).toBe(4);
    expect(handoffAllowed(3)).toBe(true);
    expect(handoffAllowed(4)).toBe(false);
  });

  it('去掉漏出来的工具调用标记，代码块原样保留', () => {
    // 只认行首的协议块（行内的字样可能是正文在讨论它）
    expect(stripToolMarkup('结果如下\n<tool_call>{"name":"x"}</tool_call>\n完毕')).toBe('结果如下\n\n完毕');
    expect(stripToolMarkup('a\n<function_calls>\n<invoke name="x">\n</invoke>\n</function_calls>\nb')).toBe('a\n\nb');
    const code = '```\n<tool_call>x</tool_call>\n```';
    expect(stripToolMarkup(code)).toBe(code);
  });

  it('通知文字：去 Markdown，正文不超过 160 个字', () => {
    const t = notificationText('**资源周报**', `# 标题\n${'找'.repeat(300)}`);
    expect(t.title).toBe('资源周报');
    expect(Array.from(t.body)).toHaveLength(160);
    expect(t.body.endsWith('…')).toBe(true);
  });
});
