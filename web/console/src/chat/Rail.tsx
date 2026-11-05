/**
 * 最左窄栏（照 sumus 48px 宽；内容按负责人落地文档第 2 章 + 所有者标注）：
 *   顶部：Aroomo 标志（珊瑚色，点了回到对话）
 *   对话（在 sumus 空间头像「A」的位置，当前所在时左边一条黑色竖条）
 *   成员、资源库、工具、API（sumus 的「+ 新建空间」位置让给分类）
 *   最底：我的头像 + 总额度圆环（点了打开设置），⚙ 设置（所有者标注「设置图标放到这里」）
 * 图标外观 32px，点击区用透明扩展到 44px；每个图标都有读屏名字和悬停提示，当前所在项 aria-current="page"。
 * 手机（或字号大到放不下）时这一栏收进抽屉，横排显示。
 */
import { BookOpen, KeyRound, MessagesSquare, Settings, Users, Wrench } from 'lucide-react';
import { Logo } from '@/components/brand';
import { currentUser, isFamily } from '@/lib/api';
import { quotaFraction } from '@/components/brand';
import { worstRow, type UsageRow } from '@/lib/usage';

export type RailTarget = 'chat' | 'library' | 'tools' | 'keys' | 'members' | 'settings';

const ITEMS: { id: Exclude<RailTarget, 'chat' | 'settings'>; label: string; icon: typeof BookOpen }[] = [
  { id: 'members', label: '成员', icon: Users },
  { id: 'library', label: '资源库', icon: BookOpen },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'keys', label: 'API', icon: KeyRound },
];

/** 额度状态（只说状态，不说数字）：未知 / 充足 / 快用完 / 用完或限流 */
export function quotaState(row: UsageRow | undefined): { label: string; frac: number | null; tone: 'unknown' | 'ok' | 'warn' | 'full' } {
  if (row && row.state === 'limited') return { label: '额度已用完', frac: 0, tone: 'full' };
  if (!row || !row.quotaKnown || row.quota.limit == null || row.quota.limit <= 0) return { label: '额度未知', frac: null, tone: 'unknown' };
  const used = Math.min(1, Math.max(0, row.quota.used / row.quota.limit));
  if (used >= 1) return { label: '额度已用完', frac: 0, tone: 'full' };
  if (used >= 0.8) return { label: '额度快用完了', frac: 1 - used, tone: 'warn' };
  return { label: '额度充足', frac: 1 - used, tone: 'ok' };
}

export function initialOf(): string {
  const user = currentUser();
  return Array.from((user?.displayName || user?.email || '我').trim())[0]?.toUpperCase() ?? '我';
}

export function RailNav({ active, onOpen, horizontal = false }: { active: string; onOpen: (t: RailTarget) => void; horizontal?: boolean }) {
  const btn = (id: RailTarget, label: string, Icon: typeof BookOpen, current: boolean) => (
    <li key={id} className={!horizontal && id === 'chat' ? 'rail-chat-li' : undefined}>
      <button type="button" className="rail-btn hit" aria-label={label} title={label} aria-current={current ? 'page' : undefined} onClick={() => onOpen(id)}>
        <Icon aria-hidden="true" />
        {horizontal && <span className="rail-label">{label}</span>}
      </button>
    </li>
  );
  const isChat = active === 'chat';
  return (
    <ul className={horizontal ? 'rail-list rail-list-h' : 'rail-list'}>
      {!horizontal && btn('chat', '对话', MessagesSquare, isChat)}
      {ITEMS.filter((i) => i.id === 'members' || !isFamily()).map((i) => btn(i.id, i.label, i.icon, active === i.id || (i.id === 'members' && (active === 'member' || active === 'capmap'))))}
      {horizontal && btn('settings', '设置', Settings, active === 'settings')}
    </ul>
  );
}

/** 我的头像 + 总额度圆环（D217/D218：只画圆环，不显示数字）；窄栏和手机底部栏共用 */
export function MeFace({ usage }: { usage: UsageRow[] | null }) {
  const w = worstRow(usage);
  const f = quotaFraction(w?.quota.used, w?.quota.limit);
  const q = quotaState(w ?? undefined);
  return (
    <span className="rail-me-wrap" aria-hidden="true">
      <svg viewBox="0 0 36 36" className="rail-me-ring">
        <circle cx="18" cy="18" r="16" className="ring-track" />
        {f != null && f < 1 && <circle cx="18" cy="18" r="16" className={`ring-arc ring-${q.tone}`} strokeDasharray={`${2 * Math.PI * 16 * (1 - f)} 200`} transform="rotate(-90 18 18)" />}
      </svg>
      <span className="rail-me-face">{initialOf()}</span>
    </span>
  );
}

/** 总额度状态的读屏文字 */
export function meLabel(usage: UsageRow[] | null): string {
  const user = currentUser();
  return `我的账号（${user?.displayName || user?.email || '我'}），总额度：${quotaState(worstRow(usage) ?? undefined).label}`;
}

function MeRing({ usage, onOpen }: { usage: UsageRow[] | null; onOpen: () => void }) {
  return (
    <button type="button" className="rail-me hit" aria-label={meLabel(usage)} title="我的账号" onClick={onOpen}>
      <MeFace usage={usage} />
    </button>
  );
}

export function Rail({ active, onOpen, usage }: { active: string; onOpen: (t: RailTarget) => void; usage: UsageRow[] | null }) {
  return (
    <nav className="rail" aria-label="分类">
      <button type="button" className="rail-logo hit" aria-label="Aroomo，回到对话" title="Aroomo" onClick={() => onOpen('chat')}>
        <Logo size={24} />
      </button>
      <RailNav active={active} onOpen={onOpen} />
      <span className="rail-spacer" />
      <MeRing usage={usage} onOpen={() => onOpen('settings')} />
      <button type="button" className="rail-btn hit" aria-label="设置" title="设置" aria-current={active === 'settings' ? 'page' : undefined} onClick={() => onOpen('settings')}>
        <Settings aria-hidden="true" />
      </button>
    </nav>
  );
}
