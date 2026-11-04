/**
 * 控制台里的原生对话页（#250 spike）。#250 重设计（2026-11-04）照 sumus.im 的布局：
 * - 桌面：左边会话列表栏常显（标题 + 齿轮、搜索 + 新对话、全部 / 群聊 / 成员 筛选、会话行、底部 成员 / 新建群聊 / 收件箱、最底当前账号），
 *   右边主对话区（顶栏头像 + 名字、居中日期分隔、无气泡消息、大圆角输入卡片）。
 * - 手机（或字号放大后放不下两栏）：会话列表栏就是唯一一层抽屉；点会话、成员、设置后抽屉关上，内容在主区域原地打开，
 *   面板里的下一层用顶栏「‹ 返回」，不开第二层抽屉，不用标签页。
 * - 只调用 Core 的标准接口（/api/*）；会话先存在本机浏览器（localStorage）。
 * 边界：store.ts 管数据和请求，Thread.tsx 管对话区，Sidebar.tsx 管会话列表栏，panels.tsx 管面板，这里管拼装。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, CircleAlert, Ellipsis, Menu, Plus, SquarePen, Trash2 } from 'lucide-react';
import { api, currentUser, viaShell, type Member } from '@/lib/api';
import { useUsage } from '@/lib/usage';
import { Rail, quotaState, type RailTarget } from './Rail';
import { HeaderCard } from './HeaderCard';
import { Library } from '@/pages/Library';
import { Keys } from '@/pages/Keys';
import { Tools } from '@/pages/Tools';
import { Inbox } from '@/pages/Inbox';
import { useInboxCount } from '@/components/Layout';
import { Thread } from './Thread';
import { Sidebar } from './Sidebar';
import { CapabilityPanel, GroupNewPanel, MemberDetail, MembersPanel, PanelHeader, SettingsPanel, ShortcutsPanel } from './panels';
import { applyDisplay } from '@/lib/display';
import { listTimeLabel, loadConversations, loadPrefs, newConversation, saveConversations, savePrefs, stripSignature, titleFrom, type ChatPrefs, type ChatTurn, type Conversation } from './store';
import './chat.css';

/** 主区域显示什么：对话，或某个面板（带返回的上一层） */
type View =
  | { kind: 'chat' }
  | { kind: 'members' }
  | { kind: 'member'; id: string }
  | { kind: 'capmap' }
  | { kind: 'group-new' }
  | { kind: 'settings' }
  | { kind: 'tools' }
  | { kind: 'inbox' }
  | { kind: 'shortcuts' }
  | { kind: 'library' }
  | { kind: 'keys' }
  /** 照 sumus 先放上、功能还没接的按钮 */
  | { kind: 'todo'; label: string };

const TITLES: Record<Exclude<View['kind'], 'chat' | 'member' | 'todo'>, string> = {
  members: '成员',
  capmap: '能力地图',
  'group-new': '新建群聊',
  settings: '设置',
  tools: '工具',
  inbox: '收件箱',
  shortcuts: '键盘快捷键',
  library: '资源库',
  keys: 'API（Key 与接入）',
};

/** 上一层是哪里（顶栏「‹ 返回」） */
function parentOf(v: View): { view: View; label: string } | null {
  switch (v.kind) {
    case 'member':
    case 'capmap':
      return { view: { kind: 'members' }, label: '成员' };
    case 'shortcuts':
      return { view: { kind: 'settings' }, label: '设置' };
    case 'chat':
      return null;
    default:
      return { view: { kind: 'chat' }, label: '对话' };
  }
}

/** 会话列表宽度：单位是「sumus 像素 / 16」（18.75 = sumus 的 300px），可拖 280–420 */
const SIDE_KEY = 'aroomo.chat.sideWidth.v1';
const SIDE_MIN = 280;
const SIDE_MAX = 420;
const clampSide = (w: number) => Math.min(SIDE_MAX / 16, Math.max(SIDE_MIN / 16, w));

function useMembers(): Member[] {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>('GET', '/api/members')
      .then((r) => alive && setMembers(r.members.filter((m) => m.enabled && m.status === 'active')))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return members;
}

/**
 * 放得下几栏：按当前字号算（栏宽用 em，跟字号一起变大）。方案 2.2：放不下先把会话列表收进抽屉，只留窄栏 + 对话；
 * 再窄（手机）连窄栏也收进抽屉（成员头像横排）。16px：≥896px 四栏、≥576px 窄栏 + 对话；28px：1440px 是窄栏 + 对话。
 */
function useLayout(): { side: boolean; rail: boolean } {
  const calc = () => {
    if (typeof window === 'undefined') return { side: true, rail: true };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { side: window.innerWidth >= 56 * rem, rail: window.innerWidth >= 36 * rem };
  };
  const [wide, setWide] = useState(calc);
  useEffect(() => {
    const on = () => setWide((w) => {
      const n = calc();
      return n.side === w.side && n.rail === w.rail ? w : n;
    });
    window.addEventListener('resize', on);
    const mo = new MutationObserver(on);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => {
      window.removeEventListener('resize', on);
      mo.disconnect();
    };
  }, []);
  return wide;
}

export function ChatPage({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
  const [list, setList] = useState<Conversation[]>(() => {
    const l = loadConversations();
    return l.length ? l : [newConversation()];
  });
  const [currentId, setCurrentId] = useState(() => list[0]!.id);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [prefs, setPrefs] = useState<ChatPrefs>(() => loadPrefs());
  const [menu, setMenu] = useState<'none' | 'topic' | 'more'>('none');
  const [sideW, setSideW] = useState<number>(() => {
    const v = Number(typeof localStorage !== 'undefined' ? localStorage.getItem(SIDE_KEY) : NaN);
    return Number.isFinite(v) && v > 0 ? clampSide(v) : 18.75;
  });
  useEffect(() => {
    try {
      localStorage.setItem(SIDE_KEY, String(sideW));
    } catch {
      /* 存不了就算了 */
    }
  }, [sideW]);
  const [insert, setInsert] = useState<{ text: string; seq: number } | null>(null);
  const members = useMembers();
  const inboxCount = useInboxCount();
  const layout = useLayout();
  const wide = layout.side;
  const { rows: usage } = useUsage(120_000);

  const dialog = useRef<HTMLDialogElement>(null);
  const current = list.find((c) => c.id === currentId) ?? list[0]!;
  const currentMember = current.model.startsWith('aroomo/') ? members.find((m) => `aroomo/${m.id}` === current.model) : undefined;
  const singleName = currentMember?.name ?? (current.model.startsWith('aroomo/') ? current.title.replace(/^和\s*/, '') : undefined);

  useEffect(() => saveConversations(list.filter((c) => c.messages.length > 0)), [list]);
  useEffect(() => {
    savePrefs(prefs);
    // 字号和主题作用到整页：面板里嵌的管理页面也一起变大，不割裂
    applyDisplay(prefs);
  }, [prefs]);
  // 浏览器标签页标题跟着会话走（读屏切标签时能听到在哪个会话）
  useEffect(() => {
    document.title = `${view.kind === 'chat' ? current.title : view.kind === 'member' ? '成员' : view.kind === 'todo' ? view.label : TITLES[view.kind]} · Aroomo`;
  }, [current.title, view]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const show = open && !wide;
    if (show && !d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
    if (!show && d.open) (d.close ? d.close() : d.removeAttribute('open'));
  }, [open, wide]);

  const start = useCallback((opts: Parameters<typeof newConversation>[0] = {}) => {
    const c = newConversation(opts);
    setList((l) => [c, ...l.filter((x) => x.messages.length > 0)]);
    setCurrentId(c.id);
    setView({ kind: 'chat' });
    setOpen(false);
  }, []);

  // 键盘快捷键（对标 ChatGPT / LibreChat 的默认键位）：
  // Shift+Esc 回到输入框；Ctrl/⌘+Shift+O 新对话；Ctrl/⌘+Shift+S 打开或关上会话列表。Esc 停止回复由输入框自己处理。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.shiftKey && e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        setView({ kind: 'chat' });
        setTimeout(() => document.getElementById('chat-input')?.focus(), 0);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        start();
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (wide) setCollapsed((c) => !c);
        else setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start, wide]);

  const onMessages = useCallback(
    (turns: ChatTurn[]) => {
      setList((l) =>
        l
          .map((c) =>
            c.id === currentId
              ? { ...c, messages: turns, updatedAt: Date.now(), title: c.title === '新对话' ? titleFrom(turns.find((t) => t.role === 'user')?.text ?? '') : c.title }
              : c,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
    },
    [currentId],
  );

  const pick = (id: string) => {
    setCurrentId(id);
    setView({ kind: 'chat' });
    setOpen(false);
  };

  /** 点成员行：有和 TA 的单独对话就打开最近那个，没有就新开一个 */
  const chatWith = (m: Member) => {
    const c = list.find((x) => x.model === `aroomo/${m.id}`);
    if (c) pick(c.id);
    else start({ title: `和 ${m.name}`, model: `aroomo/${m.id}` });
  };

  const goto = (v: View) => {
    setView(v);
    setOpen(false);
  };

  const remove = (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c || !window.confirm(`删除会话「${c.title}」？只删本机这一份，删了找不回来。`)) return;
    const rest = list.filter((x) => x.id !== id);
    const next = rest.length ? rest : [newConversation()];
    setList(next);
    if (id === currentId) setCurrentId(next[0]!.id);
  };

  // 同一个对象（同一位成员 / 同一个群 / 负责人）的其它话题
  const topics = useMemo(
    () => list.filter((c) => c.messages.length > 0 && c.model === current.model && (c.group ?? []).join('、') === (current.group ?? []).join('、')).slice(0, 8),
    [list, current.model, current.group],
  );
  useEffect(() => {
    if (menu === 'none') return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenu('none');
    const onDown = (e: MouseEvent) => !(e.target as Element).closest?.('.topic') && setMenu('none');
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menu]);
  useEffect(() => setMenu('none'), [currentId, view.kind]);

  const allowOnlineSpeech = useCallback(() => setPrefs((p) => ({ ...p, speechOnline: true })), []);
  const memberNames = useMemo(() => members.map((m) => m.name), [members]);

  const sidebar = (
    <Sidebar
      list={list}
      currentId={view.kind === 'chat' ? currentId : null}
      members={members}
      inboxCount={inboxCount}
      active={view.kind}
      onPick={pick}
      onMember={chatWith}
      onNew={() => start()}
      onLead={() => {
        const c = list.find((x) => x.model === 'aroomo' && !x.group?.length && x.messages.length > 0);
        if (c) pick(c.id);
        else start();
      }}
      onOpen={(k) => goto({ kind: k })}
      onPlaceholder={(label) => goto({ kind: 'todo', label })}
      usage={usage}
      {...(wide ? {} : { onClose: () => setOpen(false) })}
    />
  );

  const menuButton = !wide || collapsed ? (
    <button
      type="button"
      className="icon-btn hit"
      aria-label="打开菜单：会话列表、成员、设置"
      aria-haspopup={wide ? undefined : 'dialog'}
      aria-expanded={wide ? !collapsed : open}
      onClick={() => (wide ? setCollapsed(false) : setOpen(true))}
    >
      {/* 手机照 sumus 用「←」回到会话列表；桌面收起列表后用 ≡ */}
      {wide ? <Menu aria-hidden="true" /> : <ArrowLeft aria-hidden="true" />}
    </button>
  ) : null;

  // 当前对话是谁：标题悬浮卡片、空状态、额度提示条都用它
  const isGroup = !!current.group?.length;
  const who = isGroup
    ? { name: current.title.replace(/^群聊：/, ''), kind: 'group' as const, type: `群聊 · ${current.group!.length} 位成员`, model: current.group!.join('、') }
    : singleName
      ? { name: singleName, kind: 'member' as const, type: 'AI 成员 · 单独对话', model: currentMember?.id ?? '—' }
      : { name: '负责人', kind: 'lead' as const, type: 'Aroomo 内置 · 负责人', model: '自动（设置 → 负责人）' };
  const intro = isGroup
    ? '群里的成员一起回答；没写 @ 时，自动 @ 群里每一位。'
    : currentMember
      ? currentMember.capabilityTags.length
        ? `擅长：${currentMember.capabilityTags.join('、')}。这里的话只发给 TA。`
        : '这里的话只发给 TA。'
      : singleName
        ? '这里的话只发给 TA。'
        : '没 @ 谁的时候由负责人回答；想找某位成员，用「@名字」。';
  const q = currentMember ? quotaState(usage?.find((u) => u.memberId === currentMember.id)) : null;
  const notice =
    q?.tone === 'full' ? (
      <div className="notice" role="status">
        <CircleAlert aria-hidden="true" className="notice-icon" />
        <p className="notice-title">{who.name} 今天的额度用完了</p>
        <p className="notice-text">消息还能发出去，但 TA 暂时不会回复。可以换一位成员，或者到「成员」里调高每天上限。</p>
        <button type="button" className="notice-btn hit" onClick={() => setView({ kind: 'member', id: currentMember!.id })}>
          查看成员
          <ArrowRight aria-hidden="true" />
        </button>
      </div>
    ) : null;

  let main: React.ReactNode;
  if (view.kind === 'chat') {
    main = (
      <>
        <header className="main-head">
          {menuButton}
          <HeaderCard
            title={
              isGroup ? (
                <>
                  <span aria-hidden="true" className="hash">
                    #{' '}
                  </span>
                  {who.name}
                </>
              ) : (
                who.name
              )
            }
            name={who.name}
            kind={who.kind}
            type={who.type}
            intro={intro}
            model={who.model}
            creator={who.kind === 'lead' ? 'Aroomo（内置）' : currentUser()?.displayName || currentUser()?.email || '我'}
            {...(currentMember ? { onView: () => setView({ kind: 'member', id: currentMember.id }) } : { onView: () => setView({ kind: 'members' }) })}
            extra={
              <div className="topic">
                <button type="button" className="topic-chip hit" aria-haspopup="true" aria-expanded={menu === 'topic'} aria-label={`话题：${current.messages.length ? current.title : '新话题'}，切换话题`} onClick={() => setMenu((m) => (m === 'topic' ? 'none' : 'topic'))}>
                  <span className="topic-text">{current.messages.length ? current.title : '新话题'}</span>
                  <ChevronDown aria-hidden="true" />
                </button>
                {menu === 'topic' && (
                  <div className="pop pop-topics">
                    <p className="pop-label" id="topic-pop-label">话题</p>
                    <ul aria-labelledby="topic-pop-label">
                      {topics.map((c) => (
                        <li key={c.id}>
                          <button type="button" className="pop-topic" aria-current={c.id === current.id ? 'true' : undefined} onClick={() => { setMenu('none'); pick(c.id); }}>
                            <span className={c.id === current.id ? 'pop-dot pop-dot-on' : 'pop-dot'} aria-hidden="true" />
                            <span className="pop-topic-text">
                              <span className="pop-topic-top">
                                <span className="pop-topic-title">{c.title}</span>
                                <span className="pop-topic-time">{listTimeLabel(c.updatedAt)}</span>
                              </span>
                              <span className="pop-topic-preview">{stripSignature(c.messages[c.messages.length - 1]?.text ?? '').replace(/[#*`>_~[\]()]/g, '').replace(/\s+/g, ' ').trim()}</span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="pop-item pop-new" onClick={() => { setMenu('none'); start({ title: current.title.startsWith('和 ') || isGroup ? current.title : '新对话', model: current.model, ...(isGroup ? { group: current.group! } : {}) }); }}>
                      <Plus aria-hidden="true" />
                      <span>新话题</span>
                    </button>
                  </div>
                )}
              </div>
            }
            right={
              <div className="topic">
                <button type="button" className="icon-btn hit" aria-label="更多" title="更多" aria-haspopup="true" aria-expanded={menu === 'more'} onClick={() => setMenu((m) => (m === 'more' ? 'none' : 'more'))}>
                  <Ellipsis aria-hidden="true" />
                </button>
                {menu === 'more' && (
                  <ul className="pop pop-right" aria-label="更多">
                    <li>
                      <button type="button" className="pop-item" onClick={() => { setMenu('none'); start(); }}>
                        <SquarePen aria-hidden="true" />
                        <span>新对话</span>
                      </button>
                    </li>
                    {current.messages.length > 0 && (
                      <li>
                        <button type="button" className="pop-item pop-danger" aria-label={`删除会话「${current.title}」`} onClick={() => { setMenu('none'); remove(current.id); }}>
                          <Trash2 aria-hidden="true" />
                          <span>删除会话</span>
                        </button>
                      </li>
                    )}
                  </ul>
                )}
              </div>
            }
          />
        </header>
        {viaShell && (
          <p role="alert" className="chat-error main-note">
            原生对话要直接打开 Aroomo 控制台（不经过旧的 LobeHub 外壳）才能用。
          </p>
        )}
        <Thread
          key={current.id}
          conversation={current}
          onMessages={onMessages}
          insert={insert}
          members={memberNames}
          speechRate={prefs.speechRate}
          speechOnline={prefs.speechOnline}
          onAllowOnlineSpeech={allowOnlineSpeech}
          {...(singleName ? { memberName: singleName } : {})}
          intro={intro}
          {...(notice ? { notice } : {})}
          {...(fetchImpl ? { fetchImpl } : {})}
        />
      </>
    );
  } else {
    const parent = parentOf(view);
    const member = view.kind === 'member' ? members.find((m) => m.id === view.id) : undefined;
    const title = view.kind === 'member' ? (member?.name ?? '成员') : view.kind === 'todo' ? view.label : TITLES[view.kind];
    main = (
      <>
        <PanelHeader title={title} lead={menuButton} {...(parent ? { onBack: () => setView(parent.view), backLabel: parent.label } : {})} />
        <div className="panel-scroll">
          {view.kind === 'members' && (
            <>
              <MembersPanel members={members} onOpen={(m) => setView({ kind: 'member', id: m.id })} />
              <div className="panel">
                <div className="group">
                  <button type="button" className="row row-button" onClick={() => setView({ kind: 'capmap' })}>
                    <span className="row-text">
                      <span className="row-label">能力地图</span>
                      <span className="row-hint">可以入职的模型、额度和试用期</span>
                    </span>
                  </button>
                </div>
              </div>
            </>
          )}
          {view.kind === 'member' && member && (
            <MemberDetail
              member={member}
              onChat={() => chatWith(member)}
              onMention={() => {
                setInsert((p) => ({ text: `@${member.name} `, seq: (p?.seq ?? 0) + 1 }));
                setView({ kind: 'chat' });
              }}
            />
          )}
          {view.kind === 'capmap' && <CapabilityPanel />}
          {view.kind === 'group-new' && <GroupNewPanel members={members} onStart={(names) => start({ title: `群聊：${names.join('、')}`, group: names })} />}
          {view.kind === 'settings' && <SettingsPanel prefs={prefs} setPrefs={setPrefs} onOpen={(k) => setView({ kind: k })} />}
          {view.kind === 'tools' && (
            <div className="panel panel-embed">
              <Tools />
            </div>
          )}
          {view.kind === 'inbox' && (
            <div className="panel panel-embed">
              <Inbox />
            </div>
          )}
          {view.kind === 'shortcuts' && <ShortcutsPanel />}
          {view.kind === 'todo' && (
            <div className="panel">
              <p className="todo-note" role="status">
                「{view.label}」这个位置先照 sumus 放好了，功能还没接上。之后告诉我们这里换成什么。
              </p>
            </div>
          )}
          {view.kind === 'library' && (
            <div className="panel panel-embed">
              <Library />
            </div>
          )}
          {view.kind === 'keys' && (
            <div className="panel panel-embed">
              <Keys />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={`app${prefs.highContrast ? ' chat-hc' : ''}${wide ? ' app-wide' : ''}${layout.rail ? ' app-rail' : ''}${wide && collapsed ? ' app-collapsed' : ''}`}>
      {layout.rail && <Rail active={view.kind} onOpen={(t: RailTarget) => goto({ kind: t })} onNew={() => start()} />}
      {wide && !collapsed && (
        <aside className="side" aria-label="会话列表" style={{ width: `calc(${sideW} * var(--k))` }}>
          {sidebar}
          {/* 照 sumus：会话列表可以拖宽（280–420 sumus 像素）；键盘左右方向键也能调 */}
          <div
            className="side-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整会话列表宽度"
            aria-valuemin={SIDE_MIN}
            aria-valuemax={SIDE_MAX}
            aria-valuenow={Math.round(sideW * 16)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                setSideW((w) => clampSide(w + (e.key === 'ArrowRight' ? 1.25 : -1.25)));
              }
            }}
            onPointerDown={(e) => {
              const k = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
              const x0 = e.clientX;
              const w0 = sideW;
              const move = (ev: PointerEvent) => setSideW(clampSide(w0 + (ev.clientX - x0) / k));
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }}
          />
        </aside>
      )}
      {!wide && (
        <dialog ref={dialog} className="drawer" aria-label="会话列表" onClose={() => setOpen(false)} onCancel={() => setOpen(false)}>
          {open && sidebar}
        </dialog>
      )}
      <section className="main" aria-labelledby={view.kind === 'chat' ? 'chat-title' : undefined} aria-label={view.kind === 'chat' ? undefined : '面板'}>
        {main}
      </section>
    </div>
  );
}
