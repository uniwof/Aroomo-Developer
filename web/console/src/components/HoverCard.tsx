/** D218 悬停卡 3 行版：① 英文名+类型 ② 状态一句话 ③ 余量（实查/估算/未知）。数据 GET /api/members/:id/card（#174）。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

export interface MemberCard {
  name: string;
  type: string[];
  status: string;
  remaining: { value: number | null; unit: string | null; source: string };
}

/** status：调用方传行内同一套推导出的状态（#383 同源），不传才用 Core 卡片的 */
export function cardLines(c: MemberCard, status?: string): [string, string, string] {
  const rem =
    c.remaining.value == null ? '余量：未知' : `余量：${c.remaining.value} ${c.remaining.unit ?? ''}（${c.remaining.source}）`.replace(' （', '（');
  return [`${c.name} · ${c.type.join('、')}`, `状态：${status ?? c.status}`, rem];
}

/** 卡片元素的 id：包住按钮时（wrap），按钮用 aria-describedby 指向它，读屏聚焦按钮就读到 3 行 */
export const hoverCardId = (memberId: string) => `hc-${memberId}`;

/**
 * wrap=true：包住一个本身能聚焦的元素（如成员列表的一行按钮），自己不再占一个 Tab 位；
 * 里面元素聚焦时卡片出现（焦点事件冒泡上来）。长按打开卡片后松手，不触发里面按钮的点击。
 */
export function HoverCard({ memberId, children, delay = 300, wrap = false, status }: { memberId: string; children: ReactNode; delay?: number; wrap?: boolean; status?: string }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<MemberCard | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  const id = hoverCardId(memberId);

  function show(ms: number, byPress = false) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (byPress) pressed.current = true;
      setOpen(true);
    }, ms);
  }
  function hide() {
    clearTimeout(timer.current);
    pressed.current = false;
    setOpen(false);
  }
  useEffect(() => () => clearTimeout(timer.current), []);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) hide();
    };
    document.addEventListener('touchstart', away);
    document.addEventListener('mousedown', away);
    return () => {
      document.removeEventListener('touchstart', away);
      document.removeEventListener('mousedown', away);
    };
  }, [open]);
  useEffect(() => {
    if (!open || card) return;
    let alive = true;
    setFailed(false);
    api<MemberCard>('GET', `/api/members/${encodeURIComponent(memberId)}/card`)
      .then((c) => alive && setCard(c))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, card, memberId]);

  const lines = card ? cardLines(card, status) : null;
  return (
    <span
      ref={rootRef}
      className={wrap ? 'relative block' : 'relative inline-flex min-h-12 min-w-12 items-center justify-center'}
      {...(wrap ? {} : { tabIndex: 0, 'aria-describedby': open ? id : undefined })}
      onMouseEnter={() => show(delay)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
      onTouchStart={() => show(500, true)}
      onTouchEnd={() => clearTimeout(timer.current)}
      onTouchMove={() => clearTimeout(timer.current)}
      onContextMenu={(e) => e.preventDefault()}
      onClickCapture={(e) => {
        // 长按看卡片，松手不当成点了一下（不跳走）
        if (pressed.current) {
          pressed.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {children}
      {open && (
        // aria-live：卡片数据读回来后读屏播报 3 行（聚焦时先出「正在读取…」）
        <span id={id} role="tooltip" aria-live="polite" className="absolute left-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-1 tip">
          {lines ? lines.map((l, i) => <span key={i} className="block">{l}</span>) : <span className="block">{failed ? '暂时读不到，稍后再看' : '正在读取…'}</span>}
        </span>
      )}
    </span>
  );
}
