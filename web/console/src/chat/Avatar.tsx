/**
 * 方形头像：浅色底 + 一个我们自己画的简单几何图形（圆、半圆、菱形、三条、拱形、角形、双圆；按名字固定取一种）。
 * 只照 sumus「彩色方块头像」的做法，不用它的小人形象、标志或任何图片。
 * 负责人用 Aroomo 标志；你自己是「我」；群聊是「#」。头像只是装饰：aria-hidden，名字由旁边的文字读出。
 */
import { Logo } from '@/components/brand';

export const TONES = 7;

export function toneOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h % TONES;
}

/** 7 种几何图形（24×24 画布，填充用 currentColor = 这一色调的深色） */
const SHAPES = [
  <circle key="c" cx="12" cy="12" r="7" />,
  <path key="h" d="M4 15a8 8 0 0 1 16 0z" />,
  <path key="d" d="M12 4l8 8-8 8-8-8z" />,
  <g key="b">
    <rect x="5" y="6" width="14" height="3" rx="1.5" />
    <rect x="5" y="11" width="14" height="3" rx="1.5" />
    <rect x="5" y="16" width="9" height="3" rx="1.5" />
  </g>,
  <path key="a" d="M5 20V12a7 7 0 0 1 14 0v8h-4v-8a3 3 0 0 0-6 0v8z" />,
  <path key="k" d="M5 5h14v5H10v9H5z" />,
  <g key="o">
    <circle cx="8.5" cy="12" r="4.5" />
    <circle cx="15.5" cy="12" r="4.5" opacity="0.6" />
  </g>,
];

export type AvatarKind = 'lead' | 'member' | 'group' | 'user';

export function Shape({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" className="av-shape" fill="currentColor" aria-hidden="true">
      {SHAPES[toneOf(name + '·') % SHAPES.length]}
    </svg>
  );
}

export function Avatar({ name, kind = 'member', size = 'md', off = false }: { name: string; kind?: AvatarKind; size?: 'sm' | 'md' | 'lg'; off?: boolean }) {
  const cls = `av av-${size}${off ? ' av-off' : ''}`;
  if (kind === 'lead')
    return (
      <span className={`${cls} av-lead`} aria-hidden="true">
        <Logo size={20} className="av-logo" />
      </span>
    );
  if (kind === 'user')
    return (
      <span className={`${cls} av-user`} aria-hidden="true">
        我
      </span>
    );
  if (kind === 'group')
    return (
      <span className={`${cls} av-t${toneOf(name)}`} aria-hidden="true">
        #
      </span>
    );
  return (
    <span className={`${cls} av-t${toneOf(name)}`} aria-hidden="true">
      <Shape name={name} />
    </span>
  );
}
