/**
 * 控制台里的原生对话页（#250 spike）。#250 重设计（2026-11-04）照 sumus.im 的布局：
 * - 桌面：左边会话列表栏常显（标题 + 齿轮、搜索 + 新对话、全部 / 群聊 / 成员 筛选、会话行、底部 成员 / 新建群聊 / 收件箱、最底当前账号），
 *   右边主对话区（顶栏头像 + 名字、居中日期分隔、无气泡消息、大圆角输入卡片）。
 * - 手机（或字号放大后放不下两栏）：会话列表栏就是唯一一层抽屉；点会话、成员、设置后抽屉关上，内容在主区域原地打开，
 *   面板里的下一层用顶栏「← 返回」，不开第二层抽屉，不用标签页。
 * - 只调用 Core 的标准接口（/api/*）；会话存在 Core（开关 FLAGS.savedChats，saved.ts），Core 拿不到时退回本机浏览器（localStorage）。
 * 边界：store.ts 管数据和请求，Thread.tsx 管对话区，Sidebar.tsx 管会话列表栏，panels.tsx 管面板，这里管拼装。
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowRight, BookOpen, ChevronDown, ChevronRight, CircleAlert, Download, Ellipsis, KeyRound, Menu, MessagesSquare, Pencil, Plus, Settings, SquarePen, Trash2, Users, Wrench, X } from 'lucide-react';
import { api, currentUser, fetchAccount, isFamily, viaShell, type Member } from '@/lib/api';
import { useLocation, useNavigate } from 'react-router-dom';
import { OWNER_ONLY, legacyPath, pathOf, viewOf, type View } from './routes';
import { useUsage } from '@/lib/usage';
import { MeFace, Rail, meLabel, quotaState, type RailTarget } from './Rail';
import { HeaderCard } from './HeaderCard';
import { useInboxCount } from '@/lib/inbox';
import { Thread, type DraftActions } from './Thread';
import { OFFLINE_NOTE, ONLINE_AGAIN, useOnline } from './online';
import { SIDE_UI, Sidebar, type SideUi } from './Sidebar';
import { BackButton, ExternalPanel, GroupNewPanel, MemberDetail, MembersPanel, PanelHeader, SETTINGS_SECTIONS, SettingsDialog, SettingsPanel, type GoTarget } from './panels';
import { applyDisplay } from '@/lib/display';
import { ClaimFullError, claimLegacy, legacyClaimed, listTimeLabel, loadConversations, loadPrefs, newConversation, saveConversations, savePrefs, previewText, titleFrom, type ChatPrefs, type ChatTurn, type Conversation } from './store';
import { useAsk } from '@/components/Dialog';
import { FLAGS } from '@/lib/flags';
import { useAssistants, type AssistantInput } from '@/lib/assistants';
import { archiveConversation, createConversation, fetchConversation, fetchConversations, fetchMessages, importLocalOnce, localPending, markRead, mergeRemote, renameConversation } from './saved';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import './chat.css';

// 不常开的面板点开才下载（#250：对话页包 ≤150 KB gz）。设置、成员随对话页一起加载，打开不用等。
const LibraryView = lazy(() => import('./views').then((m) => ({ default: m.LibraryView })));
const ToolsView = lazy(() => import('./views').then((m) => ({ default: m.ToolsView })));
const ApiView = lazy(() => import('./views').then((m) => ({ default: m.ApiView })));
const Cockpit = lazy(() => import('./cockpit').then((m) => ({ default: m.Cockpit })));
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

const TITLES: Record<Exclude<View['kind'], 'chat' | 'member' | 'assistant'>, string> = {
  console: '驾驶舱',
  schedule: '全部计划',
  me: '我',
  members: '成员',
  capmap: '能力地图',
  mcp: '外部接入',
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
      return { view: { kind: 'members' }, label: '成员' };
    case 'capmap':
    case 'mcp':
      return { view: { kind: 'library' }, label: '资源库' };
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
/** 有消息的会话（存在 Core 里、还没取消息的看条数） */
const hasMsgs = (c: Conversation) => c.messages.length > 0 || !!c.remote?.count;
/** 存库的会话列表多久刷新一次（未读、进行中） */
const LIST_REFRESH_MS = 60_000;
/** 列表还没到时先发的话：最多等这么久，还没到就退回本机（话存本机，不丢） */
export const LIST_WAIT_MS = 8_000;

/**
 * 全部成员（成员页要列候选、停用的；对话、@ 只用在职的）。
 * upsert：Core 回了新成员 / 改过的成员就立刻放进列表（添加后资源库卡片马上变「打开成员」，停用后详情马上变，审计清单 17）。
 * failed：列表没拿到（成员页给「重试」，不再假装「还没有成员」）。
 */
function useMembers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [failed, setFailed] = useState(false);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>('GET', '/api/members')
      .then((r) => {
        if (!alive) return;
        setMembers(r.members);
        setFailed(false);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [seq]);
  const reload = useCallback(() => setSeq((n) => n + 1), []);
  const upsert = useCallback((m: Member) => setMembers((l) => (l.some((x) => x.id === m.id) ? l.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [...l, m])), []);
  return { members, failed, reload, upsert };
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
  const saved = FLAGS.savedChats;
  /**
   * #287：本机会话按账号分开存。先用登录时记下的账号 id；存库模式下以 Core（/api/auth/me）说的为准。
   * null = 不知道是谁（如从 Shell 打开、旧的登录记录）：照旧用共用的那份，永不导入。
   */
  const [acct, setAcct] = useState<string | null>(() => currentUser()?.id || null);
  const acctRef = useRef(acct);
  acctRef.current = acct;
  /** 列表里的本机会话是哪个账号那份的：和 acct 不一样时不写本机（负责人 #288 必改 2：账号刚问到时不能把共用那份存进她的账号） */
  const listAcct = useRef(acct);
  /** #292：本机模式下先问到 Core 是谁再保存（问不到也算问过），免得刚打开就发的话写进共用那份；存库模式只在退回本机时写，照旧 */
  const [acctChecked, setAcctChecked] = useState<boolean>(saved);
  /** #290：Core 确认过的所有者账号（认领旧的共用那份只给她）；null = 不是所有者或没确认 */
  const [ownerAcct, setOwnerAcct] = useState<string | null>(null);
  const [list, setList] = useState<Conversation[]>(() => {
    // 存库模式下家人账号不读本机（家人的会话不导入 Core）
    const l = saved && isFamily() ? [] : loadConversations(acct);
    return l.length ? l : [newConversation()];
  });
  const [currentId, setCurrentId] = useState(() => list[0]!.id);
  /** null = 还在问 Core；true = 会话存在 Core；false = 用本机（开关关，或 Core 拿不到） */
  const [remote, setRemote] = useState<boolean | null>(saved ? null : false);
  const [msgError, setMsgError] = useState<{ id: string; seq: number } | null>(null);
  const [focusMsg, setFocusMsg] = useState<string | undefined>();
  const [runningId, setRunningId] = useState<string | null>(null);
  const listRef = useRef(list);
  listRef.current = list;
  const currentRef = useRef(currentId);
  currentRef.current = currentId;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;
  /** 列表到了（或退回本机）就放行：列表没到时先发的话在这儿排队 */
  const ready = useRef<{ wait: Promise<void>; done: () => void } | null>(null);
  if (!ready.current) {
    let done = () => {};
    const wait = new Promise<void>((r) => (done = r));
    ready.current = { wait, done };
  }
  useEffect(() => {
    if (remote !== null) ready.current!.done();
  }, [remote]);
  /** 打开页面时本机已有的会话和它们当时的消息数（这些会导入 Core）；比这多出来的消息是还没存的 */
  const atMount = useRef<Map<string, number> | null>(null);
  if (!atMount.current) atMount.current = new Map(list.filter((c) => !c.remote).map((c) => [c.id, c.messages.length]));
  /** 正在排队等列表的会话（话还在对话区里、没进列表，列表盖上来时不能丢） */
  const waiting = useRef(new Set<string>());
  /** 本机会话里还没存到 Core 的话（列表没到时就发了，或建会话失败） */
  const unsaved = (c: Conversation) => !c.remote && (waiting.current.has(c.id) || c.messages.length > (atMount.current!.get(c.id) ?? 0));
  /** Core 的列表盖上来：已取过的消息、正打开的本机新会话、还没存的话都留着 */
  const adopt = useCallback((prev: Conversation[], fresh: Conversation[]) => {
    // 有消息的本机旧会话已经导入过（id 可能换成了算出来的 uuid），以 Core 那份为准；但多出来没存的话一条不丢
    const dirty = new Map(prev.filter(unsaved).map((c) => [c.id, c]));
    const next = mergeRemote(prev.filter((c) => c.remote || dirty.has(c.id) || (c.id === currentRef.current && c.messages.length === 0)), fresh, currentRef.current).map((c) => {
      const d = dirty.get(c.id);
      // 同一个 id 在 Core 已有（导入过的旧会话里又说了话）：用本机这份消息，下一句发出时 Core 照常追加
      return d && c.remote ? { ...c, messages: d.messages, remote: { ...c.remote, loaded: true } } : c;
    });
    return next.length ? next : [newConversation()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 已经定了用 Core 还是本机：之后晚到的列表不再改主意 */
  const settled = useRef(false);
  /** 退回本机：本机模式会把列表（含没存的话）写进浏览器 */
  const fallBack = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    setRemote(false);
  }, []);
  /** 阶段 3「一键导入」：这台浏览器里还没存到 Core 的本机会话段数（只给所有者；自动导入那次失败或之后又多了才会 >0） */
  const [localLeft, setLocalLeft] = useState(0);
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** Core 确认过的账号（只有它的本机会话能导入）；null = 没确认，不导入 */
  const confirmed = useRef<string | null>(null);
  const importNow = async () => {
    const me = confirmed.current;
    if (!me) return;
    const n = localPending(me);
    setImporting(true);
    setImportNote(null);
    try {
      await importLocalOnce(me);
    } catch {
      setImportNote({ ok: false, text: '没导进去，本机那份还在。过一会儿再点一次。' });
      setImporting(false);
      return;
    }
    setLocalLeft(localPending(me));
    setImportNote({ ok: true, text: `导入好了 ${n} 段会话。` });
    setImporting(false);
    // 导完重取列表，导入的会话马上出现；取不到也没关系，定时刷新会带上
    fetchConversations()
      .then((fresh) => setList((prev) => adopt(prev, fresh)))
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!saved) return;
    let alive = true;
    void (async () => {
      try {
        // 所有者：她自己存的本机会话导入一次（本机那份不删）；导入失败不挡着打开，下次再试。
        // #287：账号以 Core 说的为准，问不到就不导；家人的、旧的共用那份都不导
        const who = isFamily() ? null : await fetchAccount();
        const me = who?.id ?? null;
        if (me) await importLocalOnce(me).catch(() => 0);
        const fresh = await fetchConversations();
        if (!alive || settled.current) return;
        settled.current = true;
        // 页面记的账号和 Core 的不一样（或原来不知道）：之前读进来的本机会话不是这个账号的，不留
        const switched = !!me && me !== acctRef.current;
        if (me) {
          confirmed.current = me;
          if (who?.owner) setOwnerAcct(me);
          listAcct.current = me;
          setAcct(me);
          setLocalLeft(localPending(me));
        }
        setList((prev) => {
          // 正打开的空白新会话留着（没内容，不算带过去）：输入框不重建，她问到之前打的字不丢（#291）
          const next = adopt(switched ? prev.filter((c) => c.remote || (c.id === currentRef.current && c.messages.length === 0)) : prev, fresh);
          if (!next.some((c) => c.id === currentRef.current)) setCurrentId(next[0]!.id);
          return next;
        });
        setRemote(true);
      } catch {
        if (alive) fallBack();
      }
    })();
    return () => {
      alive = false;
    };
  }, [saved, adopt, fallBack]);
  // 本机模式（负责人 #288 必改 1）：账号也以 Core 为准；标签页里没记、或记的不一样，换成这个账号自己那份。问不到才用页面记的 / 共用那份
  useEffect(() => {
    if (saved) return;
    let alive = true;
    void fetchAccount().then((who) => {
      if (!alive) return;
      const me = who?.id ?? null;
      if (me && me !== acctRef.current) {
        // 先换列表、再换账号（同一次更新）：保存只在列表和账号对得上时才写。
        // #292：问到之前在这页新开、说过话的会话（打开时没有或是空的）是她的，带过去；读进来的旧那份不带
        // 正打开的空白新会话也留着（没内容）：输入框不重建，问到之前打的字不丢（#291）
        const carry = listRef.current.filter((c) => !c.remote && (atMount.current!.get(c.id) ?? 0) === 0 && (c.messages.length > 0 || c.id === currentRef.current));
        // 打开时读进来的旧会话里接着说过的话（问到之前没存）：存回它原来那份，不丢，也不带进这个账号
        const was = listAcct.current;
        const touched = listRef.current.filter((c) => !c.remote && (atMount.current!.get(c.id) ?? 0) > 0 && c.messages.length > atMount.current!.get(c.id)!);
        if (touched.length) {
          const t = new Map(touched.map((c) => [c.id, c]));
          // 存回的是共用那份时，「已认领」记号对不上了，提示和按钮会重新出来（负责人 #294 第二轮、#298）
          saveConversations(loadConversations(was).map((c) => t.get(c.id) ?? c), was);
        }
        const keep = new Set(carry.map((c) => c.id));
        const mine = [...carry, ...loadConversations(me).filter((c) => !keep.has(c.id))];
        const next = mine.length ? mine : [newConversation()];
        listAcct.current = me;
        setList(next);
        if (!keep.has(currentRef.current)) setCurrentId(next[0]!.id);
        setAcct(me);
      }
      if (me && who?.owner) setOwnerAcct(me);
      setAcctChecked(true);
    });
    return () => {
      alive = false;
    };
  }, [saved]);
  useEffect(() => {
    if (remote !== true) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      fetchConversations()
        .then((fresh) => setList((prev) => adopt(prev, fresh)))
        .catch(() => undefined);
    }, LIST_REFRESH_MS);
    return () => clearInterval(t);
  }, [remote, adopt]);
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // 面板由地址决定（切片 2 / 审计 C3）：直接打开、刷新、前进后退都对
  const location = useLocation();
  const navigate = useNavigate();
  const navRef = useRef({ navigate, location });
  navRef.current = { navigate, location };
  const routed = viewOf(location.pathname, location.search);
  /** 只给所有者的面板：家人打开这些地址落到对话 */
  const blocked =
    (isFamily() && OWNER_ONLY.includes(routed.kind)) ||
    // 助手开关关着时这两个地址也落到对话（全部计划另有开关）
    (routed.kind === 'assistant' && !FLAGS.assistants) ||
    (routed.kind === 'schedule' && !(FLAGS.assistants && FLAGS.schedulePage));
  const setView = useCallback((v: View, opts: { replace?: boolean; state?: unknown } = {}) => {
    const { navigate: nav, location: loc } = navRef.current;
    const to = pathOf(v);
    if (to === loc.pathname + loc.search) return;
    nav(to, { replace: !!opts.replace, ...(opts.state !== undefined ? { state: opts.state } : {}) });
  }, []);
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
  // F-020 断网：判断和读屏播报放在整页这一层，挂几个对话都只播一次；状态稳定后才切换（online.ts），打开时就断网不播、那行字在
  const online = useOnline();
  const [netSay, setNetSay] = useState('');
  const wasOnline = useRef(online);
  useEffect(() => {
    if (wasOnline.current === online) return;
    wasOnline.current = online;
    setNetSay(online ? ONLINE_AGAIN : OFFLINE_NOTE);
  }, [online]);
  const [sideUi, setSideUi] = useState<SideUi>(SIDE_UI);
  const { members: allMembers, failed: membersFailed, reload: reloadMembers, upsert: upsertMember } = useMembers();
  const members = useMemo(() => allMembers.filter((m) => m.enabled && m.status === 'active'), [allMembers]);
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
  /** 新建助手弹窗：initial = 聊天草稿卡「改一改」带来的内容，onDone = 建好后把那张卡标成已建 */
  const [newAssistant, setNewAssistant] = useState<{ initial?: AssistantInput; onDone?: () => void } | null>(null);
  // X-15：聊天里的助手草稿卡（只给所有者；开关关时不显示）
  const draftActions = useMemo<DraftActions | undefined>(
    () =>
      assistantsOn && FLAGS.assistantDraft
        ? { members, onEdit: (initial, onDone) => setNewAssistant({ initial, onDone }), onCreated: () => reloadAssistants() }
        : undefined,
    [assistantsOn, members, reloadAssistants],
  );
  const layout = useLayout();
  const wide = layout.side;
  /** 手机排法（<48em，或字号调大后放不下）：不用抽屉，每一层整页 + 底部栏（负责人落地文档第 12 章） */
  const phone = !layout.rail;
  // 桌面的设置是弹窗：主区域显示打开它的那一页（state.bg），弹窗分组跟着地址
  const settingsOpen = !phone && !blocked && routed.kind === 'settings';
  const settingsBg = ((location.state as { bg?: unknown } | null)?.bg as string | undefined) ?? '/chat';
  const bgView = (() => {
    const [bp, bs = ''] = settingsBg.split('?');
    const v = viewOf(bp ?? '/chat', bs ? `?${bs}` : '');
    return v.kind === 'settings' ? ({ kind: 'chat' } as View) : v;
  })();
  const view: View = blocked ? { kind: 'chat' } : settingsOpen ? bgView : routed;
  const { rows: usage } = useUsage(120_000);

  const dialog = useRef<HTMLDialogElement>(null);
  const current = list.find((c) => c.id === currentId) ?? list[0]!;
  const currentMember = current.model.startsWith('aroomo/') ? members.find((m) => `aroomo/${m.id}` === current.model) : undefined;
  const singleName = currentMember?.name ?? (current.model.startsWith('aroomo/') ? current.title.replace(/^和\s*/, '') : undefined);

  // 本机模式才写本机；存库模式下本机那份（导入前的）原样留着，不覆盖
  useEffect(() => {
    if (remote === false && acctChecked && listAcct.current === acct) saveConversations(list.filter((c) => c.messages.length > 0 && !c.remote), acct);
  }, [list, remote, acct, acctChecked]);
  /** #287：旧的共用那份里有几段（知道账号时才数）：看不出是谁存的，不导入、不删、不进列表，只说一句 */
  const [claimTick, setClaimTick] = useState(0);
  const legacy = useMemo(
    () => (acct && !legacyClaimed(acct) ? loadConversations(null).filter((c) => c.messages.length > 0) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [acct, claimTick],
  );
  const legacyLeft = legacy.length;
  /** #290：只有 Core 确认的所有者、且就是现在这份列表的账号，才给「放进我的账号」 */
  const canClaim = !!acct && ownerAcct === acct && legacyLeft > 0;
  const [claimNote, setClaimNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** 点完按钮就没了：焦点移到结果那句上，读屏和放大镜不迷路（负责人 #294 建议 1） */
  const claimNoteRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (claimNote) claimNoteRef.current?.focus();
  }, [claimNote]);
  const claimNow = () => {
    const me = ownerAcct;
    if (!me || me !== acct) return;
    let n: number;
    try {
      n = claimLegacy(me);
    } catch (e) {
      setClaimNote({ ok: false, text: e instanceof ClaimFullError ? '放不下了：你账号里的会话太多。原来那份还在，没有丢。请告诉 Hark。' : '没放进去，原来那份还在。过一会儿再点一次。' });
      return;
    }
    setClaimTick((t) => t + 1);
    setClaimNote({ ok: true, text: `放进你的账号了：${n} 段会话。原来那份还留在这台浏览器里。` });
    // 存库：交给导入（按 id 幂等），导完重取列表；本机：直接并进列表（保存会写回她那份）
    if (remote === true) {
      void importNow();
      return;
    }
    // 新复制的加进来，被替换的那段换成新的（不然保存会用列表里旧的盖回去）
    const mine = new Map(loadConversations(me).map((c) => [c.id, c]));
    setList((prev) => {
      const have = new Set(prev.map((c) => c.id));
      const next = [...prev.map((c) => (c.remote ? c : (mine.get(c.id) ?? c))), ...[...mine.values()].filter((c) => !have.has(c.id))];
      return next.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  };
  // 打开存库的会话：消息还没取就取；有未读就标已读
  const needLoad = !!current.remote && !current.remote.loaded;
  useEffect(() => {
    if (!needLoad) return;
    const id = current.id;
    let alive = true;
    fetchMessages(id)
      .then((messages) => {
        if (!alive) return;
        setMsgError(null);
        setList((l) => l.map((x) => (x.id === id && x.remote ? { ...x, messages, remote: { ...x.remote, loaded: true } } : x)));
      })
      .catch(() => alive && setMsgError((e) => ({ id, seq: e?.seq ?? 0 })));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, needLoad, msgError?.seq]);
  const unreadNow = view.kind === 'chat' && !!current.remote?.unread;
  useEffect(() => {
    if (!unreadNow) return;
    const id = current.id;
    void markRead(id).catch(() => undefined);
    setList((l) => l.map((x) => (x.id === id && x.remote ? { ...x, remote: { ...x.remote, unread: false } } : x)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.id, unreadNow]);

  /** 发第一句时在 Core 建会话（id 用本机这个，一般不变）；本机模式返回 null */
  const persist = useCallback(async (text: string): Promise<string | null> => {
    // 列表还没到：这句先排队，等列表（最多 LIST_WAIT_MS），等不到就退回本机存
    if (remoteRef.current === null) {
      const id = currentRef.current;
      waiting.current.add(id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ready.current!.wait, new Promise<void>((r) => (timer = setTimeout(r, LIST_WAIT_MS)))]);
      } finally {
        clearTimeout(timer);
        waiting.current.delete(id);
      }
      if (remoteRef.current === null) fallBack();
    }
    if (remoteRef.current !== true) return null;
    const c = listRef.current.find((x) => x.id === currentRef.current);
    if (!c) return null;
    if (c.remote) return c.id;
    const made = await createConversation({ id: c.id, title: c.title === '新对话' ? titleFrom(text) : c.title, model: c.model, ...(c.group ? { group: c.group } : {}) });
    setList((l) => l.map((x) => (x.id === c.id ? { ...x, id: made.id, title: made.title, remote: { ...made.remote!, loaded: true } } : x)));
    // 万一 Core 换了 id（本机 id 撞上了别的会话）：跟着换
    if (made.id !== c.id) setCurrentId(made.id);
    return made.id;
  }, [fallBack]);
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
    setList((l) => [c, ...l.filter(hasMsgs)]);
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

  // 按会话 id 存（切片 1）：回复在后台结束时，存进它自己的会话，不是当时正看着的那个
  const onMessages = useCallback(
    (id: string, turns: ChatTurn[]) => {
      setList((l) =>
        l
          .map((c) =>
            c.id === id
              ? {
                  ...c,
                  messages: turns,
                  updatedAt: Date.now(),
                  title: c.title === '新对话' ? titleFrom(turns.find((t) => t.role === 'user')?.text ?? '') : c.title,
                  // 正看着这段对话：回复算已读（回复在后台结束、已换到别的会话时不算）
                  ...(c.remote ? { remote: { ...c.remote, loaded: true, count: turns.length, ...(id === currentRef.current ? { unread: false } : {}) } } : {}),
                }
              : c,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt),
      );
      if (id === currentRef.current && listRef.current.find((c) => c.id === id)?.remote) void markRead(id).catch(() => undefined);
    },
    [],
  );

  const pick = (id: string) => {
    setFocusMsg(undefined);
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

  // 设置：桌面和中等宽度照 sumus 是居中弹窗，开在打开它的那一页上面（地址 /settings[/分组]，state.bg = 底下那页）；
  // 手机（或字号大到切成手机排法）是整页。关弹窗回到底下那页，直接打开时底下是对话。
  const goto = (v: View | { kind: 'add-member' }) => {
    setOpen(false);
    if (v.kind === 'add-member') {
      setAddMember({});
      return;
    }
    if (v.kind === 'settings' && !phone) {
      setView(v, { state: { bg: settingsOpen ? settingsBg : location.pathname + location.search } });
      return;
    }
    setView(v);
  };
  const gotoRef = useRef(goto);
  gotoRef.current = goto;
  const closeSettings = () => navigate(settingsBg, { replace: false });

  // 旧链接 /keys、/members… 和 ?view=：换成新地址（替换历史，不多一步后退）；家人打开只给所有者的面板 → 对话
  useEffect(() => {
    const to = legacyPath(location.pathname, location.search);
    if (to) navigate(to, { replace: true });
    else if (blocked) navigate('/chat', { replace: true });
  }, [location.pathname, location.search, blocked, navigate]);

  const ask = useAsk();
  /** X-04b：收件箱「打开对话」——打开那个会话，滚到那条消息 */
  const openConversation = async (id: string, messageId?: string) => {
    if (!listRef.current.some((x) => x.id === id)) {
      if (remoteRef.current !== true) return;
      try {
        const c = await fetchConversation(id);
        setList((l) => [c, ...l.filter((x) => x.id !== id)]);
      } catch {
        return; // 找不到（已归档或不是这个账号的）：留在收件箱
      }
    }
    pick(id);
    setFocusMsg(messageId);
  };

  const remove = async (id: string) => {
    const c = list.find((x) => x.id === id);
    if (c?.remote) {
      // 存库的会话只归档、不删除（删除要所有者定）
      if (!(await ask.confirm({ title: `归档话题「${c.title}」？`, desc: '归档后不在列表里显示，记录还留在 Aroomo 里。', ok: '归档' }))) return;
      try {
        await archiveConversation(id);
      } catch {
        await ask.confirm({ title: '没能归档', desc: '连不上 Aroomo，请稍后再试。', ok: '知道了' });
        return;
      }
    } else if (!c || !(await ask.confirm({ title: `删除会话「${c.title}」？`, desc: '只删本机这一份，删了找不回来。', ok: '删除', danger: true }))) return;
    const rest = list.filter((x) => x.id !== id);
    const next = rest.length ? rest : [newConversation()];
    setList(next);
    if (id === currentId) setCurrentId(next[0]!.id);
  };

  // 同一个对象（同一位成员 / 同一个群 / 负责人）的其它话题
  const topics = useMemo(
    () => list.filter((c) => hasMsgs(c) && c.model === current.model && (c.group ?? []).join('、') === (current.group ?? []).join('、')).slice(0, 8),
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
    const t = (await ask.prompt({ title: '重命名话题', label: '新名字', value: c.title }))?.trim().slice(0, 60);
    if (!t) return;
    setList((l) => l.map((x) => (x.id === id ? { ...x, title: t } : x)));
    if (c.remote)
      renameConversation(id, t).catch(() => {
        // 没存上：改回原来的名字
        setList((l) => l.map((x) => (x.id === id ? { ...x, title: c.title } : x)));
        void ask.confirm({ title: '没能改名', desc: '连不上 Aroomo，请稍后再试。', ok: '知道了' });
      });
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

  /** 输入框里的「/路由」（规范 §3 Omnibox）：家人看不到只给所有者的页面 */
  const omniRoutes = useMemo(
    () =>
      (
        [
          ['/chat', '对话', { kind: 'chat' }],
          ['/console', '驾驶舱', { kind: 'console' }],
          ['/team', '成员', { kind: 'members' }],
          ['/hub', '资源库', { kind: 'library' }],
          ['/hub/tools', '工具', { kind: 'tools' }],
          ['/hub/keys', 'API', { kind: 'keys' }],
          ['/inbox', '收件箱', { kind: 'inbox' }],
          ['/settings', '设置', { kind: 'settings' }],
        ] as [string, string, View][]
      )
        .filter(([, , v]) => !(isFamily() && OWNER_ONLY.includes(v.kind)))
        .map(([cmd, label, v]) => ({ cmd, label, go: () => gotoRef.current(v) })),
    [],
  );
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
        const c = list.find((x) => x.model === 'aroomo' && !x.group?.length && hasMsgs(x));
        if (c) pick(c.id);
        else start();
      }}
      onOpen={(k) => goto({ kind: k })}
      usage={usage}
      {...(remote === true ? { filterable: true, runningId, onOpenMessage: (id: string, msg: string) => void openConversation(id, msg) } : {})}
      {...((remote === true && (localLeft > 0 || importNote)) || legacyLeft > 0 || claimNote
        ? {
            notice: (
              <div className="conv-import">
                {legacyLeft > 0 &&
                  (canClaim ? (
                    <>
                      <p className="note">这台浏览器里有 {legacyLeft} 段以前的会话，分不清是哪个账号存的，还没放进你的账号，也没有删。如果都是你的，点下面的按钮放进你的账号，原来那份不删：</p>
                      <ul className="note legacy-titles" aria-label="以前的会话">
                        {legacy.slice(0, 10).map((c) => (
                          <li key={c.id}>{c.title}</li>
                        ))}
                        {legacyLeft > 10 && <li>另外还有 {legacyLeft - 10} 段</li>}
                      </ul>
                      <button type="button" className="btn btn-outline hit" onClick={claimNow}>
                        这些都是我的，放进我的账号
                      </button>
                    </>
                  ) : (
                    <p className="note">这台浏览器里有 {legacyLeft} 段以前的会话，分不清是哪个账号存的，没有导入，也没有删。</p>
                  ))}
                {claimNote && (
                  <p className="note" role={claimNote.ok ? 'status' : 'alert'} ref={claimNoteRef} tabIndex={-1}>
                    {claimNote.text}
                  </p>
                )}
                {remote === true && localLeft > 0 && (
                  <>
                    <p className="note">这台浏览器里还有 {localLeft} 段会话没存到 Aroomo。</p>
                    <button type="button" className="btn btn-outline hit" disabled={importing} onClick={() => void importNow()}>
                      {importing ? '正在导入…' : `导入这 ${localLeft} 段会话`}
                    </button>
                  </>
                )}
                {remote === true && importNote && (
                  <p className="note" role={importNote.ok ? 'status' : 'alert'}>
                    {importNote.text}
                  </p>
                )}
              </div>
            ),
          }
        : {})}
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
              setNewAssistant({});
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
      ui={sideUi}
      onUi={setSideUi}
      {...(wide || phone ? {} : { onClose: () => setOpen(false) })}
    />
  );

  /** 手机上「←」回到哪一层：成员、我是底部栏的顶层页，没有返回；我 里的四项回到 我；收件箱、挑选成员回到会话列表（名字和底部栏一样叫「对话」） */
  const phoneParent = (v: View): { go: () => void; label: string; aria?: string } | null => {
    if (v.kind === 'members' || v.kind === 'me') return null;
    if (v.kind === 'settings' && v.section) return { go: () => setView({ kind: 'settings' }), label: '设置' };
    if (v.kind === 'settings' || v.kind === 'library' || v.kind === 'tools' || v.kind === 'keys') return { go: () => setView({ kind: 'me' }), label: '我' };
    // 从对话里的额度提示进来的「挑选成员」：返回回这段对话，不是会话列表（审计 C13）
    if (v.kind === 'group-new' && (location.state as { back?: unknown } | null)?.back === 'chat') return { go: () => setView({ kind: 'chat' }), label: '对话', aria: '返回对话' };
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
        <button type="button" className="notice-btn hit" onClick={() => setView({ kind: 'group-new' }, { state: { back: 'chat' } })}>
          换个成员
          <ArrowRight aria-hidden="true" />
        </button>
        <button type="button" className="icon-btn hit notice-close" aria-label="关掉提示，今天不再显示" onClick={() => dismissNotice(noticeKey)}>
          <X aria-hidden="true" />
        </button>
      </div>
    ) : null;

  const inChat = view.kind === 'chat';
  /** 从 Shell 打开：对话请求回 401/403/404 才说「要直接打开 Aroomo 网页」（#264 后 Shell 能直通对话，平时不该吓人；审计 C12）；之后成功一次就收起 */
  const [shellBlocked, setShellBlocked] = useState(false);
  const onChatResult = useCallback((status: number | null | undefined) => {
    if (status === null) setShellBlocked(false);
    else if (status === 401 || status === 403 || status === 404) setShellBlocked(true);
  }, []);
  // 对话区一直挂着（切片 1 / 审计 C1）：打开面板时只藏起来，回复不断、输入不丢
  const chatMain = (
      <>
        <header className="main-head" hidden={!inChat}>
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
            {...(currentMember ? { onView: () => setView({ kind: 'member', id: currentMember.id }) } : { onView: () => setView(isGroup ? { kind: 'members', chat: current.id } : { kind: 'members' }) })}
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
                        {current.remote ? (
                          <button type="button" className="pop-item" aria-label={`归档会话「${current.title}」`} onClick={() => { setMenu('none'); void remove(current.id); }}>
                            <Archive aria-hidden="true" />
                            <span>归档话题</span>
                          </button>
                        ) : (
                          <button type="button" className="pop-item pop-danger" aria-label={`删除会话「${current.title}」`} onClick={() => { setMenu('none'); void remove(current.id); }}>
                            <Trash2 aria-hidden="true" />
                            <span>删除话题</span>
                          </button>
                        )}
                      </li>
                    )}
                  </ul>
                )}
              </div>
            }
          />
        </header>
        {viaShell && inChat && shellBlocked && (
          <p role="alert" className="chat-error main-note">
            对话要直接打开 Aroomo 网页才能用，请从书签或首页进入。
          </p>
        )}
        {needLoad ? (
          msgError?.id === current.id ? (
            <div className="main-note" role="alert" hidden={!inChat}>
              <p className="chat-error">没能取到这段对话，请检查网络。</p>
              <button type="button" className="btn btn-outline hit" onClick={() => setMsgError((e) => ({ id: current.id, seq: (e?.seq ?? 0) + 1 }))}>
                重试
              </button>
            </div>
          ) : (
            <p role="status" className="note panel-loading" hidden={!inChat}>
              正在加载…
            </p>
          )
        ) : (
        <Thread
          key={current.id}
          conversation={current}
          onMessages={(turns) => onMessages(current.id, turns)}
          insert={insert}
          onInserted={() => setInsert(null)}
          hidden={!inChat}
          // 单独对话只发给这一位，不弹 @ 列表（切片 4 / 审计 C8）
          members={current.group?.length ? current.group : singleName ? [] : memberNames}
          routes={omniRoutes}
          speechRate={prefs.speechRate}
          speechOnline={prefs.speechOnline}
          onAllowOnlineSpeech={allowOnlineSpeech}
          {...(singleName ? { memberName: singleName } : {})}
          intro={intro}
          {...(viaShell ? { onResult: onChatResult } : {})}
          {...(notice ? { notice } : {})}
          {...(draftActions ? { draftActions } : {})}
          {...(fetchImpl ? { fetchImpl } : {})}
          {...(remote !== false ? { persist } : {})}
          {...(focusMsg ? { focusMessageId: focusMsg } : {})}
          draftAccount={acct}
          offline={!online}
          onRunning={(r) => setRunningId(r ? current.id : null)}
        />
        )}
      </>
  );
  let main: React.ReactNode = null;
  if (!inChat) {
    // C15：从群聊进来的成员页只列群里的人；找不到这个群就列全部
    const groupConv = view.kind === 'members' && view.chat ? list.find((c) => c.id === view.chat && c.group?.length) : undefined;
    const shownMembers = groupConv ? allMembers.filter((m) => groupConv.group!.includes(m.name)) : allMembers;
    const parent = groupConv ? { go: () => void openConversation(groupConv.id), label: '对话', aria: '返回这段群聊' } : phone ? phoneParent(view) : parentOf(view);
    const member = view.kind === 'member' ? allMembers.find((m) => m.id === view.id) : undefined;
    const title = view.kind === 'member' ? (member?.name ?? '成员') : view.kind === 'assistant' ? (assistants?.find((a) => a.id === view.id)?.name ?? '助手') : view.kind === 'settings' && view.section ? SETTINGS_SECTIONS.find((x) => x.id === view.section)!.label : TITLES[view.kind];
    main = (
      <>
        <PanelHeader title={title} lead={phone ? null : menuButton} {...(parent ? { onBack: () => ('go' in parent ? parent.go() : parent.view.kind === 'settings' && !phone ? setView(parent.view, { state: { bg: '/chat' } }) : setView(parent.view)), backLabel: parent.label, ...('aria' in parent && parent.aria ? { backAria: parent.aria } : {}) } : {})} />
        <div className="panel-scroll">
          <ErrorBoundary key={location.pathname + location.search} onReset={() => setView({ kind: 'chat' })}>
          <Later>
          {view.kind === 'members' && (
            <>
              {groupConv && (
                <div className="panel">
                  <p className="row-hint">只列「{groupConv.title.replace(/^群聊：/, '')}」这个群里的 {shownMembers.length} 位成员。</p>
                  <div className="group">
                    <button type="button" className="row row-button" onClick={() => setView({ kind: 'members' })}>
                      <span className="row-text">
                        <span className="row-label">看全部成员</span>
                      </span>
                    </button>
                  </div>
                </div>
              )}
              <MembersPanel members={shownMembers} failed={membersFailed} onRetry={reloadMembers} onOpen={(m) => setView({ kind: 'member', id: m.id })} {...(isFamily() ? {} : { onAdd: () => setAddMember({}) })} />
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
              onChanged={(m) => {
                upsertMember(m);
                reloadMembers();
              }}
            />
          )}
          {view.kind === 'capmap' && <CapabilityPanel />}
          {view.kind === 'console' && (
            <Cockpit
              members={allMembers}
              membersFailed={membersFailed}
              onGo={(to) => setView({ kind: to })}
              onOpenMember={(id) => setView({ kind: 'member', id })}
              onOpenConversation={(id) => void openConversation(id)}
            />
          )}
          {view.kind === 'assistant' && <AssistantDetail key={view.id} id={view.id} members={members} onChanged={reloadAssistants} onInbox={() => setView({ kind: 'inbox' })} />}
          {view.kind === 'schedule' && <ScheduleView list={assistants} error={assistantsError} members={members} onOpen={(id) => setView({ kind: 'assistant', id })} onChanged={reloadAssistants} />}
          {view.kind === 'group-new' && (
            <GroupNewPanel
              members={members}
              {...(isFamily() ? {} : { onAdd: () => setAddMember({}) })}
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
              <Inbox onBack={() => setView({ kind: 'chat' })} onOpenConversation={(id, msg) => void openConversation(id, msg)} />
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
          {view.kind === 'library' && <LibraryView members={allMembers} onOpenMember={(m) => setView({ kind: 'member', id: m.id })} onAddMember={(preset) => setAddMember(preset ? { preset } : {})} onGo={(k) => setView({ kind: k })} />}
          {view.kind === 'mcp' && <ExternalPanel />}
          {view.kind === 'keys' && <ApiView members={members} onOpenMember={(id) => setView({ kind: 'member', id })} />}
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
          </ErrorBoundary>
        </div>
      </>
    );
  }

  /** 手机底部栏只在三个顶层页出现；进了对话或下一层就藏起来（照 sumus） */
  const tab = !phone ? null : open && view.kind === 'chat' ? 'chats' : view.kind === 'members' ? 'members' : view.kind === 'me' ? 'me' : null;

  return (
    <div className={`app${prefs.highContrast ? ' chat-hc' : ''}${wide ? ' app-wide' : ''}${layout.rail ? ' app-rail' : ''}${phone ? ' app-phone' : ''}${wide && collapsed ? ' app-collapsed' : ''}`}>
      <p className="sr-only" role="status" aria-live="polite" data-net-status="">
        {netSay}
      </p>
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
      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        section={routed.kind === 'settings' ? routed.section : undefined}
        onSection={(k) => setView({ kind: 'settings', section: k }, { replace: true, state: { bg: settingsBg } })}
        prefs={prefs}
        setPrefs={setPrefs}
        members={members}
        onGo={(k: GoTarget) => setView({ kind: k })}
      />
      {addMember && (
        <Suspense fallback={null}>
      <AddMemberDialog
        open
        {...(addMember?.preset ? { preset: addMember.preset } : {})}
        onClose={() => setAddMember(null)}
        onAdded={(m) => {
          upsertMember(m);
          reloadMembers();
        }}
        {...(view.kind === 'library' ? {} : { onExplore: () => { setAddMember(null); goto({ kind: 'library' }); } })}
      />
        </Suspense>
      )}
      {newAssistant && (
        <Suspense fallback={null}>
          <NewAssistantDialog
            members={members}
            {...(newAssistant.initial ? { initial: newAssistant.initial } : {})}
            onClose={() => setNewAssistant(null)}
            onCreated={(a) => {
              newAssistant.onDone?.();
              setNewAssistant(null);
              reloadAssistants();
              setView({ kind: 'assistant', id: a.id });
            }}
          />
        </Suspense>
      )}
      {!wide && !phone && (
        <dialog ref={dialog} className="drawer" aria-label="会话列表" onClose={() => setOpen(false)} onCancel={() => setOpen(false)} onClick={(e) => e.target === e.currentTarget && setOpen(false)}>
          {open && sidebar}
        </dialog>
      )}
      {phone && open && view.kind === 'chat' && (
        <main className="main phone-list" aria-labelledby="phone-list-title">
          {/* 自审 B12：手机列表页也有 main 地标和 h1 */}
          <h1 id="phone-list-title" className="sr-only">
            对话列表
          </h1>
          {sidebar}
        </main>
      )}
        <main
          hidden={phone && open && view.kind === 'chat'}
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
          {chatMain}
          {main}
        </main>
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
