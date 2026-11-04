/**
 * 一个会话的对话区（assistant-ui ExternalStoreRuntime：消息由我们自己管，assistant-ui 只做视图）。
 * 边界：只认 Conversation（进）和 onMessages（出）；怎么发请求在 store.ts 的 streamChat 里，换后端只改那里。
 * 选 ExternalStore 而不是 LocalRuntime：后者会顺带打包云端会话列表等用不到的代码（gzip 多约 46KB）。
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FC } from 'react';
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
import { ArrowDown, ArrowUp, Copy, RotateCcw, Square } from 'lucide-react';
import { ChatStreamError, loadDraft, saveDraft, signatureOf, streamChat, withGroupMentions, type ChatTurn, type Conversation } from './store';
import { AnnounceContext, useAnnounce } from './announce';

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
    .map((m) => ({ role: m.role as 'user' | 'assistant', text: textOfMessage(m) }))
    .filter((t) => t.text.trim() !== '');
}

/** 对话区里的一条消息（本地状态） */
export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** 只对回复有意义 */
  state?: 'running' | 'done' | 'cancelled' | 'error';
  error?: string;
}

let seq = 0;
const newId = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** UiMessage → assistant-ui 的消息（状态决定「停止 / 出错 / 重试」怎么显示） */
export function toThreadMessage(m: UiMessage): ThreadMessageLike {
  const base = { id: m.id, role: m.role, content: [{ type: 'text' as const, text: m.text }] };
  if (m.role === 'user') return base;
  if (m.state === 'running') return { ...base, status: { type: 'running' } };
  if (m.state === 'cancelled') return { ...base, status: { type: 'incomplete', reason: 'cancelled' } };
  if (m.state === 'error') return { ...base, status: { type: 'incomplete', reason: 'error', error: m.error ?? '对话出错了，请稍后再试。' } };
  return { ...base, status: { type: 'complete', reason: 'stop' } };
}

const turnsOf = (list: UiMessage[]): ChatTurn[] => list.filter((m) => m.text.trim() !== '').map((m) => ({ role: m.role, text: m.text }));

const MarkdownText: FC<{ text: string }> = ({ text }) => (
  <Suspense fallback={<p className="chat-md chat-plain">{text}</p>}>
    <LazyMarkdown />
  </Suspense>
);

const textOfParts = (content: readonly { type: string; text?: string }[]): string =>
  content.map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n');

/** 读屏先听到是谁说的（视觉上靠左右位置区分，读屏靠这句） */
const UserMessage: FC = () => (
  <MessagePrimitive.Root className="chat-row chat-row-user">
    <span className="sr-only">你说：</span>
    <div className="chat-bubble chat-bubble-user">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const CopyReply: FC = () => {
  const announce = useAnnounce();
  return (
    <ActionBarPrimitive.Copy className="chat-btn chat-btn-ghost" aria-label="复制整条回复" onClick={() => announce('已复制整条回复')}>
      <Copy aria-hidden="true" />
      <span>复制</span>
    </ActionBarPrimitive.Copy>
  );
};

const AssistantMessage: FC = () => {
  const who = useAuiState((s) => signatureOf(textOfParts(s.message.content as readonly { type: string; text?: string }[])));
  return (
    <MessagePrimitive.Root className="chat-row chat-row-assistant">
      <span className="sr-only">{who ? `${who} 回复：` : '回复：'}</span>
      <div className="chat-bubble chat-bubble-assistant">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
        <MessagePrimitive.Error>
          <div role="alert" className="chat-error-box">
            <p className="chat-error">
              <ErrorPrimitive.Message />
            </p>
            {/* 出错就地重试：你的原话还在，不用重打（ChatGPT「in-line error retry」） */}
            <ActionBarPrimitive.Reload className="chat-btn chat-btn-primary" aria-label="重试这条回复">
              <RotateCcw aria-hidden="true" />
              <span>重试</span>
            </ActionBarPrimitive.Reload>
          </div>
        </MessagePrimitive.Error>
      </div>
      <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="chat-actions">
        <CopyReply />
      </ActionBarPrimitive.Root>
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
}

export function Thread({ conversation, onMessages, insert, members = [], fetchImpl }: ThreadProps) {
  const convRef = useRef(conversation);
  convRef.current = conversation;
  const [messages, setMessages] = useState<UiMessage[]>(() => conversation.messages.map((m) => ({ id: newId(), role: m.role, text: m.text, state: 'done' as const })));
  const [isRunning, setIsRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // 换会话或离开页面时，停掉还在进行的回复
  useEffect(() => () => abortRef.current?.abort(), []);

  /** 发一轮：history 的最后一条是用户的话；回复一段一段写进最后一条 */
  const run = useCallback(
    async (history: UiMessage[]) => {
      const reply: UiMessage = { id: newId(), role: 'assistant', text: '', state: 'running' };
      const update = (patch: Partial<UiMessage>) => setMessages((l) => l.map((m) => (m.id === reply.id ? { ...m, ...patch } : m)));
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
        else update({ state: 'error', error: e instanceof ChatStreamError ? e.message : '对话出错了，请稍后再试。' });
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
      await run([...messages, { id: newId(), role: 'user', text }]);
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
        else if (st?.type === 'incomplete' && st.reason === 'error') setStatus('出错了，可以点「重试」');
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

  return (
    <AnnounceContext.Provider value={announce}>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport" role="log" aria-label="对话内容" aria-live="off">
          <ThreadPrimitive.Empty>
            <div className="chat-empty">
              <p>{conversation.group?.length ? `群聊：${conversation.group.join('、')}` : '有什么想说的？'}</p>
              <p className="chat-muted">直接说就交给负责人；想找某位成员，用「@名字」。</p>
              <ul className="chat-suggestions" aria-label="可以这样开头">
                {suggestions.map((p) => (
                  <li key={p}>
                    <ThreadPrimitive.Suggestion prompt={p} send={false} className="chat-btn chat-suggestion">
                      {p}
                    </ThreadPrimitive.Suggestion>
                  </li>
                ))}
              </ul>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          <ThreadPrimitive.ViewportFooter className="chat-viewport-footer">
            {/* 往上翻看旧内容时出现；在最底下时自动隐藏 */}
            <ThreadPrimitive.ScrollToBottom className="chat-btn chat-jump" aria-label="回到最新消息">
              <ArrowDown aria-hidden="true" />
              <span>回到最新</span>
            </ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
        <p className="sr-only" role="status" aria-live="polite">
          {status}
        </p>
        <ComposerPrimitive.Root className="chat-composer">
          {members.length > 0 && (
            <label className="chat-mention">
              <span className="sr-only">点名一位成员</span>
              <select
                aria-label="点名一位成员"
                value=""
                onChange={(e) => {
                  const name = e.target.value;
                  if (!name) return;
                  const c = runtime.thread.composer;
                  const cur = c.getState().text;
                  c.setText(`${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}@${name} `);
                  document.getElementById('chat-input')?.focus();
                }}
              >
                <option value="">@</option>
                {members.map((n) => (
                  <option key={n} value={n}>
                    @{n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ComposerPrimitive.Input
            id="chat-input"
            className="chat-input"
            placeholder="说点什么…"
            aria-label="输入消息"
            aria-describedby="chat-input-hint"
            rows={1}
            autoFocus
          />
          <span id="chat-input-hint" className="sr-only">
            回车发送，Shift 加回车换行，回复时按 Esc 停止
          </span>
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="chat-btn chat-btn-primary" aria-label="发送">
              <ArrowUp aria-hidden="true" />
              <span>发送</span>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="chat-btn chat-btn-stop" aria-label="停止回复">
              <Square aria-hidden="true" />
              <span>停止</span>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
    </AnnounceContext.Provider>
  );
}
