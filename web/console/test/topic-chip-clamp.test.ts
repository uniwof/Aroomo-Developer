/**
 * #317：顶栏话题胶囊最多两行，超出加省略号（只这一个；会话列表照样显示全名）。
 * 读屏名字里带完整标题。line-clamp 同时写 text-overflow: ellipsis，ui-e2e 的切字检查才不当成切字。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/chat/chat.css', 'utf8');
const rule = (sel: string) => {
  const m = new RegExp(`(^|\\n)${sel.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css);
  return m ? m[2]! : '';
};

describe('#317 顶栏话题胶囊限两行', () => {
  it('话题胶囊文字：两行 + 省略号', () => {
    const r = rule('.topic-text');
    expect(r).toMatch(/-webkit-line-clamp:\s*2;/);
    expect(r).toMatch(/line-clamp:\s*2;/);
    expect(r).toMatch(/overflow:\s*hidden;/);
    expect(r).toMatch(/text-overflow:\s*ellipsis;/);
  });
  it('会话列表的标题不截断，照样全名', () => {
    expect(rule('.pop-topic-title')).not.toMatch(/line-clamp|ellipsis/);
  });
  it('读屏名字里带完整标题', () => {
    const src = readFileSync('src/chat/ChatPage.tsx', 'utf8');
    expect(src).toMatch(/className="topic-chip hit"[^>]*aria-label=\{`话题：\$\{current\.messages\.length \? current\.title : '新话题'\}/);
  });
});
