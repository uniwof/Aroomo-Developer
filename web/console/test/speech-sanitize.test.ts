import { describe, expect, it } from 'vitest';
import { speakableText } from '../src/chat/speech';

// CodeQL js/incomplete-multi-character-sanitization：去 HTML 标签要反复去到不再变
describe('朗读文字去 HTML 标签', () => {
  it('嵌套拼出来的标签也去干净', () => {
    expect(speakableText('前<<b>script>alert(1)<</b>/script>后')).toBe('前alert(1)后');
    expect(speakableText('<<i>b>粗</b>')).toBe('粗');
  });
  it('普通标签照旧去掉，比较符号不动', () => {
    expect(speakableText('<b>你好</b>，1 < 2')).toBe('你好，1 < 2');
  });
});
