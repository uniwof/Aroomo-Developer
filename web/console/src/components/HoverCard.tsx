/** D218 悬停卡 3 行版：① 英文名+类型 ② 状态一句话 ③ 余量（实查/估算/未知）。数据 GET /api/members/:id/card（#174）。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';

export interface MemberCard {
  name: string;
  type: string[];
  status: string;
  remaining: { value: number | null; unit: string | null; source: string };
}

export function cardLines(c: MemberCard): [string, string, string] {
  const rem =
    c.remaining.value == null ? '余量：未知' : `余量：${c.remaining.value} ${c.remaining.unit ?? ''}（${c.remaining.source}）`.replace(' （', '（');
  return [`${c.name} · ${c.type.join('、')}`, `状态：${c.status}`, rem];
}

export function HoverCard({ memberId, children, delay = 300 }: { memberId: string; children: ReactNode; delay?: number }) {
  const [open, setOpen] = useState(false);
  const [card, setCard] = useState<MemberCard | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = `hc-${memberId}`;

  function show(ms: number) {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), ms);
  }
  function hide() {
    clearTimeout(timer.current);
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
    api<MemberCard>('GET', `/api/members/${encodeURIComponent(memberId)}/card`)
      .then((c) => alive && setCard(c))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, card, memberId]);

  const lines = card ? cardLines(card) : null;
  return (
    <span
      ref={rootRef}
      className="relative inline-flex min-h-11 min-w-11 items-center justify-center"
      tabIndex={0}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => show(delay)}
      onMouseLeave={hide}
      onFocus={() => show(0)}
      onBlur={hide}
      onTouchStart={() => show(500)}
      onTouchEnd={() => clearTimeout(timer.current)}
      onTouchMove={() => clearTimeout(timer.current)}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {children}
      {open && (
        <span id={id} role="tooltip" className="absolute left-0 top-full z-20 mt-1 w-64 space-y-1 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-[14px] shadow-lg">
          {lines ? lines.map((l, i) => <span key={i} className="block">{l}</span>) : <span className="block">{failed ? '暂时读不到' : '正在读取…'}</span>}
        </span>
      )}
    </span>
  );
}
