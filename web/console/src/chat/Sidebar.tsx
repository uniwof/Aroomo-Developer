/**
 * 会话列表栏（2026-11-04 所有者：完全照 sumus 登录后的界面，300px 宽、极浅灰底；之后再逐个改功能）：
 *   顶部 48px：「Aroomo」+ 右边小铃铛（通知 / 收件箱）
 *   分段控件「对话 / 助手」（所有者 11-05 12:16 定名：助手=为一个长期任务设的单位，一个成员或几个成员的小团队）（sumus 的 Chat / Activity 位置；同一栏的两种列表，不是标签页）
 *   搜索框 + 新对话（X-09：「对话」里输入时，下面多一组「消息」= 在 Core 里搜消息正文，点一条打开那个会话并停在那条消息；Ctrl/⌘K 聚焦搜索框）
 *   分组标题「对话 ∨」（点了收起 / 展开）
 *   会话行：头像 + 名字 + 时间 / 一行预览 + 置顶图钉
 *   底部：「资源库 · + 添加」「成员」（负责人落地文档 3.5；「邀请」「连接应用」、用户行不放）
 * 不放点了没反应的按钮。
 * 桌面常显；手机上它就是唯一一层抽屉（外层 <dialog>）：最上面多一排分类（资源库 / 工具 / API / 成员）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bell, Bot, CalendarClock, ChevronDown, MessageSquareText, MessagesSquare, Pin, Plus, Search, Shapes, SquarePen, Users, X } from 'lucide-react';
import { isFamily, type Member } from '@/lib/api';
import type { Assistant } from '@/lib/assistants';
import { FLAGS } from '@/lib/flags';
import { ConvFilter, RunningTag, applyConvFilter, type ConvFilterValue } from './conv-filter';
import type { UsageRow } from '@/lib/usage';
import { Avatar, type AvatarKind } from './Avatar';
import { quotaState, type RailTarget } from './Rail';
import { listTimeLabel, previewText, type Conversation } from './store';
import { searchMessages, type SearchResult } from './saved';

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
  /** 助手行 */
  assistantId?: string;
  unread?: boolean;
  running?: boolean;
}

function previewOf(c: Conversation): string {
  // 存库的会话还没取消息时，用 Core 给的最后一条预览
  const last = c.messages[c.messages.length - 1] ?? c.remote?.last;
  if (!last) return '还没有消息';
  const text = previewText(last.text);
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
  /** 助手列表（只给所有者、开关 FLAGS.assistants 打开时）；null = 不显示「助手」分段 */
  assistants?: Assistant[] | null;
  assistantsError?: string;
  currentAssistant?: string | null;
  onAssistant?: (id: string) => void;
  onNewAssistant?: () => void;
  onSchedule?: () => void;
  /** 会话存在 Core 时才有未读 / 进行中：「对话」也显示「全部 / 未读 / 进行中」筛选 */
  filterable?: boolean;
  /** 本页正在生成回复的会话（Core 的进行中要等列表刷新） */
  runningId?: string | null;
  /** X-09：会话存在 Core 时才有：搜消息正文，点结果打开会话并停在那条消息 */
  onOpenMessage?: (conversationId: string, messageId: string) => void;
}

/** 片段里把搜索词加粗（不分大小写；只是显示，读屏照常读整句） */
function Marked({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function Sidebar({ list, currentId, members, inboxCount, active, onPick, onMember, onLead, onNew, onOpen, onClose, usage, assistants, assistantsError, currentAssistant, onAssistant, onNewAssistant, onSchedule, filterable = false, runningId = null, onOpenMessage }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('chats');
  const [filter, setFilter] = useState<ConvFilterValue>('all');
  // 家人账号、开关关着时 assistants 为空：「助手」分段照旧显示空列表，不放新建、筛选、全部计划
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

  // X-09：「对话」里输入时去 Core 搜消息正文（停顿 300ms 再搜；晚到的旧结果丢掉）
  const searchRef = useRef<HTMLInputElement>(null);
  const term = q.trim();
  const msgSearch = tab === 'chats' && !!onOpenMessage && term.length > 0;
  const [hits, setHits] = useState<{ q: string; state: 'loading' | 'done' | 'error'; list: SearchResult[] }>({ q: '', state: 'done', list: [] });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!msgSearch) return;
    let live = true;
    setHits({ q: term, state: 'loading', list: [] });
    const t = setTimeout(() => {
      searchMessages(term).then(
        (list) => live && setHits({ q: term, state: 'done', list }),
        () => live && setHits({ q: term, state: 'error', list: [] }),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [msgSearch, term, retry]);
  // Ctrl/⌘K：聚焦搜索框（只认看得见的那个：手机抽屉没打开时不抢焦点）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k' || !searchRef.current?.offsetParent) return;
      e.preventDefault();
      setTab('chats');
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const chats = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let pinnedLead = false;
    for (const c of list) {
      // 还没发过消息的新话题不进列表（照 sumus：新话题挂在对象下面，不单独占一行）
      if (c.messages.length === 0 && !c.remote?.count) continue;
      const member = c.model.startsWith('aroomo/') ? members.find((m) => `aroomo/${m.id}` === c.model) : undefined;
      const single = c.model.startsWith('aroomo/');
      const kind: AvatarKind = c.group?.length ? 'group' : single ? 'member' : 'lead';
      // 置顶：最近一次和负责人的对话（sumus 把内置助手置顶；真正的「置顶」之后再做）
      const pinned = kind === 'lead' && !pinnedLead;
      if (pinned) pinnedLead = true;
      out.push({
        key: c.id,
        kind,
        name: c.group?.length ? c.title.replace(/^群聊：/, '') : member ? member.name : single ? c.title.replace(/^和\s*/, '') : c.title,
        preview: previewOf(c),
        at: c.updatedAt,
        convId: c.id,
        pinned,
        ...(c.remote?.unread && c.id !== currentId ? { unread: true } : {}),
        ...(c.remote?.running || c.id === runningId ? { running: true } : {}),
        ...(member ? { member } : {}),
        ...(c.group?.length ? { size: c.group.length } : {}),
      });
    }
    return out;
  }, [list, members, currentId, runningId]);

  // 助手（所有者 11-05 12:16 / 12:38）：为一个长期、可定时的任务设的成员小队。数据来自 GET /api/assistants（不预置示例）
  const staff = useMemo<Row[]>(
    () =>
      (assistants ?? []).map((a) => ({
        key: a.id,
        kind: 'group' as const,
        name: a.name,
        preview: a.status === 'paused' ? '已暂停' : a.lastRun?.summary || (a.schedule.text ?? '只在我叫它时'),
        at: a.lastRun?.finishedAt ? Date.parse(a.lastRun.finishedAt) : undefined,
        assistantId: a.id,
        size: a.members.length,
        unread: !!a.unread,
        running: a.status === 'running',
      })),
    [assistants],
  );

  const k = q.trim().toLowerCase();
  const filterOn = FLAGS.convFilter && (tab === 'staff' ? !!assistants?.length : filterable);
  const rows = (filterOn ? applyConvFilter(tab === 'staff' ? staff : chats, filter) : tab === 'staff' ? staff : chats).filter((r) => !k || r.name.toLowerCase().includes(k) || r.preview.toLowerCase().includes(k));
  const isCurrent = (r: Row) =>
    tab === 'chats' ? !!r.convId && r.convId === currentId : r.assistantId ? r.assistantId === currentAssistant : r.lead ? current?.model === 'aroomo' && !current.group?.length : !!r.member && current?.model === `aroomo/${r.member.id}`;
  const labelOf = (r: Row) => {
    if (r.assistantId) return `助手 ${r.name}，${r.size ?? 0} 位成员${r.running ? '，进行中' : ''}${r.unread ? '，有新结果' : ''}，${r.preview}${r.at ? `，${listTimeLabel(r.at)}` : ''}`;
    const head = `${r.kind === 'group' ? `群聊 ${r.name}，${r.size ?? 0} 人` : r.name}${r.running ? '，进行中' : ''}${r.unread ? '，有新回复' : ''}`;
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
            <span className="sr-only">{tab === 'staff' ? '搜索助手' : '搜索对话'}</span>
            <input ref={searchRef} type="search" placeholder={tab === 'staff' ? '搜索助手' : '搜索对话'} aria-keyshortcuts="Control+K Meta+K" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          {/* 新建对话菜单（所有者 11-05 12:15）：默认全员（不 @ 由负责人安排，@ 谁谁答）/ 自己挑成员 / 和某一位单聊；所有者另有「添加成员」。「助手」分段里这个位置是「新建助手」 */}
          {tab === 'staff' && onNewAssistant ? (
            <button type="button" className="icon-btn hit" aria-label="新建助手" title="新建助手" onClick={onNewAssistant}>
              <SquarePen aria-hidden="true" />
            </button>
          ) : (
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
          )}
        </div>
        {filterOn && <ConvFilter value={filter} onChange={setFilter} label={tab === 'staff' ? '筛选助手' : '筛选对话'} />}
      </div>

      <div className="conv-scroll">
        <div className="conv-group-row">
          <button type="button" className="conv-group hit" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
            <span>{groupLabel}</span>
            <ChevronDown aria-hidden="true" className={folded ? 'folded' : undefined} />
          </button>
          {tab === 'staff' && FLAGS.schedulePage && onSchedule && (
            <button type="button" className="foot-link hit conv-group-link" aria-current={active === 'schedule' ? 'page' : undefined} onClick={onSchedule}>
              <CalendarClock aria-hidden="true" />
              <span>看全部计划</span>
            </button>
          )}
        </div>
        {!folded && (
          <ul className="conv-list" aria-label={tab === 'staff' ? '助手列表' : '会话列表'}>
            {rows.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  className="conv"
                  aria-current={isCurrent(r) ? 'true' : undefined}
                  aria-label={labelOf(r)}
                  onClick={() => (r.assistantId ? onAssistant?.(r.assistantId) : tab === 'chats' && r.convId ? onPick(r.convId) : r.lead ? onLead() : r.member ? onMember(r.member) : r.convId && onPick(r.convId))}
                >
                  <Avatar name={r.name} kind={r.kind} />
                  <span className="conv-text">
                    <span className="conv-top">
                      <span className="conv-name">
                        {r.kind === 'group' && !r.assistantId && (
                          <span aria-hidden="true" className="hash">
                            #{' '}
                          </span>
                        )}
                        {r.name}
                        {r.kind === 'group' && <Users aria-hidden="true" className="conv-badge" />}
                        {r.running && <RunningTag />}
                      </span>
                      {r.at && <span className="conv-time">{listTimeLabel(r.at)}</span>}
                    </span>
                    <span className="conv-bottom">
                      <span className="conv-preview">{r.preview}</span>
                      {r.pinned && <Pin aria-hidden="true" className="conv-pin" />}
                      {r.unread && <span className="bell-dot conv-unread" aria-hidden="true" />}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {rows.length === 0 && !msgSearch && (
              <li className="conv-empty">
                {q
                  ? '没有找到。换个词试试。'
                  : tab === 'staff'
                    ? assistantsError || (filter === 'all' ? (onNewAssistant ? '还没有助手。点右上角的笔新建一个。' : '还没有助手。') : filter === 'unread' ? '没有新结果。' : '没有进行中的助手。')
                    : filter === 'all' || !filterOn
                      ? '还没有会话。'
                      : filter === 'unread'
                        ? '没有未读的对话。'
                        : '没有进行中的对话。'}
              </li>
            )}
          </ul>
        )}
        {msgSearch && (
          <section className="msg-hits" aria-label="消息里找到的">
            <div className="conv-group-row">
              <h3 className="conv-group">消息</h3>
            </div>
            {/* 读屏：搜完播一句结果数（静态文字，不转圈） */}
            <p className="sr-only" aria-live="polite">
              {hits.state === 'done' ? (hits.list.length ? `消息里找到 ${hits.list.length} 条` : '消息里没有找到') : hits.state === 'error' ? '没能搜消息' : ''}
            </p>
            {hits.state === 'loading' && <p className="conv-empty">正在搜消息…</p>}
            {hits.state === 'error' && (
              <p className="conv-empty">
                没能搜消息：连不上 Aroomo。
                <button type="button" className="pill hit" onClick={() => setRetry((n) => n + 1)}>
                  重试
                </button>
              </p>
            )}
            {hits.state === 'done' && hits.list.length === 0 && <p className="conv-empty">{rows.length ? '消息里没有找到。' : '没有找到。换个词试试。'}</p>}
            {hits.list.length > 0 && (
              <ul className="conv-list" aria-label="消息搜索结果">
                {hits.list.map((h) => (
                  <li key={h.messageId}>
                    <button
                      type="button"
                      className="conv"
                      aria-label={`${h.title}，${h.role === 'user' ? '我说' : '回复'}：${h.snippet}，${listTimeLabel(Date.parse(h.createdAt))}，打开并跳到这条`}
                      onClick={() => onOpenMessage?.(h.conversationId, h.messageId)}
                    >
                      <span className="hit-icon" aria-hidden="true">
                        <MessageSquareText />
                      </span>
                      <span className="conv-text">
                        <span className="conv-top">
                          <span className="conv-name">{h.title}</span>
                          <span className="conv-time">{listTimeLabel(Date.parse(h.createdAt))}</span>
                        </span>
                        <span className="hit-snippet">
                          {h.role === 'user' ? '我：' : ''}
                          <Marked text={h.snippet} q={hits.q} />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
