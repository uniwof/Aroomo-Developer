/**
 * 头像（2026-11-04 所有者：界面完全照 sumus，头像用我们自己画的同类风格彩色方块小图形）。
 * 做法照 sumus：没有底色方块，直接是一个纯色的几何小身体 + 两个深色小眼睛；颜色取黄 / 蓝 / 粉 / 青 / 绿 / 紫。
 * 图形全是我们自己画的（拱门、台阶、圆角方、胶囊、T 形、圆），不用 sumus 的小人文件、标志或任何图片。
 * 负责人固定用黄色拱门；群聊是浅蓝底「#」；你自己是浅灰底首字。头像只是装饰：aria-hidden，名字由旁边的文字读出。
 */
export const TONES = 6;

export function toneOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % TONES;
}

/** 六种身体（40×40 画布），颜色和图形一一对应 */
const COLORS = ['#ffd23f', '#4f8ef7', '#f7748c', '#4cc8e6', '#43cf9c', '#a98bfa'];
const BODIES = [
  // 黄：拱门
  <path key="a" d="M8 33V19a12 12 0 0 1 24 0v14z" />,
  // 蓝：台阶（左高右低两块）
  <path key="s" d="M6 15a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v6h8a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z" />,
  // 粉：圆角方
  <rect key="r" x="8" y="10" width="24" height="22" rx="5" />,
  // 青：胶囊
  <rect key="p" x="5" y="14" width="30" height="16" rx="8" />,
  // 绿：T 形
  <path key="t" d="M7 13a3 3 0 0 1 3-3h20a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3h-5v9a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-9h-5a3 3 0 0 1-3-3z" />,
  // 紫：圆
  <circle key="c" cx="20" cy="21" r="12" />,
];
/** 每种身体的两只眼睛位置 */
const EYES: [number, number][] = [
  [16, 22],
  [12, 18],
  [17, 19],
  [16, 21],
  [17, 15],
  [17, 19],
];

export type AvatarKind = 'lead' | 'member' | 'group' | 'user';
export type AvatarSize = 'xs' | 'sm' | 'msg' | 'md' | 'lg';

export function Figure({ tone }: { tone: number }) {
  const t = ((tone % TONES) + TONES) % TONES;
  const [x, y] = EYES[t]!;
  return (
    <svg viewBox="5 6 30 30" className="av-fig" aria-hidden="true">
      <g fill={COLORS[t]}>{BODIES[t]}</g>
      <circle cx={x} cy={y} r="1.7" fill="#262626" />
      <circle cx={x + 6} cy={y} r="1.7" fill="#262626" />
    </svg>
  );
}

/** 旧接口：只要图形（额度圆环头像在用） */
export function Shape({ name }: { name: string }) {
  return <Figure tone={toneOf(name)} />;
}

export function Avatar({ name, kind = 'member', size = 'md', off = false }: { name: string; kind?: AvatarKind; size?: AvatarSize; off?: boolean }) {
  const cls = `av av-${size}${off ? ' av-off' : ''}`;
  if (kind === 'user')
    return (
      <span className={`${cls} av-user`} aria-hidden="true">
        {Array.from(name.trim())[0] ?? '我'}
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
      {/* 黄色拱门只给负责人；成员从其余五种里按名字取 */}
      <Figure tone={kind === 'lead' ? 0 : 1 + (toneOf(name) % (TONES - 1))} />
    </span>
  );
}
