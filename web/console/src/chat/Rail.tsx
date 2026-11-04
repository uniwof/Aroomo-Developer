/**
 * 最左窄栏（所有者 2026-11-04 21:42 按 sumus 真实界面标注）：
 *   顶部：账号首字母头像
 *   「+」新对话
 *   分类图标：资源库、工具、API（Key 与接入）、成员
 *   最底：设置齿轮
 * 每个图标都有读屏名字和悬停提示；当前打开的分类高亮。手机上这一栏收进抽屉（横排）。
 */
import { BookOpen, KeyRound, Plus, Settings, Users, Wrench } from 'lucide-react';
import { currentUser } from '@/lib/api';
import type { UsageRow } from '@/lib/usage';
import { Shape, toneOf } from './Avatar';

export type RailTarget = 'library' | 'tools' | 'keys' | 'members' | 'settings';

const ITEMS: { id: RailTarget; label: string; icon: typeof BookOpen }[] = [
  { id: 'library', label: '资源库', icon: BookOpen },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'keys', label: 'API', icon: KeyRound },
  { id: 'members', label: '成员', icon: Users },
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

/** 圆形头像 + 状态环（环 = 剩余比例；未知 = 淡色整圈） */
export function RingAvatar({ name, row }: { name: string; row?: UsageRow | undefined }) {
  const q = quotaState(row);
  const r = 21;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring-av" aria-hidden="true">
      <svg viewBox="0 0 48 48" className="ring-svg">
        <circle cx="24" cy="24" r={r} className="ring-track" />
        {q.frac != null && q.frac > 0 && <circle cx="24" cy="24" r={r} className={`ring-arc ring-${q.tone}`} strokeDasharray={`${c * q.frac} ${c}`} transform="rotate(-90 24 24)" />}
      </svg>
      <span className={`ring-face av-t${toneOf(name)}`}>
        <Shape name={name} />
      </span>
    </span>
  );
}

export function RailNav({ active, onOpen, onNew, horizontal = false }: { active: string; onOpen: (t: RailTarget) => void; onNew: () => void; horizontal?: boolean }) {
  const user = currentUser();
  const initial = Array.from((user?.displayName || user?.email || '我').trim())[0]?.toUpperCase() ?? '我';
  const item = (id: RailTarget, label: string, Icon: typeof BookOpen) => (
    <li key={id}>
      <button type="button" className="rail-btn" aria-label={label} title={label} aria-current={active === id ? 'page' : undefined} onClick={() => onOpen(id)}>
        <Icon aria-hidden="true" />
        {horizontal && <span className="rail-label">{label}</span>}
      </button>
    </li>
  );
  return (
    <>
      {!horizontal && (
        <span className="rail-me" aria-hidden="true" title={user?.email ?? ''}>
          {initial}
        </span>
      )}
      <ul className={horizontal ? 'rail-list rail-list-h' : 'rail-list'}>
        {!horizontal && (
          <li>
            <button type="button" className="rail-btn" aria-label="新对话" title="新对话" onClick={onNew}>
              <Plus aria-hidden="true" />
            </button>
          </li>
        )}
        {ITEMS.map((i) => item(i.id, i.label, i.icon))}
      </ul>
    </>
  );
}

export function Rail({ active, onOpen, onNew }: { active: string; onOpen: (t: RailTarget) => void; onNew: () => void }) {
  return (
    <nav className="rail" aria-label="分类">
      <RailNav active={active} onOpen={onOpen} onNew={onNew} />
      <span className="rail-spacer" />
      <button type="button" className="rail-btn" aria-label="设置" title="设置" aria-current={active === 'settings' ? 'page' : undefined} onClick={() => onOpen('settings')}>
        <Settings aria-hidden="true" />
      </button>
    </nav>
  );
}
