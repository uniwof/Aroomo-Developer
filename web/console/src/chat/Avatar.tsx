/**
 * 头像：Aroomo 自己的图形语言（阶段 4 负责人 S1–S3，替换原先仿 sumus 的「彩色小身体 + 两只眼睛」）。
 * 圆角方底色块 + 一个白色几何记号；记号取自 Aroomo 标志的元素（圆、圆角方、半圆），不画脸、不画眼睛。
 * 颜色是一组偏沉的色（白记号对底 ≥3:1）；负责人固定 Aroomo 珊瑚色底 + 标志里的「圆 + 圆角方」。
 * 群聊浅珊瑚底「#」；你自己是浅灰底首字。头像只是装饰：aria-hidden，名字由旁边的文字读出。
 */
export const TONES = 6;

export function toneOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % TONES;
}

/** 0 = 负责人（珊瑚）；1–5 给成员。和记号一一对应 */
const COLORS = ['#d9532a', '#3f7d7a', '#4a5f8a', '#7a4d7a', '#6b7a2e', '#a86e12'];
const MARKS = [
  // 负责人：标志里的圆 + 圆角方
  <g key="l"><circle cx="13.5" cy="20" r="5" /><rect x="20" y="15" width="10" height="10" rx="2" /></g>,
  // 圆环
  <path key="o" fillRule="evenodd" d="M20 11a9 9 0 1 1 0 18a9 9 0 1 1 0-18zm0 4.5a4.5 4.5 0 1 0 0 9a4.5 4.5 0 1 0 0-9z" />,
  // 半圆
  <path key="h" d="M11 23a9 9 0 0 1 18 0z" />,
  // 菱形
  <rect key="d" x="14" y="14" width="12" height="12" rx="2" transform="rotate(45 20 20)" />,
  // 两道横条
  <g key="b"><rect x="11" y="13.5" width="18" height="5" rx="2.5" /><rect x="11" y="21.5" width="12" height="5" rx="2.5" /></g>,
  // 四分之一圆
  <path key="q" d="M12 12a16 16 0 0 1 16 16H12z" />,
];

export type AvatarKind = 'lead' | 'member' | 'group' | 'user';
export type AvatarSize = 'xs' | 'sm' | 'msg' | 'md' | 'lg';

export function Figure({ tone }: { tone: number }) {
  const t = ((tone % TONES) + TONES) % TONES;
  return (
    <svg viewBox="0 0 40 40" className="av-fig" aria-hidden="true">
      <rect data-av-tile="" width="40" height="40" fill={COLORS[t]} />
      <g fill="#ffffff">{MARKS[t]}</g>
    </svg>
  );
}

/** 旧接口：只要图形（额度圆环头像在用） */
export function Shape({ name }: { name: string }) {
  return <Figure tone={toneOf(name)} />;
}

/** glyph：成员自己挑的头像（1–2 个字或表情，Poke §4）；有就用和「我」一样的文字头像显示，不加新样式 */
export function Avatar({ name, kind = 'member', size = 'md', off = false, glyph }: { name: string; kind?: AvatarKind; size?: AvatarSize; off?: boolean; glyph?: string | null | undefined }) {
  const cls = `av av-${size}${off ? ' av-off' : ''}`;
  if (kind === 'user' || (kind === 'member' && glyph))
    return (
      <span className={`${cls} av-user`} aria-hidden="true">
        {kind === 'member' ? glyph : (Array.from(name.trim())[0] ?? '我')}
      </span>
    );
  if (kind === 'group')
    return (
      <span className={`${cls} av-group`} aria-hidden="true">
        #
      </span>
    );
  return (
    <span className={cls} aria-hidden="true">
      {/* 珊瑚色只给负责人；成员从其余五种里按名字取 */}
      <Figure tone={kind === 'lead' ? 0 : 1 + (toneOf(name) % (TONES - 1))} />
    </span>
  );
}
