/**
 * 一个会话的对话区（assistant-ui ExternalStoreRuntime：消息由我们自己管，assistant-ui 只做视图）。
 * 边界：只认 Conversation（进）和 onMessages（出）；怎么发请求在 store.ts 的 streamChat 里，换后端只改那里。
 * 选 ExternalStore 而不是 LocalRuntime：后者会顺带打包云端会话列表等用不到的代码（gzip 多约 46KB）。
 */
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type FC, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { isFamily } from '@/lib/api';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { ArrowDown, Copy, KeyRound, RotateCcw, Send, Square, Volume2, VolumeX } from 'lucide-react';
import { ChatStreamError, type ChatDraft, type ChatTool, type FailureCode, dayLabel, loadDraft, saveDraft, signatureOf, streamChat, stripSignature, timeLabel, upsertTool, type ChatTurn, type Conversation } from './store';
import { ToolCalls } from './thread/cards/ToolCalls';
import { Avatar } from './Avatar';
import { AnnounceContext, useAnnounce } from './announce';
import { OFFLINE_NOTE } from './online';
import { DEFAULT_RATE, pickVoice, speaker, speechSupported } from './speech';
import { useAsk } from '@/components/Dialog';

// Markdown 引擎单独打包、按需加载（首屏先出对话框和输入框）；没到之前按纯文字显示（同样不渲染 HTML）
const LazyMarkdown = lazy(() => import('./Markdown'));
// X-15 草稿卡点开才下载（对话页包 ≤150 KB gz）
const ChatDraftCard = lazy(() => import('./pages/assistants/ChatDraftCard'));

const draftOfMessage = (m: { metadata?: { custom?: unknown } }): ChatDraft | undefined => (m.metadata?.custom as { draft?: ChatDraft } | undefined)?.draft;
/** X-19：这条上面那行「已整理成摘要」的灰字 */
const noteOfMessage = (m: { metadata?: { custom?: unknown } }): string | undefined => (m.metadata?.custom as { note?: string } | undefined)?.note;
/** 「这段对话太长，这次只带了最近的内容」：只在这次的流里显示，不进存档（noteOfMessage 不读它） */
const streamNoteOfMessage = (m: { metadata?: { custom?: unknown } }): string | undefined => (m.metadata?.custom as { streamNote?: string } | undefined)?.streamNote;
const toolsOfMessage = (m: { metadata?: { custom?: unknown } }): ChatTool[] | undefined => (m.metadata?.custom as { tools?: ChatTool[] } | undefined)?.tools;

/** Core 给的消息 id 是 uuid；本页新发的消息用 newId()（m 开头），不当作 Core 的 id */
const CORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 还没发过消息的新对话：草稿按对象记（全员 / 某位成员 / 某个群），换一位新开对话不带出别人的草稿（审计 C14） */
const newDraftKey = (c: Conversation) => `new:${c.model}${c.group?.length ? `:${c.group.join('、')}` : ''}`;



/** 对话区里的一条消息（本地状态） */
export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 时间（毫秒） */
  at?: number;
  /** 只对回复有意义 */
  state?: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
  /** Core 给的失败码：key_invalid 时不显示「重试」，改成「去检查 Key」 */
  errorCode?: FailureCode | undefined;
  /** X-15 助手草稿卡（只在回复上） */
  draft?: ChatDraft;
  /** X-19：这条上面那行灰字 */
  note?: string;
  /** 压缩没跑成时这条回复上面的灰字：只在界面上，不存库、不存本机 */
  streamNote?: string;
  /** X-05 工具调用（只在回复上） */
  tools?: ChatTool[];
}

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** UiMessage → assistant-ui 的消息（状态决定「停止 / 出错 / 重试」怎么显示） */
export function toThreadMessage(m: UiMessage): ThreadMessageLike {
  const base = {
    id: m.id,
    role: m.role,
    content: [{ type: 'text' as const, text: m.text }],
    ...(m.at ? { createdAt: new Date(m.at) } : {}),
    ...(m.draft || m.tools?.length || m.note || m.streamNote ? { metadata: { custom: { ...(m.draft ? { draft: m.draft } : {}), ...(m.tools?.length ? { tools: m.tools } : {}), ...(m.note ? { note: m.note } : {}), ...(m.streamNote ? { streamNote: m.streamNote } : {}) } } } : {}),
  };
  if (m.role === 'user') return base;
  if (m.state === 'running') return { ...base, status: { type: 'running' } };
  if (m.state === 'cancelled') return { ...base, status: { type: 'incomplete', reason: 'cancelled' } };
  if (m.state === 'error')
    return {
      ...base,
      status: { type: 'incomplete', reason: 'error', error: m.error ?? '对话出错了，请稍后再试。' },
      ...(m.errorCode ? { metadata: { custom: { ...(m.tools?.length ? { tools: m.tools } : {}), errorCode: m.errorCode, ...(m.note ? { note: m.note } : {}), ...(m.streamNote ? { streamNote: m.streamNote } : {}) } } } : {}),
    };
  return { ...base, status: { type: 'complete', reason: 'stop' } };
}

const turnsOf = (list: UiMessage[]): ChatTurn[] => list.filter((m) => m.text.trim() !== '').map((m) => ({ role: m.role, text: m.text }));
/** 存本机用：带时间（Poke 行为规范切片 1：发出即存、结束再存，离开对话区也不丢） */
// 带上 Core 的消息 id、草稿卡、工具行、摘要灰字（streamNote 只在这次的流里显示，不存）
const savedTurnsOf = (list: UiMessage[]): ChatTurn[] =>
  list
    .filter((m) => m.text.trim() !== '')
    .map((m) => ({
      ...(CORE_ID.test(m.id) ? { id: m.id } : {}),
      role: m.role,
      text: m.text,
      ...(m.at ? { at: m.at } : {}),
      ...(m.draft ? { draft: m.draft } : {}),
      ...(m.tools?.length ? { tools: m.tools } : {}),
      ...(m.note ? { note: m.note } : {}),
    }));

const MarkdownText: FC<{ text: string }> = ({ text }) => (
  <Suspense fallback={<p className="chat-md chat-plain">{stripSignature(text)}</p>}>
    <LazyMarkdown />
  </Suspense>
);

const textOfParts = (content: readonly { type: string; text?: string }[]): string =>
  content.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n');

/** 对话区的上下文：谁在这个会话里（决定回复的名字和头像）、消息列表（决定日期分隔） */
interface ThreadInfo {
  /** 单独对话的成员名；负责人对话为空 */
  memberName?: string | undefined;
  members: string[];
  messages: UiMessage[];
}
const ThreadInfoContext = createContext<ThreadInfo>({ members: [], messages: [] });

/** 这条消息和上一条不是同一天：在它上面放一条居中的日期分隔（sumus 的「today」） */
const DaySep: FC = () => {
  const id = useAuiState((s) => s.message.id);
  const { messages } = useContext(ThreadInfoContext);
  const i = messages.findIndex((m) => m.id === id);
  const at = messages[i]?.at;
  if (i < 0 || !at) return null;
  const prev = messages.slice(0, i).reverse().find((m) => m.at)?.at;
  const label = dayLabel(at);
  if (prev && dayLabel(prev) === label) return null;
  return (
    <div className="msg-day" aria-hidden="true">
      <span>{label}</span>
    </div>
  );
};

/** X-19：长会话压缩过的那行静态灰字，放在留下的第一条原文上面（不动、不闪；读屏当作提示读出来） */
const CompactNote: FC = () => {
  const note = useAuiState((s) => noteOfMessage(s.message) ?? streamNoteOfMessage(s.message));
  return note ? (
    <p className="msg-compact" role="note">
      {note}
    </p>
  ) : null;
};

const MessageTime: FC = () => {
  const at = useAuiState((s) => s.message.createdAt?.getTime());
  const t = timeLabel(at);
  return t ? <time className="msg-time">{t}</time> : null;
};

/** 你说的话：「我」头像 + 名字 + 时间 + 正文（不用气泡，照 sumus）。读屏先听到「你说：」 */
/** 每条消息的 DOM id（X-04b：收件箱点「打开对话」时滚到这条并给焦点） */
const useMsgDomId = () => `msg-${useAuiState((s) => s.message.id)}`;

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="msg msg-user" id={useMsgDomId()}>
    <DaySep />
    <CompactNote />
    <div className="msg-row">
      <Avatar name="我" kind="user" size="msg" />
      <div className="msg-main">
        <span className="sr-only">你说：</span>
        <div className="msg-head" aria-hidden="true">
          <span className="msg-name">我</span>
          <MessageTime />
        </div>
        <div className="msg-body msg-body-user">
          <MessagePrimitive.Parts />
        </div>
      </div>
    </div>
  </MessagePrimitive.Root>
);

const CopyReply: FC = () => {
  const announce = useAnnounce();
  return (
    <ActionBarPrimitive.Copy className="msg-act" aria-label="复制整条回复" onClick={() => announce('已复制整条回复')}>
      <Copy aria-hidden="true" />
      <span>复制</span>
    </ActionBarPrimitive.Copy>
  );
};
/** 朗读设置（语速、是否允许在线语音），由对话页传进来 */
interface SpeechSettings {
  rate: number;
  online: boolean;
  /** 所有者点了「用在线语音」：记住这个选择 */
  allowOnline: () => void;
}
const SpeechContext = createContext<SpeechSettings>({ rate: DEFAULT_RATE, online: false, allowOnline: () => undefined });

/** 本机语音列表（浏览器异步加载，voiceschanged 后再读一次） */
function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => (speechSupported() ? window.speechSynthesis.getVoices() : []));
  useEffect(() => {
    if (!speechSupported()) return;
    const synth = window.speechSynthesis;
    const load = () => setVoices(synth.getVoices());
    load();
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);
  return voices;
}

const useSpeakingId = () => useSyncExternalStore((fn) => speaker.subscribe(fn), () => speaker.speakingId);

/** 「朗读 / 停止」按钮：只有点了才读；浏览器不支持就不显示 */
const ReadAloud: FC = () => {
  const id = useAuiState((s) => s.message.id);
  const text = useAuiState((s) => textOfParts(s.message.content as readonly { type: string; text?: string }[]));
  const settings = useContext(SpeechContext);
  const voices = useVoices();
  const speakingId = useSpeakingId();
  const announce = useAnnounce();
  if (!speechSupported() || !text.trim()) return null;
  const speaking = speakingId === id;
  const plan = pickVoice(voices, settings.online);
  const needsOnline = !speaking && plan === null;
  const onClick = () => {
    if (speaking) {
      speaker.stop();
      announce('已停止朗读');
      return;
    }
    // 本机没有中文语音：点「用在线语音」= 同意这次起用在线语音
    const p = plan ?? pickVoice(voices, true)!;
    if (!plan) settings.allowOnline();
    if (speaker.speak(id, text, { rate: settings.rate, plan: p })) announce(p.kind === 'online' ? '开始朗读（在线语音）' : '开始朗读');
  };
  const label = speaking ? '停止朗读' : needsOnline ? '用在线语音朗读这条回复（本机没有中文语音，文字会发到 Google 或微软合成）' : '朗读这条回复';
  return (
    <button type="button" className="msg-act" aria-label={label} aria-pressed={speaking} title={label} onClick={onClick}>
      {speaking ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
      {/* 自审 A15：按钮上的字固定「朗读」，要用在线语音的说明放在读屏名字和提示里 */}
      <span>{speaking ? '停止' : '朗读'}</span>
    </button>
  );
};

/** 出错时的按钮：Key 无效 → 「去检查 Key」（重试也没用）；其余 → 「重试」（发给原来的成员） */
const ErrorAction: FC = () => {
  const code = useAuiState((s) => (s.message.metadata?.custom as { errorCode?: string } | undefined)?.errorCode);
  if (code === 'key_invalid')
    // 自审 A2/C1/C7：所有者在对话页里打开 API 面板（不跳旧控制台）；家人看不到 Key，只说找谁；按钮和消息操作行同一种样式
    return isFamily() ? (
      <span className="msg-note">这位成员暂时用不了，请告诉家里管 Aroomo 的人。</span>
    ) : (
      <Link to="/hub/keys" className="msg-act hit" aria-label="去检查 Key（打开 API）">
        <KeyRound aria-hidden="true" />
        <span>去检查 Key</span>
      </Link>
    );
  return (
    <ActionBarPrimitive.Reload className="msg-act hit" aria-label="重试这条回复">
      <RotateCcw aria-hidden="true" />
      <span>重试</span>
    </ActionBarPrimitive.Reload>
  );
};

/** 回复是谁说的：D31 署名里的名字；单独对话里是那位成员；都没有就是负责人 */
function useSpeaker(): { name: string; lead: boolean; signed: string | null } {
  const signed = useAuiState((s) => signatureOf(textOfParts(s.message.content as readonly { type: string; text?: string }[])));
  const { memberName } = useContext(ThreadInfoContext);
  if (signed) {
    const lead = /负责人/.test(signed);
    return { name: signed.replace(/（负责人）|\(负责人\)/, '').trim() || signed, lead, signed };
  }
  if (memberName) return { name: memberName, lead: false, signed: null };
  return { name: 'Aroomo', lead: true, signed: null };
}

/** 自审 A15：重试一直显示（复制、朗读、重试）；重新问原来那位，不换人。出错时错误框里已有「重试」，这里不重复 */
const RetryReply: FC = () => {
  const failed = useAuiState((s) => s.message.status?.type === 'incomplete' && (s.message.status as { reason?: string }).reason === 'error');
  if (failed) return null;
  return (
    <ActionBarPrimitive.Reload className="msg-act" aria-label="重试，重新回答这条">
      <RotateCcw aria-hidden="true" />
      <span>重试</span>
    </ActionBarPrimitive.Reload>
  );
};

/** 自审 A19：点了停止，半截回复下面留一行静态「已停止」 */
const Stopped: FC = () => {
  const stopped = useAuiState((s) => s.message.status?.type === 'incomplete' && (s.message.status as { reason?: string }).reason === 'cancelled');
  return stopped ? <p className="msg-note">已停止</p> : null;
};

/** 正在回复、还没出字：三个静态圆点 + 文字（sumus 的「Working」；不做动画） */
const Working: FC<{ name: string }> = ({ name }) => {
  const empty = useAuiState((s) => s.message.status?.type === 'running' && !textOfParts(s.message.content as readonly { type: string; text?: string }[]).trim());
  if (!empty) return null;
  return (
    <p className="msg-working" aria-hidden="true">
      {name} 在想…
    </p>
  );
};

/** 草稿卡要的东西（对话页给；家人、开关关时不给 = 不渲染卡） */
export interface DraftActions {
  members: import('@/lib/api').Member[];
  /** 「改一改」：打开新建助手弹窗并预先填好；建好后回调 */
  onEdit: (input: import('@/lib/assistants').AssistantInput, onCreated: () => void) => void;
  /** 「建好」成功后（刷新会话栏的助手列表） */
  onCreated: (a: import('@/lib/assistants').Assistant) => void;
}
const DraftContext = createContext<{ actions?: DraftActions | undefined; setState: (messageId: string, state: 'done' | 'dismissed') => void }>({ setState: () => undefined });

/** 回复里带草稿卡时显示卡；只有点「建好」才建 */
const DraftSlot: FC = () => {
  const id = useAuiState((s) => s.message.id);
  const draft = useAuiState((s) => draftOfMessage(s.message));
  const { actions, setState } = useContext(DraftContext);
  if (!draft || !actions || isFamily()) return null;
  return (
    <Suspense fallback={<p className="msg-note">正在打开助手草稿…</p>}>
      <ChatDraftCard
        draft={draft}
        members={actions.members}
        onState={(st) => setState(id, st)}
        onCreated={actions.onCreated}
        onEdit={(input) => actions.onEdit(input, () => setState(id, 'done'))}
      />
    </Suspense>
  );
};

/** X-05：回复正文上方一行灰字，点开看做了哪些工具调用 */
const ToolSlot: FC = () => {
  const tools = useAuiState((s) => toolsOfMessage(s.message));
  return tools?.length ? <ToolCalls tools={tools} /> : null;
};

const AssistantMessage: FC = () => {
  const who = useSpeaker();
  const domId = useMsgDomId();
  return (
    <MessagePrimitive.Root className="msg msg-assistant" id={domId}>
      <DaySep />
      <CompactNote />
      <div className="msg-row">
        <Avatar name={who.name} kind={who.lead ? 'lead' : 'member'} size="msg" />
        <div className="msg-main">
          <span className="sr-only">{who.signed ? `${who.signed} 回复：` : '回复：'}</span>
          <div className="msg-head" aria-hidden="true">
            <span className="msg-name">{who.name}</span>
            {who.lead && <span className="msg-role">负责人</span>}
            <MessageTime />
          </div>
          <div className="msg-body">
            <ToolSlot />
            <Working name={who.name} />
            <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
            <DraftSlot />
            <Stopped />
            <MessagePrimitive.Error>
              <div role="alert" className="chat-error-box">
                <p className="chat-error">
                  <ErrorPrimitive.Message />
                </p>
                {/* 出错就地重试：你的原话还在，不用重打（ChatGPT「in-line error retry」）；重试发给原来的成员，不换人 */}
                <ErrorAction />
              </div>
            </MessagePrimitive.Error>
          </div>
          <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="msg-actions">
            <CopyReply />
            <ReadAloud />
            <RetryReply />
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
};

export interface ThreadProps {
  conversation: Conversation;
  /** 回复结束（或停止）后，把整个会话的文字交出去存 */
  onMessages: (turns: ChatTurn[]) => void;
  /** 外部（抽屉里点成员）要插入到输入框的文字，例如「@张三 」 */
  insert?: { text: string; seq: number } | null;
  /** 插入完了：外面清掉 insert，免得对话区重新挂载或换会话时再插一次（审计 C2） */
  onInserted?: () => void;
  /** 面板打开时对话区仍挂着但藏起来（回复不断、输入不丢；审计 C1） */
  hidden?: boolean;
  /** 输入框里的「/路由」（规范 §3 Omnibox）：只有选中或回车认得的路由才导航；不认得的照常当一句话发 */
  routes?: { cmd: string; label: string; go: () => void }[];
  members?: string[];
  fetchImpl?: typeof fetch;
  /** 朗读语速（0.8–1.5，默认 1.0） */
  speechRate?: number;
  /** 所有者是否已同意用在线语音 */
  speechOnline?: boolean;
  onAllowOnlineSpeech?: () => void;
  /** 单独对话的成员名（回复的名字和头像用它）；负责人对话不传 */
  memberName?: string;
  /** 开始 / 结束回复 */
  onRunning?: (running: boolean) => void;
  /** 空状态的一句简介 */
  intro?: string;
  /** 输入卡上方的提示条（例如额度用完了） */
  notice?: ReactNode;
  /** X-15 助手草稿卡的动作；不给 = 不显示卡（家人、开关关） */
  draftActions?: DraftActions;
  /** 会话存库：发之前确保会话已在 Core 建好，返回会话 id（null = 不存，本机模式）；抛错 = 没建成，这次不发 */
  persist?: (firstUserText: string) => Promise<string | null>;
  /** X-04b：打开后滚到这条消息并给焦点（收件箱「打开对话」） */
  focusMessageId?: string;
  /** #291：草稿存在哪个账号名下（同本机会话的账号）；null = 不知道是谁，用共用那份 */
  draftAccount?: string | null;
  /** F-020：断网时输入框上方显示一行静态字（判断和读屏播报在 ChatPage，整页只播一次） */
  offline?: boolean;
  /** 一轮对话结束：成功给 null，接口回了错误状态给 HTTP 状态（别的失败给 undefined） */
  onResult?: (status: number | null | undefined) => void;
}

export function Thread({ conversation, onMessages, insert, onInserted, hidden = false, routes = [], members = [], fetchImpl, speechRate = DEFAULT_RATE, speechOnline = false, onAllowOnlineSpeech, memberName, onRunning, intro, notice, onResult, draftActions, persist, focusMessageId, draftAccount = null, offline = false }: ThreadProps) {
  const resultCb = useRef(onResult);
  resultCb.current = onResult;
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const save = useRef(onMessages);
  save.current = onMessages;
  const [messages, setMessagesState] = useState<UiMessage[]>(() =>
    conversation.messages.map((m) => ({
      id: m.id ?? newId(),
      role: m.role,
      text: m.text,
      ...(m.at ? { at: m.at } : {}),
      ...(m.draft ? { draft: m.draft } : {}),
      ...(m.tools?.length ? { tools: m.tools } : {}),
      ...(m.note ? { note: m.note } : {}),
      state: 'done' as const,
    })),
  );

  // 最新的消息列表（不等 React 渲染）：回复结束时即使对话区已卸载，也能把完整的一轮存下
  const msgsRef = useRef(messages);
  const setMessages = useCallback((next: UiMessage[] | ((l: UiMessage[]) => UiMessage[])) => {
    msgsRef.current = typeof next === 'function' ? next(msgsRef.current) : next;
    setMessagesState(msgsRef.current);
  }, []);
  const [isRunning, setIsRunning] = useState(false);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  /** Core 已经存过的用户消息（重试时不再存一遍）：从 Core 取来的，加上这次发出去、Core 收下了的 */
  const savedUser = useRef(new Set(conversation.messages.filter((m) => m.role === 'user' && m.id).map((m) => m.id!)));
  const abortRef = useRef<AbortController | null>(null);
  // 换会话或离开页面时，停掉还在进行的回复，也停掉朗读
  useEffect(
    () => () => {
      abortRef.current?.abort();
      speaker.stop();
    },
    [],
  );
  const allowOnline = useRef(onAllowOnlineSpeech);
  allowOnline.current = onAllowOnlineSpeech;
  const speech: SpeechSettings = { rate: speechRate, online: speechOnline, allowOnline: () => allowOnline.current?.() };

  /** 发一轮：history 的最后一条是用户的话；回复一段一段写进最后一条 */
  const run = useCallback(
    async (history: UiMessage[]) => {
      const reply: UiMessage = { id: newId(), role: 'assistant', text: '', at: Date.now(), state: 'running' };
      const update = (patch: Partial<UiMessage>) => setMessages((l) => l.map((m) => (m.id === reply.id ? { ...m, ...patch } : m)));
      // 开始新回复：停掉正在读的
      speaker.stop();
      setMessages([...history, reply]);
      // 发出即存：回复没完就离开、刷新，这句话也不丢
      save.current(savedTurnsOf(history));
      setIsRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;
      const turns = turnsOf(history);
      const lastUser = history[history.length - 1]!;
      try {
        let conversationId: string | null = null;
        if (persistRef.current) {
          try {
            conversationId = await persistRef.current(lastUser.text);
          } catch {
            throw new ChatStreamError('这段对话没能保存到 Aroomo，请稍后点「重试」。');
          }
        }
        // X-19：Core 刚压缩过 → 在留下的 keep 条原文（含这句）的第一条上面放那行灰字
        const onCompacted = ({ keep, text }: { keep: number; text: string }) => {
          const kept = history.filter((m) => m.text.trim() !== '');
          const first = kept[Math.max(0, kept.length - keep)];
          if (first) setMessages((l) => l.map((m) => (m.id === first.id ? { ...m, note: text } : m)));
        };
        // 该压缩却没压成：这条回复上面一行灰字（只在界面上，不存库、不存本机）
        const onTruncated = (text: string) => update({ streamNote: text });
        const group = convRef.current.group?.length ? { group: convRef.current.group } : {};
        const opts = conversationId ? { conversationId, retry: savedUser.current.has(lastUser.id), onAccepted: () => savedUser.current.add(lastUser.id), onCompacted, onTruncated, ...group } : group;
        const onTool = (t: ChatTool) => setMessages((l) => l.map((m) => (m.id === reply.id ? { ...m, tools: upsertTool(m.tools, t) } : m)));
        for await (const text of streamChat(turns, convRef.current.model, ac.signal, fetchImpl, (draft) => update({ draft }), opts, onTool)) update({ text });
        update({ state: 'done' });
        resultCb.current?.(null);
      } catch (e) {
        if (!ac.signal.aborted) resultCb.current?.(e instanceof ChatStreamError ? e.status : undefined);
        // 点了停止：保留已经收到的部分；其他错误就地显示，可以「重试」
        if (ac.signal.aborted) update({ state: 'cancelled' });
        else
          update({
            state: 'error',
            error: e instanceof ChatStreamError ? e.message : '对话出错了，请稍后再试。',
            errorCode: e instanceof ChatStreamError ? e.code : undefined,
          });
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        setIsRunning(false);
        // 结束（完成 / 停止 / 出错）就存：不靠界面订阅，对话区已卸载也存得下
        save.current(savedTurnsOf(msgsRef.current));
      }
    },
    [fetchImpl, setMessages],
  );

  const ask = useAsk();
  const runtime = useExternalStoreRuntime<UiMessage>({
    messages,
    isRunning,
    convertMessage: toThreadMessage,
    onNew: async (m: AppendMessage) => {
      const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      if (!text.trim()) return;
      await run([...messages, { id: newId(), role: 'user', text, at: Date.now() }]);
    },
    // 「重试」：从出错那条回复之前的那句话重新问一次
    onReload: async (parentId: string | null) => {
      const i = parentId ? messages.findIndex((m) => m.id === parentId) : -1;
      if (i < 0) return;
      // 旧回复上的重试会删掉它后面的对话：先确认（切片 7 / 审计 C10）；关掉确认什么都不变
      const later = messages.length - (i + 2);
      if (later > 0 && !(await ask.confirm({ title: '重新回答这一条？', desc: `后面的 ${later} 条消息会被删掉，删了找不回来。`, ok: '重新回答', danger: true }))) return;
      await run(messages.slice(0, i + 1));
    },
    onCancel: async () => abortRef.current?.abort(),
  });
  const [status, setStatus] = useState('');
  // 草稿卡点了「建好」/「不用了」：记在那条回复上并存本机（刷新后卡不再能点）
  const setDraftState = useCallback(
    (messageId: string, state: 'done' | 'dismissed') => {
      setMessages((l) => l.map((m) => (m.id === messageId && m.draft ? { ...m, draft: { ...m.draft, state } } : m)));
      save.current(savedTurnsOf(msgsRef.current));
    },
    [setMessages],
  );
  const draftCtx = { actions: draftActions, setState: setDraftState };
  const runningCb = useRef(onRunning);
  runningCb.current = onRunning;
  useEffect(() => {
    runningCb.current?.(isRunning);
  }, [isRunning]);

  // 读屏播报：同样的话连说两次也要能播（先清空再写）
  const announce = useCallback((text: string) => {
    setStatus('');
    setTimeout(() => setStatus(text), 50);
  }, []);

  // 回复结束 → 存本机；同时给读屏一句状态（完成 / 已停止 / 出错）
  useEffect(() => {
    let wasRunning = false;
    return runtime.thread.subscribe(() => {
      const s = runtime.thread.getState();
      if (s.isRunning && !wasRunning) setStatus('正在回复…');
      if (!s.isRunning && wasRunning) {
        const st = s.messages[s.messages.length - 1]?.status;
        if (st?.type === 'incomplete' && st.reason === 'cancelled') setStatus('已停止，收到的部分保留了');
        else if (st?.type === 'incomplete' && st.reason === 'error')
          setStatus((s.messages[s.messages.length - 1]?.metadata?.custom as { errorCode?: string } | undefined)?.errorCode === 'key_invalid' ? '出错了：Key 无效，可以点「去检查 Key」' : '出错了，可以点「重试」');
        else setStatus('回复完成');
      }
      wasRunning = s.isRunning;
    });
  }, [runtime]);

  // 草稿：打开会话时放回没发出去的话；输入时随手存（每个会话一份）。
  // 还没发过消息的新会话不进会话列表（刷新后 id 会变），草稿先记在固定的「新对话」名下；发过消息后记在会话 id 名下。
  const hasMessages = useRef(messages.length > 0);
  hasMessages.current = messages.length > 0;
  // #291：账号刚问到（draftAccount 变了）时，输入框里如果还是刚才从别的那份（如共用那份）读进来、她没改过的草稿，
  // 换成这个账号自己那份（没有就清空），不把别人的草稿存进她的账号（负责人 #299 必改）；她自己打的字留着。
  const fromDraft = useRef<string | null>(null);
  useEffect(() => {
    const key = () => (hasMessages.current ? conversation.id : newDraftKey(convRef.current));
    const c = runtime.thread.composer;
    const draft = loadDraft(key(), draftAccount);
    const now = c.getState().text;
    if (!now || now === fromDraft.current) {
      if (draft !== now) c.setText(draft);
      fromDraft.current = draft || null;
    }
    let last = c.getState().text;
    let lastKey = key();
    return c.subscribe(() => {
      const t = c.getState().text;
      const k = key();
      if (t === last && k === lastKey) return;
      if (t !== fromDraft.current) fromDraft.current = null;
      if (k !== lastKey) saveDraft(lastKey, '', draftAccount); // 新对话发出第一句后，「新对话」名下的草稿清掉
      last = t;
      lastKey = k;
      saveDraft(k, t, draftAccount);
    });
  }, [runtime, conversation.id, draftAccount]);

  // X-04b：收件箱「打开对话」→ 滚到那条消息，给焦点框（读屏从这条开始读）
  useEffect(() => {
    if (!focusMessageId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`msg-${focusMessageId}`);
      if (!el) return;
      el.setAttribute('tabindex', '-1');
      el.classList.add('msg-focus');
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [focusMessageId]);

  // 抽屉里点了成员：把「@名字 」放进输入框
  useEffect(() => {
    if (!insert) return;
    const c = runtime.thread.composer;
    const cur = c.getState().text;
    c.setText(cur && !cur.endsWith(' ') ? `${cur} ${insert.text}` : cur + insert.text);
    document.getElementById('chat-input')?.focus();
    insertedCb.current?.();
  }, [insert, runtime]);
  const insertedCb = useRef(onInserted);
  insertedCb.current = onInserted;

  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionAt, setMentionAt] = useState(0);
  // 「/路由」建议（切片 4）：整句只有 /字母 时才算路由输入
  const [routeQ, setRouteQ] = useState<string | null>(null);
  const [routeAt, setRouteAt] = useState(0);
  useEffect(() => {
    const c = runtime.thread.composer;
    return c.subscribe(() => {
      const t = c.getState().text;
      const next = /^\/[a-z/]*$/.test(t) ? t : null;
      setRouteQ((q) => {
        if (q !== next) setRouteAt(0);
        return next;
      });
    });
  }, [runtime]);
  const routeMatches = routeQ !== null ? routes.filter((r) => r.cmd.startsWith(routeQ)) : [];
  const goRoute = (r: { go: () => void }) => {
    runtime.thread.composer.setText('');
    setRouteQ(null);
    r.go();
  };
  const sugg: 'mention' | 'route' | null = mentionOpen && members.length > 0 ? 'mention' : routeMatches.length > 0 ? 'route' : null;
  // 输入「@」（在开头或空格后）就弹出成员列表（sumus / 方案：「输入 @ 后弹出成员列表」）
  useEffect(() => {
    const c = runtime.thread.composer;
    let prev = c.getState().text;
    return c.subscribe(() => {
      const t = c.getState().text;
      if (t.length === prev.length + 1 && /(^|\s)@$/.test(t) && members.length) {
        setMentionAt(0);
        setMentionOpen(true);
      } else if (!/(^|\s)@$/.test(t)) setMentionOpen(false);
      prev = t;
    });
  }, [runtime, members.length]);
  const mention = (name: string) => {
    const c = runtime.thread.composer;
    // 刚输入的那个「@」直接补成「@名字 」
    const cur = c.getState().text.replace(/(^|\s)@$/, '$1');
    c.setText(`${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}@${name} `);
    setMentionOpen(false);
    document.getElementById('chat-input')?.focus();
  };
  const info: ThreadInfo = { memberName, members, messages };
  const placeholder = memberName ? `想让 ${memberName} 做什么，写在这里…` : conversation.group?.length ? '发消息给群里，@ 一位成员' : '发给全员，或 @ 一位成员…';

  return (
    <AnnounceContext.Provider value={announce}>
    {ask.node}
    <DraftContext.Provider value={draftCtx}>
    <SpeechContext.Provider value={speech}>
    <ThreadInfoContext.Provider value={info}>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className={memberName ? 'chat-thread chat-single' : 'chat-thread'} hidden={hidden}>
        <ThreadPrimitive.Viewport className="chat-viewport" role="log" aria-label="对话内容" aria-live="off">
          <div className="chat-column">
            <ThreadPrimitive.Empty>
              {/* 空对话（照 sumus）：正中是头像 + 名字 + 一句简介 + 浅灰「在下面写第一句话」 */}
              <div className="chat-empty">
                <Avatar name={memberName ?? (conversation.group?.length ? conversation.title : '负责人')} kind={memberName ? 'member' : conversation.group?.length ? 'group' : 'lead'} size="lg" />
                <p className="chat-empty-title">{conversation.group?.length ? conversation.title.replace(/^群聊：/, '') : memberName ?? '全员'}</p>
                {intro && <p className="chat-empty-intro">{intro}</p>}
                <p className="chat-empty-hint">在下面写第一句话</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          </div>
          <ThreadPrimitive.ViewportFooter className="chat-viewport-footer">
            {/* 往上翻看旧内容时出现；在最底下时自动隐藏 */}
            <ThreadPrimitive.ScrollToBottom className="btn btn-quiet chat-jump" aria-label="回到最新消息">
              <ArrowDown aria-hidden="true" />
              <span>回到最新</span>
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        <div className="chat-column composer-wrap">
          {notice}
          {offline && <p className="note offline-note">{OFFLINE_NOTE}</p>}
          {mentionOpen && members.length > 0 && (
            // 组合框（A1）：焦点留在输入框，↑↓ 选、回车/Tab 点名、Esc 关；读屏经 aria-activedescendant 读出当前项；样式与全站菜单同一种 .pop
            <ul id="mention-list" role="listbox" className="pop mention-pop" aria-label="点名一位成员">
              {members.map((n, i) => (
                <li
                  key={n}
                  id={`mention-${i}`}
                  role="option"
                  aria-selected={i === mentionAt}
                  aria-label={`点名 ${n}`}
                  className="pop-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    mention(n);
                  }}
                >
                  <Avatar name={n} size="xs" />
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
          {sugg === 'route' && (
            // 「/路由」建议：和点名列表同一种组合框、同一种 .pop（不另起样式）
            <ul id="route-list" role="listbox" className="pop mention-pop" aria-label="前往页面">
              {routeMatches.map((r, i) => (
                <li
                  key={r.cmd}
                  id={`route-${i}`}
                  role="option"
                  aria-selected={i === routeAt}
                  aria-label={`前往${r.label}（${r.cmd}）`}
                  className="pop-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    goRoute(r);
                  }}
                >
                  <span>{r.cmd}</span>
                  <span>{r.label}</span>
                </li>
              ))}
            </ul>
          )}
          <div
            className="composer-keys"
            onKeyDownCapture={(e) => {
              if (!sugg) return;
              const k = e.key;
              const n = sugg === 'mention' ? members.length : routeMatches.length;
              if (k === 'ArrowDown' || k === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                (sugg === 'mention' ? setMentionAt : setRouteAt)((i) => (i + (k === 'ArrowDown' ? 1 : n - 1)) % n);
              } else if ((k === 'Enter' && !e.shiftKey) || k === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                if (sugg === 'route') goRoute(routeMatches[routeAt] ?? routeMatches[0]!);
                else mention(members[mentionAt] ?? members[0]!);
              } else if (k === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setMentionOpen(false);
                setRouteQ(null);
              }
            }}
          >
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              id="chat-input"
              className="composer-input"
              placeholder={placeholder}
              aria-label="输入消息"
              aria-describedby="chat-input-hint"
              {...(sugg ? { role: 'combobox', 'aria-expanded': true, 'aria-controls': sugg === 'mention' ? 'mention-list' : 'route-list', 'aria-activedescendant': sugg === 'mention' ? `mention-${mentionAt}` : `route-${routeAt}`, 'aria-autocomplete': 'list' as const } : {})}
              rows={1}
              autoFocus
            />
            <span id="chat-input-hint" className="sr-only">
              回车发送，Shift 加回车换行，回复时按 Esc 停止
            </span>
            <div className="composer-bar">
              {/* 附件（sumus 左下角的回形针）：第一版不做，先隐藏（负责人落地文档 4.4，不放点了没反应的按钮） */}
              <span className="composer-spacer" />
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="send hit" aria-label="发送">
                  <Send aria-hidden="true" />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel className="send send-stop hit" aria-label="停止回复">
                  <Square aria-hidden="true" />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </ComposerPrimitive.Root>
          </div>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
    </ThreadInfoContext.Provider>
    </SpeechContext.Provider>
    </DraftContext.Provider>
    </AnnounceContext.Provider>
  );
}
