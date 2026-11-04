/**
 * 会话列表栏（所有者 21:42 按 sumus 真实界面标注 + 负责人映射方案）：
 *   「Aroomo」+ 小铃铛（通知 / 收件箱，有待处理时一个珊瑚色圆点）
 *   专职成员 / 对话（sumus 的 Chat / Activity 两个切换的位置；是同一栏的两种列表，不是多标签页）
 *     专职成员：AI 在职岗位——负责人，和每位在职成员（点了就和 TA 单聊）
 *     对话：和负责人的对话、单独对话、`# 群聊`
 *   搜索会话 + 新对话
 *   底部：新建群聊（「成员」在最左分类栏）；最底：我自己 + 总额度圆环（点开 = 设置）
 * 桌面常显；手机上它就是唯一一层抽屉（外层 <dialog>）：最上面多一排分类（资源库 / 工具 / API / 成员 / 设置），
 * 点任何东西都是关抽屉、在主区域打开。
 */
import { useMemo, useState } from 'react';
import { Bell, Search, Settings, SquarePen, UserPlus, X } from 'lucide-react';
import { currentUser, type Member } from '@/lib/api';
import { Logo, QuotaRing } from '@/components/brand';
import { worstRow, type UsageRow } from '@/lib/usage';
import { Avatar, type AvatarKind } from './Avatar';
import { RailNav, quotaState, type RailTarget } from './Rail';
import { listTimeLabel, stripSignature, type Conversation } from './store';

type Tab = 'staff' | 'chats';

interface Row {
  key: string;
  kind: AvatarKind;
  name: string;
  preview: string;
  at: number | undefined;
  convId?: string;
  member?: Member;
  size?: number;
  lead?: boolean;
}

function previewOf(c: Conversation): string {
  const last = c.messages[c.messages.length - 1];
  if (!last) return '还没有消息';
  const text = stripSignature(last.text).replace(/[#*`>_~[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return last.role === 'user' ? `我：${text}` : text;
}

export interface SidebarProps {
  list: Conversation[];
  currentId: string | null;
  members: Member[];
  inboxCount: number;
  active: string;
  onPick: (id: string) => void;
  onMember: (m: Member) => void;
  onLead: () => void;
  onNew: () => void;
  onOpen: (k: RailTarget | 'group-new' | 'inbox') => void;
  /** 手机抽屉里才有「关闭」和分类横排 */
  onClose?: () => void;
  usage: UsageRow[] | null;
}

export function Sidebar({ list, currentId, members, inboxCount, active, onPick, onMember, onLead, onNew, onOpen, onClose, usage }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('chats');
  const [q, setQ] = useState('');
  const user = currentUser();
  const current = list.find((c) => c.id === currentId);

  const chats = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const c of list) {
      if (c.messages.length === 0 && c.id !== currentId) continue;
      const member = c.model.startsWith('aroomo/') ? members.find((m) => `aroomo/${m.id}` === c.model) : undefined;
      const single = c.model.startsWith('aroomo/');
      out.push({
        key: c.id,
        kind: c.group?.length ? 'group' : single ? 'member' : 'lead',
        name: c.group?.length ? c.title.replace(/^群聊：/, '') : member ? member.name : single ? c.title.replace(/^和\s*/, '') : c.title,
        preview: previewOf(c),
        at: c.messages.length ? c.updatedAt : undefined,
        convId: c.id,
        ...(member ? { member } : {}),
        ...(c.group?.length ? { size: c.group.length } : {}),
      });
    }
    return out;
  }, [list, members, currentId]);

  const staff = useMemo<Row[]>(() => {
    const lastOf = (model: string) => list.find((c) => c.model === model && c.messages.length > 0);
    const lead = lastOf('aroomo');
    return [
      { key: 'lead', kind: 'lead', name: '负责人', preview: '没 @ 谁的时候，由负责人回答', at: lead?.updatedAt, lead: true },
      ...members.map((m): Row => {
        const c = lastOf(`aroomo/${m.id}`);
        return { key: m.id, kind: 'member', name: m.name, preview: c ? previewOf(c) : m.capabilityTags.length ? m.capabilityTags.join('、') : '在职成员', at: c?.updatedAt, member: m };
      }),
    ];
  }, [list, members]);

  const k = q.trim().toLowerCase();
  const rows = (tab === 'staff' ? staff : chats).filter((r) => !k || r.name.toLowerCase().includes(k) || r.preview.toLowerCase().includes(k));
  const isCurrent = (r: Row) =>
    tab === 'chats' ? !!r.convId && r.convId === currentId : r.lead ? current?.model === 'aroomo' && !current.group?.length : !!r.member && current?.model === `aroomo/${r.member.id}`;
  const labelOf = (r: Row) => {
    const head = r.kind === 'group' ? `群聊 ${r.name}，${r.size ?? 0} 人` : r.name;
    const q2 = r.member && tab === 'staff' ? `，${quotaState(usage?.find((u) => u.memberId === r.member!.id)).label}` : '';
    return `${head}${q2}，${tab === 'staff' ? '' : '最后一条：'}${r.preview}${r.at ? `，${listTimeLabel(r.at)}` : ''}`;
  };

  return (
    <div className="side-inner">
      <div className="side-head">
        <Logo size={22} className="side-logo" />
        <h2 className="side-title">Aroomo</h2>
        <button type="button" className="btn btn-icon bell" aria-label={inboxCount ? `通知和收件箱，${inboxCount} 条待处理` : '通知和收件箱'} aria-current={active === 'inbox' ? 'page' : undefined} onClick={() => onOpen('inbox')}>
          <Bell aria-hidden="true" />
          {inboxCount > 0 && <span className="bell-dot" aria-hidden="true" />}
        </button>
        {onClose && (
          <button type="button" className="btn btn-icon" aria-label="关闭菜单" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      {onClose && (
        <nav aria-label="分类" className="side-cats">
          <RailNav horizontal active={active} onOpen={onOpen} onNew={onNew} />
        </nav>
      )}

      <div className="seg seg-full" role="radiogroup" aria-label="列表">
        {(
          [
            ['staff', '专职成员'],
            ['chats', '对话'],
          ] as [Tab, string][]
        ).map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={tab === v} className="seg-item" onClick={() => setTab(v)}>
            {label}
          </button>
        ))}
      </div>

      <div className="side-search">
        <label className="search">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input type="search" placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="btn btn-icon" aria-label="新对话" onClick={onNew}>
          <SquarePen aria-hidden="true" />
        </button>
      </div>

      <ul className="conv-list" aria-label={tab === 'staff' ? '专职成员' : '会话列表'}>
        {rows.map((r) => (
          <li key={r.key}>
            <button
              type="button"
              className="conv"
              aria-current={isCurrent(r) ? 'true' : undefined}
              aria-label={labelOf(r)}
              onClick={() => (tab === 'chats' && r.convId ? onPick(r.convId) : r.lead ? onLead() : r.member ? onMember(r.member) : r.convId && onPick(r.convId))}
            >
              <Avatar name={r.name} kind={r.kind} />
              <span className="conv-text">
                <span className="conv-top">
                  <span className="conv-name">
                    {r.kind === 'group' && (
                      <span aria-hidden="true" className="hash">
                        #{' '}
                      </span>
                    )}
                    {r.name}
                  </span>
                  {r.at && <span className="conv-time">{listTimeLabel(r.at)}</span>}
                </span>
                <span className="conv-preview">{r.preview}</span>
              </span>
            </button>
          </li>
        ))}
        {rows.length === 0 && <li className="conv-empty">{q ? '没有找到。换个词试试。' : '还没有会话。'}</li>}
      </ul>

      <div className="side-foot">
        <div className="side-links">
          <button type="button" className="btn btn-outline" onClick={() => onOpen('group-new')}>
            <UserPlus aria-hidden="true" />
            <span>新建群聊</span>
          </button>
        </div>
        <div className="side-user-row">
          <button type="button" className="side-user" aria-label="账号与设置" onClick={() => onOpen('settings')}>
            <Avatar name="我" kind="user" />
            <span className="conv-text">
              <span className="conv-name">{user?.displayName || '我'}</span>
              {user?.email && <span className="conv-preview">{user.email}</span>}
            </span>
            <QuotaRing used={worstRow(usage)?.quota.used} limit={worstRow(usage)?.quota.limit} />
          </button>
          {onClose && (
            <button type="button" className="btn btn-icon" aria-label="设置" onClick={() => onOpen('settings')}>
              <Settings aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
