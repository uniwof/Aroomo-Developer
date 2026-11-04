/**
 * 最左窄栏（2026-11-04 所有者：完全照 sumus 登录后的界面，48px 宽、极浅灰底、右边一条细线）：
 *   顶部：Aroomo 标志
 *   当前空间的首字母方块（左边一条黑色竖条表示「在这里」）
 *   「+」新对话
 *   分类图标：资源库、工具、API（Key 与接入）、成员
 *   最底：设置齿轮（所有者标注「设置图标放到这里」）
 * 图标外观 32px，点击区用透明扩展到 44px。每个图标都有读屏名字和悬停提示。手机上这一栏收进抽屉（横排）。
 */
import { BookOpen, KeyRound, Plus, Settings, Users, Wrench } from 'lucide-react';
import { currentUser } from '@/lib/api';
import { Logo } from '@/components/brand';
import type { UsageRow } from '@/lib/usage';

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

export function initialOf(): string {
  const user = currentUser();
  return Array.from((user?.displayName || user?.email || '我').trim())[0]?.toUpperCase() ?? '我';
}

export function RailNav({ active, onOpen, onNew, horizontal = false }: { active: string; onOpen: (t: RailTarget) => void; onNew: () => void; horizontal?: boolean }) {
  const item = (id: RailTarget, label: string, Icon: typeof BookOpen) => (
    <li key={id}>
      <button type="button" className="rail-btn hit" aria-label={label} title={label} aria-current={active === id ? 'page' : undefined} onClick={() => onOpen(id)}>
        <Icon aria-hidden="true" />
        {horizontal && <span className="rail-label">{label}</span>}
      </button>
    </li>
  );
  return (
    <ul className={horizontal ? 'rail-list rail-list-h' : 'rail-list'}>
      {!horizontal && (
        <>
          <li className="rail-ws-li">
            <span className="rail-ws" aria-hidden="true" title={currentUser()?.email ?? ''}>
              {initialOf()}
            </span>
          </li>
          <li>
            <button type="button" className="rail-btn hit" aria-label="新对话" title="新对话" onClick={onNew}>
              <Plus aria-hidden="true" />
            </button>
          </li>
        </>
      )}
      {ITEMS.map((i) => item(i.id, i.label, i.icon))}
    </ul>
  );
}

export function Rail({ active, onOpen, onNew }: { active: string; onOpen: (t: RailTarget) => void; onNew: () => void }) {
  return (
    <nav className="rail" aria-label="分类">
      <span className="rail-logo" aria-hidden="true">
        <Logo size={24} />
      </span>
      <RailNav active={active} onOpen={onOpen} onNew={onNew} />
      <span className="rail-spacer" />
      <button type="button" className="rail-btn hit" aria-label="设置" title="设置" aria-current={active === 'settings' ? 'page' : undefined} onClick={() => onOpen('settings')}>
        <Settings aria-hidden="true" />
      </button>
    </nav>
  );
}
