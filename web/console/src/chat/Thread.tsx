/**
 * 一个会话的对话区（assistant-ui ExternalStoreRuntime：消息由我们自己管，assistant-ui 只做视图）。
 * 边界：只认 Conversation（进）和 onMessages（出）；怎么发请求在 store.ts 的 streamChat 里，换后端只改那里。
 * 选 ExternalStore 而不是 LocalRuntime：后者会顺带打包云端会话列表等用不到的代码（gzip 多约 46KB）。
 */
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type FC, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
  type ThreadMessage,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { ArrowDown, ArrowUp, AtSign, Copy, KeyRound, RotateCcw, Square, Volume2, VolumeX } from 'lucide-react';
import { ChatStreamError, type FailureCode, dayLabel, loadDraft, saveDraft, signatureOf, streamChat, stripSignature, timeLabel, withGroupMentions, type ChatTurn, type Conversation } from './store';
import { Avatar } from './Avatar';
import { AnnounceContext, useAnnounce } from './announce';
import { DEFAULT_RATE, pickVoice, speaker, speechSupported } from './speech';

// Markdown 引擎单独打包、按需加载（首屏先出对话框和输入框）；没到之前按纯文字显示（同样不渲染 HTML）
const LazyMarkdown = lazy(() => import('./Markdown'));
const NEW_DRAFT = 'new';

const textOfMessage = (m: ThreadMessage): string =>
  m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');

function toTurns(messages: readonly ThreadMessage[]): ChatTurn[] {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: textOfMessage(m), ...(m.createdAt ? { at: m.createdAt.getTime() } : {}) }))
    .filter((t) => t.text.trim() !== '');
}

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
}

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** UiMessage → assistant-ui 的消息（状态决定「停止 / 出错 / 重试」怎么显示） */
export function toThreadMessage(m: UiMessage): ThreadMessageLike {
  const base = { id: m.id, role: m.role, content: [{ type: 'text' as const, text: m.text }], ...(m.at ? { createdAt: new Date(m.at) } : {}) };
  if (m.role === 'user') return base;
  if (m.state === 'running') return { ...base, status: { type: 'running' } };
  if (m.state === 'cancelled') return { ...base, status: { type: 'incomplete', reason: 'cancelled' } };
  if (m.state === 'error')
    return {
      ...base,
      status: { type: 'incomplete', reason: 'error', error: m.error ?? '对话出错了，请稍后再试。' },
      ...(m.errorCode ? { metadata: { custom: { errorCode: m.errorCode } } } : {}),
    };
  return { ...base, status: { type: 'complete', reason: 'stop' } };
}

const turnsOf = (list: UiMessage[]): ChatTurn[] => list.filter((m) => m.text.trim() !== '').map((m) => ({ role: m.role, text: m.text }));

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

const MessageTime: FC = () => {
  const at = useAuiState((s) => s.message.createdAt?.getTime());
  const t = timeLabel(at);
  return t ? <time className="msg-time">{t}</time> : null;
};

/** 你说的话：「我」头像 + 名字 + 时间 + 正文（不用气泡，照 sumus）。读屏先听到「你说：」 */
const UserMessage: FC = () => (
  <MessagePrimitive.Root className="msg msg-user">
    <DaySep />
    <div className="msg-row">
      <Avatar name="我" kind="user" />
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
      <span>{speaking ? '停止' : needsOnline ? '用在线语音' : '朗读'}</span>
    </button>
  );
};

/** 出错时的按钮：Key 无效 → 「去检查 Key」（重试也没用）；其余 → 「重试」（发给原来的成员） */
const ErrorAction: FC = () => {
  const code = useAuiState((s) => (s.message.metadata?.custom as { errorCode?: string } | undefined)?.errorCode);
  if (code === 'key_invalid')
    return (
      <Link to="/keys" className="btn btn-primary" aria-label="去检查 Key（成员 → Key 与接入）">
        <KeyRound aria-hidden="true" />
        <span>去检查 Key</span>
      </Link>
    );
  return (
    <ActionBarPrimitive.Reload className="btn btn-primary" aria-label="重试这条回复">
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

/** 正在回复、还没出字：三个静态圆点 + 文字（sumus 的「Working」；不做动画） */
const Working: FC<{ name: string }> = ({ name }) => {
  const empty = useAuiState((s) => s.message.status?.type === 'running' && !textOfParts(s.message.content as readonly { type: string; text?: string }[]).trim());
  if (!empty) return null;
  return (
    <p className="msg-working" aria-hidden="true">
      {name} 正在回复…
    </p>
  );
};

const AssistantMessage: FC = () => {
  const who = useSpeaker();
  return (
    <MessagePrimitive.Root className="msg msg-assistant">
      <DaySep />
      <div className="msg-row">
        <Avatar name={who.name} kind={who.lead ? 'lead' : 'member'} />
        <div className="msg-main">
          <span className="sr-only">{who.signed ? `${who.signed} 回复：` : '回复：'}</span>
          <div className="msg-head" aria-hidden="true">
            <span className="msg-name">{who.name}</span>
            {who.lead && <span className="msg-role">负责人</span>}
            <MessageTime />
          </div>
          <div className="msg-body">
            <Working name={who.name} />
            <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
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
}

export function Thread({ conversation, onMessages, insert, members = [], fetchImpl, speechRate = DEFAULT_RATE, speechOnline = false, onAllowOnlineSpeech, memberName, onRunning, intro, notice }: ThreadProps) {
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const [messages, setMessages] = useState<UiMessage[]>(() => conversation.messages.map((m) => ({ id: newId(), role: m.role, text: m.text, ...(m.at ? { at: m.at } : {}), state: 'done' as const })));
  const [isRunning, setIsRunning] = useState(false);
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
      setIsRunning(true);
      const ac = new AbortController();
      abortRef.current = ac;
      const turns = turnsOf(history);
      const last = turns[turns.length - 1];
      if (last?.role === 'user') last.text = withGroupMentions(last.text, convRef.current.group);
      try {
        for await (const text of streamChat(turns, convRef.current.model, ac.signal, fetchImpl)) update({ text });
        update({ state: 'done' });
      } catch (e) {
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
      }
    },
    [fetchImpl],
  );

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
      await run(messages.slice(0, i + 1));
    },
    onCancel: async () => abortRef.current?.abort(),
  });
  const [status, setStatus] = useState('');
  const save = useRef(onMessages);
  save.current = onMessages;
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
        save.current(toTurns(s.messages));
      }
      wasRunning = s.isRunning;
    });
  }, [runtime]);

  // 草稿：打开会话时放回没发出去的话；输入时随手存（每个会话一份）。
  // 还没发过消息的新会话不进会话列表（刷新后 id 会变），草稿先记在固定的「新对话」名下；发过消息后记在会话 id 名下。
  const hasMessages = useRef(messages.length > 0);
  hasMessages.current = messages.length > 0;
  useEffect(() => {
    const key = () => (hasMessages.current ? conversation.id : NEW_DRAFT);
    const c = runtime.thread.composer;
    const draft = loadDraft(key());
    if (draft && !c.getState().text) c.setText(draft);
    let last = c.getState().text;
    let lastKey = key();
    return c.subscribe(() => {
      const t = c.getState().text;
      const k = key();
      if (t === last && k === lastKey) return;
      if (k !== lastKey) saveDraft(lastKey, ''); // 新对话发出第一句后，「新对话」名下的草稿清掉
      last = t;
      lastKey = k;
      saveDraft(k, t);
    });
  }, [runtime, conversation.id]);

  // 抽屉里点了成员：把「@名字 」放进输入框
  useEffect(() => {
    if (!insert) return;
    const c = runtime.thread.composer;
    const cur = c.getState().text;
    c.setText(cur && !cur.endsWith(' ') ? `${cur} ${insert.text}` : cur + insert.text);
    document.getElementById('chat-input')?.focus();
  }, [insert, runtime]);

  // 空状态的建议：点了只放进输入框，不替你发（看清楚再按「发送」）
  const suggestions = [
    '你能帮我做什么？',
    ...(members[0] ? [`@${members[0]} 你好，介绍一下你自己`] : []),
    '帮我把下面这段话改得更清楚：',
  ];
  const [mentionOpen, setMentionOpen] = useState(false);
  // 输入「@」（在开头或空格后）就弹出成员列表（sumus / 方案：「输入 @ 后弹出成员列表」）
  useEffect(() => {
    const c = runtime.thread.composer;
    let prev = c.getState().text;
    return c.subscribe(() => {
      const t = c.getState().text;
      if (t.length === prev.length + 1 && /(^|\s)@$/.test(t) && members.length) setMentionOpen(true);
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
  const placeholder = memberName ? `发消息给 ${memberName}` : '发消息，@ 一位成员';

  return (
    <AnnounceContext.Provider value={announce}>
    <SpeechContext.Provider value={speech}>
    <ThreadInfoContext.Provider value={info}>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport" role="log" aria-label="对话内容" aria-live="off">
          <div className="chat-column">
            <ThreadPrimitive.Empty>
              {/* 空对话（照 sumus）：中间是成员头像 + 名字 + 一句简介 + 「说点什么开始」；下面几条可以直接用的开头 */}
              <div className="chat-empty">
                <Avatar name={memberName ?? (conversation.group?.length ? conversation.title : 'Aroomo')} kind={memberName ? 'member' : conversation.group?.length ? 'group' : 'lead'} size="lg" />
                <h2 className="chat-empty-title">{conversation.group?.length ? conversation.title.replace(/^群聊：/, '') : memberName ?? '负责人'}</h2>
                {intro && <p className="chat-empty-intro">{intro}</p>}
                <p className="muted chat-empty-hint">说点什么，开始这个对话</p>
                <ul className="chat-suggestions" aria-label="可以这样开头">
                  {suggestions.map((p) => (
                    <li key={p}>
                      <ThreadPrimitive.Suggestion prompt={p} send={false} className="btn btn-outline chat-suggestion">
                        {p}
                      </ThreadPrimitive.Suggestion>
                    </li>
                  ))}
                </ul>
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
          {mentionOpen && members.length > 0 && (
            <ul
              className="group mention-list"
              aria-label="点名一位成员"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setMentionOpen(false);
                  document.getElementById('chat-mention')?.focus();
                }
              }}
            >
              {members.map((n) => (
                <li key={n}>
                  <button type="button" className="row row-button" onClick={() => mention(n)} aria-label={`点名 ${n}`}>
                    <Avatar name={n} size="sm" />
                    <span className="row-text">{n}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ComposerPrimitive.Root className="composer">
            <ComposerPrimitive.Input
              id="chat-input"
              className="composer-input"
              placeholder={placeholder}
              aria-label="输入消息"
              aria-describedby="chat-input-hint"
              rows={1}
              autoFocus
            />
            <span id="chat-input-hint" className="sr-only">
              回车发送，Shift 加回车换行，回复时按 Esc 停止
            </span>
            <div className="composer-bar">
              {members.length > 0 && (
                <button
                  id="chat-mention"
                  type="button"
                  className="btn btn-quiet"
                  aria-label="点名一位成员"
                  aria-expanded={mentionOpen}
                  onClick={() => setMentionOpen((o) => !o)}
                >
                  <AtSign aria-hidden="true" />
                  <span>点名</span>
                </button>
              )}
              <span className="composer-spacer" />
              <ThreadPrimitive.If running={false}>
                <ComposerPrimitive.Send className="send" aria-label="发送">
                  <ArrowUp aria-hidden="true" />
                </ComposerPrimitive.Send>
              </ThreadPrimitive.If>
              <ThreadPrimitive.If running>
                <ComposerPrimitive.Cancel className="send send-stop" aria-label="停止回复">
                  <Square aria-hidden="true" />
                </ComposerPrimitive.Cancel>
              </ThreadPrimitive.If>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
    </ThreadInfoContext.Provider>
    </SpeechContext.Provider>
    </AnnounceContext.Provider>
  );
}
