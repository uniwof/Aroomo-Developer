/**
 * 会话列表栏（2026-11-04 所有者：完全照 sumus 登录后的界面，300px 宽、极浅灰底；之后再逐个改功能）：
 *   顶部 48px：「Aroomo」+ 右边小铃铛（通知 / 收件箱）
 *   分段控件「对话 / 助手」（所有者 11-05 12:16 定名：助手=为一个长期任务设的单位，一个成员或几个成员的小团队）（sumus 的 Chat / Activity 位置；同一栏的两种列表，不是标签页）
 *   搜索框 + 新对话
 *   分组标题「对话 ∨」（点了收起 / 展开）
 *   会话行：头像 + 名字 + 时间 / 一行预览 + 置顶图钉
 *   底部：「资源库 · + 添加」「成员」（负责人落地文档 3.5；「邀请」「连接应用」、用户行不放）
 * 不放点了没反应的按钮。
 * 桌面常显；手机上它就是唯一一层抽屉（外层 <dialog>）：最上面多一排分类（资源库 / 工具 / API / 成员）。
 */
import { useEffect, useMemo, useState } from 'react';
import { Activity, Bell, Bot, ChevronDown, MessagesSquare, Pin, Plus, Search, Shapes, SquarePen, Users, X } from 'lucide-react';
import { isFamily, type Member } from '@/lib/api';
import type { UsageRow } from '@/lib/usage';
import { Avatar, type AvatarKind } from './Avatar';
import { quotaState, type RailTarget } from './Rail';
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
  pinned?: boolean;
}

function previewOf(c: Conversation): string {
  const last = c.messages[c.messages.length - 1];
  if (!last) return '还没有消息';
  const text = stripSignature(last.text).replace(/[#*`>_~[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return last.role === 'user' ? `我：${text}` : text;
}

export type SideTarget = RailTarget | 'group-new' | 'inbox' | 'capmap' | 'add-member';

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
  onOpen: (k: SideTarget) => void;
  /** 手机抽屉里才有「关闭」和分类横排 */
  onClose?: () => void;
  usage: UsageRow[] | null;
}

export function Sidebar({ list, currentId, members, inboxCount, active, onPick, onMember, onLead, onNew, onOpen, onClose, usage }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('chats');
  const [q, setQ] = useState('');
  const [folded, setFolded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  useEffect(() => {
    if (!newOpen) return;
    const onDown = (e: MouseEvent) => !(e.target as Element).closest?.('.side-search .topic') && setNewOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      document.querySelector<HTMLElement>('.side-tools [aria-expanded="true"]')?.focus();
      setNewOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [newOpen]);
  const current = list.find((c) => c.id === currentId);

  const chats = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let pinnedLead = false;
    for (const c of list) {
      // 还没发过消息的新话题不进列表（照 sumus：新话题挂在对象下面，不单独占一行）
      if (c.messages.length === 0) continue;
      const member = c.model.startsWith('aroomo/') ? members.find((m) => `aroomo/${m.id}` === c.model) : undefined;
      const single = c.model.startsWith('aroomo/');
      const kind: AvatarKind = c.group?.length ? 'group' : single ? 'member' : 'lead';
      // 置顶：最近一次和负责人的对话（sumus 把内置助手置顶；真正的「置顶」之后再做）
      const pinned = kind === 'lead' && !pinnedLead && c.messages.length > 0;
      if (pinned) pinnedLead = true;
      out.push({
        key: c.id,
        kind,
        name: c.group?.length ? c.title.replace(/^群聊：/, '') : member ? member.name : single ? c.title.replace(/^和\s*/, '') : c.title,
        preview: previewOf(c),
        at: c.messages.length ? c.updatedAt : undefined,
        convId: c.id,
        pinned,
        ...(member ? { member } : {}),
        ...(c.group?.length ? { size: c.group.length } : {}),
      });
    }
    return out;
  }, [list, members, currentId]);

  // 助手（所有者 11-05 12:16 / 12:38）：为一个长期、可定时的任务设的成员小队。不预置示例，Core 接口（/api/assistants）好之前列表为空、不放「新建助手」按钮
  const staff: Row[] = [];

  const k = q.trim().toLowerCase();
  const rows = (tab === 'staff' ? staff : chats).filter((r) => !k || r.name.toLowerCase().includes(k) || r.preview.toLowerCase().includes(k));
  const isCurrent = (r: Row) =>
    tab === 'chats' ? !!r.convId && r.convId === currentId : r.lead ? current?.model === 'aroomo' && !current.group?.length : !!r.member && current?.model === `aroomo/${r.member.id}`;
  const labelOf = (r: Row) => {
    const head = r.kind === 'group' ? `群聊 ${r.name}，${r.size ?? 0} 人` : r.name;
    const q2 = r.member && tab === 'staff' ? `，${quotaState(usage?.find((u) => u.memberId === r.member!.id)).label}` : '';
    return `${head}${r.pinned ? '，已置顶' : ''}${q2}，${tab === 'staff' ? '' : '最后一条：'}${r.preview}${r.at ? `，${listTimeLabel(r.at)}` : ''}`;
  };
  const groupLabel = tab === 'staff' ? '助手' : '对话';

  return (
    <div className="side-inner">
      <div className="side-head">
        <h2 className="side-title">Aroomo</h2>
        <button type="button" className="icon-btn hit bell" aria-label={inboxCount ? `通知和收件箱，${inboxCount} 条待处理` : '通知和收件箱'} title="通知" aria-current={active === 'inbox' ? 'page' : undefined} onClick={() => onOpen('inbox')}>
          <Bell aria-hidden="true" />
          {inboxCount > 0 && <span className="bell-dot" aria-hidden="true" />}
        </button>
        {onClose && (
          <button type="button" className="icon-btn hit" aria-label="关闭菜单" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="side-tools">
        <div className="seg2" role="radiogroup" aria-label="列表">
          {(
            [
              ['chats', '对话', MessagesSquare],
              ['staff', '助手', Activity],
            ] as [Tab, string, typeof Activity][]
          ).map(([v, label, Icon]) => (
            <button key={v} type="button" role="radio" aria-checked={tab === v} className="seg2-item hit" onClick={() => setTab(v)}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className="side-search">
          <label className="search2">
            <Search aria-hidden="true" />
            <span className="sr-only">搜索对话</span>
            <input type="search" placeholder="搜索对话" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {/* 新建对话菜单（所有者 11-05 12:15）：默认全员（不 @ 由负责人安排，@ 谁谁答）/ 自己挑成员 / 和某一位单聊；所有者另有「添加成员」 */}
          <div className="topic">
            <button type="button" className="icon-btn hit" aria-label="新建对话" title="新建对话" aria-haspopup="true" aria-expanded={newOpen} onClick={() => setNewOpen((o) => !o)}>
              <SquarePen aria-hidden="true" />
            </button>
            {newOpen && (
              <ul className="pop pop-right" aria-label="新建对话" onKeyDown={(e) => e.key === 'Escape' && setNewOpen(false)}>
                <li>
                  <button type="button" className="pop-item" onClick={() => { setNewOpen(false); onNew(); }}>
                    <Avatar name="全员" kind="lead" size="xs" />
                    <span>新对话（全员）</span>
                  </button>
                </li>
                <li>
                  <button type="button" className="pop-item" onClick={() => { setNewOpen(false); onOpen('group-new'); }}>
                    <Users aria-hidden="true" />
                    <span>挑选成员新建</span>
                  </button>
                </li>
                {!isFamily() && (
                  <li>
                    <button type="button" className="pop-item" onClick={() => { setNewOpen(false); onOpen('add-member'); }}>
                      <Bot aria-hidden="true" />
                      <span>添加成员</span>
                    </button>
                  </li>
                )}
                {members.length > 0 && (
                  <li role="presentation">
                    <p className="pop-label">单独聊</p>
                  </li>
                )}
                {members.map((m) => (
                  <li key={m.id}>
                    <button type="button" className="pop-item" aria-label={`和 ${m.name} 开新对话`} onClick={() => { setNewOpen(false); onMember(m); }}>
                      <Avatar name={m.name} size="xs" />
                      <span>{m.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <div className="conv-scroll">
        <button type="button" className="conv-group hit" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
          <span>{groupLabel}</span>
          <ChevronDown aria-hidden="true" className={folded ? 'folded' : undefined} />
        </button>
        {!folded && (
          <ul className="conv-list" aria-label={tab === 'staff' ? '助手列表' : '会话列表'}>
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
                        {r.kind === 'group' && <Users aria-hidden="true" className="conv-badge" />}
                      </span>
                      {r.at && <span className="conv-time">{listTimeLabel(r.at)}</span>}
                    </span>
                    <span className="conv-bottom">
                      <span className="conv-preview">{r.preview}</span>
                      {r.pinned && <Pin aria-hidden="true" className="conv-pin" />}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="conv-empty">{q ? '没有找到。换个词试试。' : tab === 'staff' ? '还没有助手。' : '还没有会话。'}</li>}
          </ul>
        )}
      </div>

      {/* 底部（负责人落地文档 3.5）：资源库 · + 添加 / 成员。「邀请」「连接应用」和用户行先不放（不放点了没反应的按钮） */}
      <div className="side-foot">
        {!isFamily() && (
        <div className="foot-row">
          <button type="button" className="foot-link hit" aria-label="打开资源库" aria-current={active === 'library' ? 'page' : undefined} onClick={() => onOpen('library')}>
            <Shapes aria-hidden="true" />
            <span>资源库</span>
          </button>
          <button type="button" className="pill hit" aria-label="添加成员" onClick={() => onOpen('add-member')}>
            <Plus aria-hidden="true" />
            <span>添加</span>
          </button>
        </div>
        )}
        <div className="foot-row">
          <button type="button" className="foot-link hit" aria-label="打开成员页" aria-current={active === 'members' ? 'page' : undefined} onClick={() => onOpen('members')}>
            <Users aria-hidden="true" />
            <span>成员</span>
          </button>
        </div>
      </div>
    </div>
  );
}
