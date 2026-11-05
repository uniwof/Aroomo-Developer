/**
 * 控制台里的原生对话页（#250 spike）。#250 重设计（2026-11-04）照 sumus.im 的布局：
 * - 桌面：左边会话列表栏常显（标题 + 齿轮、搜索 + 新对话、全部 / 群聊 / 成员 筛选、会话行、底部 成员 / 新建群聊 / 收件箱、最底当前账号），
 *   右边主对话区（顶栏头像 + 名字、居中日期分隔、无气泡消息、大圆角输入卡片）。
 * - 手机（或字号放大后放不下两栏）：会话列表栏就是唯一一层抽屉；点会话、成员、设置后抽屉关上，内容在主区域原地打开，
 *   面板里的下一层用顶栏「← 返回」，不开第二层抽屉，不用标签页。
 * - 只调用 Core 的标准接口（/api/*）；会话先存在本机浏览器（localStorage）。
 * 边界：store.ts 管数据和请求，Thread.tsx 管对话区，Sidebar.tsx 管会话列表栏，panels.tsx 管面板，这里管拼装。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, BookOpen, ChevronDown, ChevronRight, CircleAlert, Download, Ellipsis, KeyRound, Menu, MessagesSquare, Pencil, Plus, Settings, SquarePen, Trash2, Users, Wrench, X } from 'lucide-react';
import { api, currentUser, isFamily, viaShell, type Member } from '@/lib/api';
import { useSearchParams } from 'react-router-dom';
import { useUsage } from '@/lib/usage';
import { MeFace, Rail, meLabel, quotaState, type RailTarget } from './Rail';
import { HeaderCard } from './HeaderCard';
import { useInboxCount } from '@/lib/inbox';
import { Thread } from './Thread';
import { Sidebar } from './Sidebar';
import { BackButton, GroupNewPanel, MemberDetail, MembersPanel, PanelHeader, SETTINGS_SECTIONS, SettingsDialog, SettingsPanel, type GoTarget, type SettingsSection } from './panels';
import { applyDisplay } from '@/lib/display';
import { listTimeLabel, loadConversations, loadPrefs, newConversation, saveConversations, savePrefs, previewText, titleFrom, type ChatPrefs, type ChatTurn, type Conversation } from './store';
import { useAsk } from '@/components/Dialog';
import { FLAGS } from '@/lib/flags';
import { useAssistants } from '@/lib/assistants';
import './chat.css';

// 不常开的面板点开才下载（#250：对话页包 ≤150 KB gz）。设置、成员随对话页一起加载，打开不用等。
const LibraryView = lazy(() => import('./views').then((m) => ({ default: m.LibraryView })));
const ToolsView = lazy(() => import('./views').then((m) => ({ default: m.ToolsView })));
const ApiView = lazy(() => import('./views').then((m) => ({ default: m.ApiView })));
const AddMemberDialog = lazy(() => import('./views').then((m) => ({ default: m.AddMemberDialog })));
const Inbox = lazy(() => import('@/pages/Inbox').then((m) => ({ default: m.Inbox })));
const Audit = lazy(() => import('@/pages/Audit').then((m) => ({ default: m.Audit })));
const Executors = lazy(() => import('@/pages/Executors').then((m) => ({ default: m.Executors })));
// 助手（#250 integrate/stage2）：详情、新建弹窗、全部计划都点开才下载
const AssistantDetail = lazy(() => import('./pages/assistants/AssistantPages').then((m) => ({ default: m.AssistantDetail })));
const NewAssistantDialog = lazy(() => import('./pages/assistants/AssistantPages').then((m) => ({ default: m.NewAssistantDialog })));
const ScheduleView = lazy(() => import('./pages/assistants/AssistantPages').then((m) => ({ default: m.ScheduleView })));
const CapabilityPanel = lazy(() => import('./capability-panel').then((m) => ({ default: m.CapabilityPanel })));

/** 懒加载面板下载时：一句静态文字（不转圈，无动画） */
function Later({ children }: { children: ReactNode }) {
  return <Suspense fallback={<p role="status" className="note panel-loading">正在加载…</p>}>{children}</Suspense>;
}

/** 主区域显示什么：对话，或某个面板（带返回的上一层） */
type View =
  | { kind: 'chat' }
  | { kind: 'members' }
  | { kind: 'member'; id: string }
  | { kind: 'capmap' }
  | { kind: 'group-new' }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'tools' }
  | { kind: 'inbox' }
  | { kind: 'library' }
  | { kind: 'keys' }
  /** 所有者：审计记录（设置·安全里进入）、本机执行员（设置·执行员提醒里进入）——自审 A25，不再走旧控制台 */
  | { kind: 'audit' }
  | { kind: 'executors' }
  /** 手机底部栏「我」：设置、资源库、工具、API（负责人落地文档第 12 章） */
  | { kind: 'me' }
  /** 助手详情（固定会话 + 运行记录）、X-02 全部计划；只给所有者 */
  | { kind: 'assistant'; id: string }
  | { kind: 'schedule' };

const TITLES: Record<Exclude<View['kind'], 'chat' | 'member' | 'assistant'>, string> = {
  schedule: '全部计划',
  me: '我',
  members: '成员',
  capmap: '能力地图',
  'group-new': '挑选成员',
  settings: '设置',
  tools: '工具',
  inbox: '收件箱',
  library: '资源库',
  keys: 'API',
  audit: '审计记录',
  executors: '电脑助手',
};

/** 上一层是哪里（顶栏「← 返回」） */
function parentOf(v: View): { view: View; label: string } | null {
  switch (v.kind) {
    case 'member':
    case 'capmap':
      return { view: { kind: 'members' }, label: '成员' };
    case 'audit':
      return { view: { kind: 'settings', section: 'safety' }, label: '设置' };
    case 'executors':
      return { view: { kind: 'settings', section: 'budget' }, label: '设置' };
    case 'chat':
    case 'me':
      return null;
    default:
      return { view: { kind: 'chat' }, label: '对话' };
  }
}

/** 会话列表宽度：单位是「sumus 像素 / 16」（18.75 = sumus 的 300px），可拖 280–420 */
const SIDE_KEY = 'aroomo.chat.sideWidth.v1';
const NOTICE_KEY = 'aroomo.notice.dismissed';
const SIDE_MIN = 280;
const SIDE_MAX = 420;
const clampSide = (w: number) => Math.min(SIDE_MAX / 16, Math.max(SIDE_MIN / 16, w));

function useMembers(): [Member[], () => void] {
  const [members, setMembers] = useState<Member[]>([]);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>('GET', '/api/members')
      .then((r) => alive && setMembers(r.members.filter((m) => m.enabled && m.status === 'active')))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [seq]);
  return [members, useCallback(() => setSeq((n) => n + 1), [])];
}

/**
 * 放得下几栏：按当前字号算（栏宽用 em，跟字号一起变大）。方案 2.2：放不下先把会话列表收进抽屉，只留窄栏 + 对话；
 * 再窄（手机）连窄栏也收进抽屉。默认根字号 16px：≥1024px 三栏、≥768px 窄栏 + 对话；字号调大后按 em 自动切换。
 */
function useLayout(): { side: boolean; rail: boolean } {
  const calc = () => {
    if (typeof window === 'undefined') return { side: true, rail: true };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // 负责人落地文档 0.3：≥64em 三栏；48–64em 窄栏 + 对话（会话栏浮层）；<48em 手机排法。字大了桌面自动切过去
    return { side: window.innerWidth >= 64 * rem, rail: window.innerWidth >= 48 * rem };
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
  // 自审 B16：下面的内容滚到顶栏底下时，顶栏加一条细分隔线（大字号时不再像半行字被切掉）；换页面 / 换会话自动归零
  const [scrolledKey, setScrolledKey] = useState('');
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
  const [members, reloadMembers] = useMembers();
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(NOTICE_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const dismissNotice = (k: string) =>
    setDismissed((d) => {
      const next = [...d.filter((x) => x.endsWith(k.slice(k.indexOf(':')))), k].slice(-50);
      try {
        localStorage.setItem(NOTICE_KEY, JSON.stringify(next));
      } catch {
        /* 存不了就只在这次打开里不显示 */
      }
      return next;
    });
  /** 添加成员弹窗（落地文档 8.2）：资源库卡片带出名字，会话栏「+ 添加」、新建菜单「添加成员」打开空白的 */
  const [addMember, setAddMember] = useState<{ preset?: string } | null>(null);
  const inboxCount = useInboxCount();
  const assistantsOn = FLAGS.assistants && !isFamily();
  const { list: assistants, error: assistantsError, reload: reloadAssistants } = useAssistants(assistantsOn);
  const [newAssistant, setNewAssistant] = useState(false);
  const layout = useLayout();
  const wide = layout.side;
  /** 手机排法（<48em，或字号调大后放不下）：不用抽屉，每一层整页 + 底部栏（负责人落地文档第 12 章） */
  const phone = !layout.rail;
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
    document.title = `${view.kind === 'chat' ? current.title : view.kind === 'member' ? '成员' : view.kind === 'assistant' ? (assistants?.find((a) => a.id === view.id)?.name ?? '助手') : TITLES[view.kind]} · Aroomo`;
  }, [current.title, view, assistants]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const show = open && !wide && !phone;
    if (show && !d.open) (d.showModal ? d.showModal() : d.setAttribute('open', ''));
    if (!show && d.open) (d.close ? d.close() : d.removeAttribute('open'));
  }, [open, wide, phone]);

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

  // 设置：桌面和中等宽度照 sumus 是居中弹窗；手机（或字号大到切成手机排法）是整页
  const [settingsOpen, setSettingsOpen] = useState(false);
  const goto = (v: View | { kind: 'add-member' }) => {
    setOpen(false);
    if (v.kind === 'add-member') {
      setAddMember({});
      return;
    }
    if (v.kind === 'settings' && !phone) {
      setSettingsOpen(true);
      return;
    }
    setView(v);
  };

  // 旧链接 /keys、/members… 和消息里的「去检查 Key」都带 ?view=：在对话页里打开对应面板，然后把参数去掉；家人账号不开只给所有者的页面
  const [params, setParams] = useSearchParams();
  const want = params.get('view');
  useEffect(() => {
    if (!want) return;
    const ownerOnly = ['library', 'tools', 'keys', 'audit', 'executors'];
    const ok = ['members', 'tools', 'library', 'inbox', 'executors', 'keys', 'audit', 'settings'];
    if (ok.includes(want) && !(isFamily() && ownerOnly.includes(want))) goto({ kind: want } as View);
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want]);

  const ask = useAsk();
  const remove = async (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c || !(await ask.confirm({ title: `删除会话「${c.title}」？`, desc: '只删本机这一份，删了找不回来。', ok: '删除', danger: true }))) return;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 关菜单后焦点回到打开它的按钮（键盘、读屏用户不丢位置）
      document.querySelector<HTMLElement>('.topic [aria-expanded="true"]')?.focus();
      setMenu('none');
    };
    const onDown = (e: MouseEvent) => !(e.target as Element).closest?.('.topic') && setMenu('none');
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menu]);
  useEffect(() => setMenu('none'), [currentId, view.kind]);

  const rename = async (id: string) => {
    const c = list.find((x) => x.id === id);
    if (!c) return;
    const t = (await ask.prompt({ title: '重命名话题', label: '新名字', value: c.title }))?.trim();
    if (t) setList((l) => l.map((x) => (x.id === id ? { ...x, title: t.slice(0, 60) } : x)));
  };
  /** 导出成 Markdown 文件（只在本机生成，不上传） */
  const exportMd = (c: Conversation) => {
    const md = [`# ${c.title}`, '', ...c.messages.map((m) => `**${m.role === 'user' ? '我' : '回复'}**${m.at ? `（${new Date(m.at).toLocaleString('zh-CN')}）` : ''}\n\n${m.text}\n`)].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    a.download = `${c.title.replace(/[\\/:*?"<>|]/g, '_')}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

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
      usage={usage}
      {...(assistantsOn
        ? {
            assistants,
            assistantsError,
            currentAssistant: view.kind === 'assistant' ? view.id : null,
            onAssistant: (id: string) => {
              setOpen(false);
              setView({ kind: 'assistant', id });
            },
            onNewAssistant: () => {
              setOpen(false);
              setNewAssistant(true);
            },
            ...(FLAGS.schedulePage
              ? {
                  onSchedule: () => {
                    setOpen(false);
                    setView({ kind: 'schedule' });
                  },
                }
              : {}),
          }
        : {})}
      {...(wide || phone ? {} : { onClose: () => setOpen(false) })}
    />
  );

  /** 手机上「←」回到哪一层：成员、我是底部栏的顶层页，没有返回；我 里的四项回到 我；收件箱、挑选成员回到会话列表（名字和底部栏一样叫「对话」） */
  const phoneParent = (v: View): { go: () => void; label: string; aria?: string } | null => {
    if (v.kind === 'members' || v.kind === 'me') return null;
    if (v.kind === 'settings' && v.section) return { go: () => setView({ kind: 'settings' }), label: '设置' };
    if (v.kind === 'settings' || v.kind === 'library' || v.kind === 'tools' || v.kind === 'keys') return { go: () => setView({ kind: 'me' }), label: '我' };
    if (v.kind === 'inbox' || v.kind === 'group-new' || v.kind === 'assistant' || v.kind === 'schedule') return { go: () => { setView({ kind: 'chat' }); setOpen(true); }, label: '对话', aria: '返回对话列表' };
    const p = parentOf(v);
    return p ? { go: () => setView(p.view), label: p.label } : null;
  };

  // 桌面收起列表 / 中等宽度：≡ 打开会话列表。手机对话页：和面板一样的「← 对话」（Poke ③ 返回键全站一种）
  const menuButton = phone ? (
    <BackButton label="对话" ariaLabel="返回对话列表" onClick={() => setOpen(true)} />
  ) : !wide || collapsed ? (
    <button
      type="button"
      className="icon-btn hit"
      aria-label="打开菜单：会话列表、成员、设置"
      aria-haspopup={wide ? undefined : 'dialog'}
      aria-expanded={wide ? !collapsed : open}
      onClick={() => (wide ? setCollapsed(false) : setOpen(true))}
    >
      <Menu aria-hidden="true" />
    </button>
  ) : null;

  // 当前对话是谁：标题悬浮卡片、空状态、额度提示条都用它
  const isGroup = !!current.group?.length;
  const who = isGroup
    ? { name: current.title.replace(/^群聊：/, ''), kind: 'group' as const, type: `群聊 · ${current.group!.length} 位成员`, model: current.group!.join('、') }
    : singleName
      ? { name: singleName, kind: 'member' as const, type: `云端成员 · 今日${currentMember ? quotaState(usage?.find((u) => u.memberId === currentMember.id)).label : '额度未知'}`, model: '—' }
      : { name: '全员', kind: 'lead' as const, type: `全员对话 · 负责人和 ${members.length} 位成员`, model: '自动挑选' };
  const intro = isGroup
    ? '挑的这几位都在。直接说，负责人回答；@ 谁，谁回答。'
    : currentMember
      ? currentMember.capabilityTags.length
        ? `擅长：${currentMember.capabilityTags.join('、')}。这里的话只发给 TA。`
        : '这里的话只发给 TA。'
      : singleName
        ? '这里的话只发给 TA。'
        : '所有成员都在。直接说，负责人回答；@ 谁，谁回答。';
  const q = currentMember ? quotaState(usage?.find((u) => u.memberId === currentMember.id)) : null;
  // 自审 A16：提示条可关，关了当天这位成员不再出现（只记在本机）
  const noticeKey = currentMember ? `${currentMember.id}:${new Date().toLocaleDateString('sv-SE')}` : '';
  const notice =
    q?.tone === 'full' && !dismissed.includes(noticeKey) ? (
      <div className="notice" role="status">
        <CircleAlert aria-hidden="true" className="notice-icon" />
        <p className="notice-title">{who.name} 今天的额度用完了</p>
        <p className="notice-text">消息还能发出去，但 TA 暂时不会回复。可以换一位成员，或者到「成员」里调高每天上限。</p>
        <button type="button" className="notice-btn hit" onClick={() => setView({ kind: 'group-new' })}>
          换个成员
          <ArrowRight aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn hit notice-close" aria-label="关掉提示，今天不再显示" onClick={() => dismissNotice(noticeKey)}>
          <X aria-hidden="true" />
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
                              <span className="pop-topic-preview">{previewText(c.messages[c.messages.length - 1]?.text ?? '')}</span>
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
                    {/* 负责人落地文档 4.1：重命名话题、导出（Markdown）、删除话题；「置顶」等置顶功能做好再加 */}
                    {current.messages.length > 0 && (
                      <li>
                        <button type="button" className="pop-item" onClick={() => { setMenu('none'); void rename(current.id); }}>
                          <Pencil aria-hidden="true" />
                          <span>重命名话题</span>
                        </button>
                      </li>
                    )}
                    {current.messages.length > 0 && (
                      <li>
                        <button type="button" className="pop-item" onClick={() => { setMenu('none'); exportMd(current); }}>
                          <Download aria-hidden="true" />
                          <span>导出为 Markdown</span>
                        </button>
                      </li>
                    )}
                    <li>
                      <button type="button" className="pop-item" onClick={() => { setMenu('none'); start(); }}>
                        <SquarePen aria-hidden="true" />
                        <span>新对话</span>
                      </button>
                    </li>
                    {current.messages.length > 0 && (
                      <li>
                        <button type="button" className="pop-item pop-danger" aria-label={`删除会话「${current.title}」`} onClick={() => { setMenu('none'); void remove(current.id); }}>
                          <Trash2 aria-hidden="true" />
                          <span>删除话题</span>
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
            对话要直接打开 Aroomo 网页才能用，请从书签或首页进入。
          </p>
        )}
        <Thread
          key={current.id}
          conversation={current}
          onMessages={onMessages}
          insert={insert}
          members={current.group?.length ? current.group : memberNames}
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
    const parent = phone ? phoneParent(view) : parentOf(view);
    const member = view.kind === 'member' ? members.find((m) => m.id === view.id) : undefined;
    const title = view.kind === 'member' ? (member?.name ?? '成员') : view.kind === 'assistant' ? (assistants?.find((a) => a.id === view.id)?.name ?? '助手') : view.kind === 'settings' && view.section ? SETTINGS_SECTIONS.find((x) => x.id === view.section)!.label : TITLES[view.kind];
    main = (
      <>
        <PanelHeader title={title} lead={phone ? null : menuButton} {...(parent ? { onBack: () => ('go' in parent ? parent.go() : parent.view.kind === 'settings' ? goto(parent.view) : setView(parent.view)), backLabel: parent.label, ...('aria' in parent && parent.aria ? { backAria: parent.aria } : {}) } : {})} />
        <div className="panel-scroll">
          <Later>
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
          {view.kind === 'assistant' && <AssistantDetail key={view.id} id={view.id} members={members} onChanged={reloadAssistants} onInbox={() => setView({ kind: 'inbox' })} />}
          {view.kind === 'schedule' && <ScheduleView list={assistants} error={assistantsError} members={members} onOpen={(id) => setView({ kind: 'assistant', id })} onChanged={reloadAssistants} />}
          {view.kind === 'group-new' && (
            <GroupNewPanel
              members={members}
              onStart={(names) => {
                // 只挑一位 = 和 TA 单聊；两位以上 = 这几位在场，默认负责人回答，@ 谁谁答（落地方案 v2 第 1 节，不让每位都回一遍）
                const one = names.length === 1 ? members.find((m) => m.name === names[0]) : undefined;
                if (one) chatWith(one);
                else start({ title: `群聊：${names.join('、')}`, group: names });
              }}
            />
          )}
          {view.kind === 'settings' && <SettingsPanel prefs={prefs} setPrefs={setPrefs} members={members} {...(view.section ? { section: view.section } : {})} onOpen={(k) => setView({ kind: 'settings', section: k })} onGo={(k: GoTarget) => setView({ kind: k })} />}
          {view.kind === 'tools' && <ToolsView onGo={(k) => setView({ kind: k })} />}
          {view.kind === 'inbox' && (
            <div className="panel panel-embed">
              <Inbox onBack={() => setView({ kind: 'chat' })} />
            </div>
          )}
          {view.kind === 'me' && (
            <div className="panel">
              <ul className="me-list" aria-label="我">
                {(
                  [
                    ['settings', '设置', Settings],
                    ['library', '资源库', BookOpen],
                    ['tools', '工具', Wrench],
                    ['keys', 'API', KeyRound],
                  ] as const
                ).filter(([k]) => k === 'settings' || !isFamily()).map(([k, label, Icon]) => (
                  <li key={k}>
                    <button type="button" className="me-row" onClick={() => goto({ kind: k })}>
                      <Icon aria-hidden="true" />
                      <span className="me-row-label">{label}</span>
                      <ChevronRight aria-hidden="true" className="me-row-go" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.kind === 'library' && <LibraryView onAddMember={(preset) => setAddMember(preset ? { preset } : {})} />}
          {view.kind === 'keys' && <ApiView members={members} />}
          {view.kind === 'audit' && (
            <div className="panel panel-embed">
              <Audit />
            </div>
          )}
          {view.kind === 'executors' && (
            <div className="panel panel-embed">
              <Executors />
            </div>
          )}
          </Later>
        </div>
      </>
    );
  }

  /** 手机底部栏只在三个顶层页出现；进了对话或下一层就藏起来（照 sumus） */
  const tab = !phone ? null : open && view.kind === 'chat' ? 'chats' : view.kind === 'members' ? 'members' : view.kind === 'me' ? 'me' : null;

  return (
    <div className={`app${prefs.highContrast ? ' chat-hc' : ''}${wide ? ' app-wide' : ''}${layout.rail ? ' app-rail' : ''}${phone ? ' app-phone' : ''}${wide && collapsed ? ' app-collapsed' : ''}`}>
      {layout.rail && <Rail active={settingsOpen && !phone ? 'settings' : view.kind} onOpen={(t: RailTarget) => goto({ kind: t })} usage={usage} />}
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
      {ask.node}
      <SettingsDialog open={settingsOpen && !phone} onClose={() => setSettingsOpen(false)} prefs={prefs} setPrefs={setPrefs} members={members} onGo={(k: GoTarget) => { setSettingsOpen(false); setView({ kind: k }); }} />
      {addMember && (
        <Suspense fallback={null}>
      <AddMemberDialog
        open
        {...(addMember?.preset ? { preset: addMember.preset } : {})}
        onClose={() => setAddMember(null)}
        onAdded={() => reloadMembers()}
        {...(view.kind === 'library' ? {} : { onExplore: () => { setAddMember(null); goto({ kind: 'library' }); } })}
      />
        </Suspense>
      )}
      {newAssistant && (
        <Suspense fallback={null}>
          <NewAssistantDialog
            members={members}
            onClose={() => setNewAssistant(false)}
            onCreated={(a) => {
              setNewAssistant(false);
              reloadAssistants();
              setView({ kind: 'assistant', id: a.id });
            }}
          />
        </Suspense>
      )}
      {!wide && !phone && (
        <dialog ref={dialog} className="drawer" aria-label="会话列表" onClose={() => setOpen(false)} onCancel={() => setOpen(false)}>
          {open && sidebar}
        </dialog>
      )}
      {phone && open && view.kind === 'chat' ? (
        <main className="main phone-list" aria-labelledby="phone-list-title">
          {/* 自审 B12：手机列表页也有 main 地标和 h1 */}
          <h1 id="phone-list-title" className="sr-only">
            对话列表
          </h1>
          {sidebar}
        </main>
      ) : (
        <main
          className="main"
          aria-labelledby={view.kind === 'chat' ? 'chat-title' : undefined}
          aria-label={view.kind === 'chat' ? undefined : '面板'}
          data-scrolled={scrolledKey === `${view.kind}:${currentId}` ? '' : undefined}
          onScrollCapture={(e) => {
            const k = `${view.kind}:${currentId}`;
            const on = (e.target as HTMLElement).scrollTop > 0;
            if (on !== (scrolledKey === k)) setScrolledKey(on ? k : '');
          }}
        >
          {main}
        </main>
      )}
      {phone && tab && (
        <nav className="tabbar" aria-label="主导航">
          <button type="button" className="tab hit" aria-current={tab === 'chats' ? 'page' : undefined} onClick={() => { setView({ kind: 'chat' }); setOpen(true); }}>
            <MessagesSquare aria-hidden="true" />
            <span>对话</span>
          </button>
          <button type="button" className="tab hit" aria-current={tab === 'members' ? 'page' : undefined} onClick={() => goto({ kind: 'members' })}>
            <Users aria-hidden="true" />
            <span>成员</span>
          </button>
          <button type="button" className="tab hit" aria-label={`我：${meLabel(usage)}`} aria-current={tab === 'me' ? 'page' : undefined} onClick={() => goto({ kind: 'me' })}>
            <MeFace usage={usage} />
            <span aria-hidden="true">我</span>
          </button>
        </nav>
      )}
    </div>
  );
}
