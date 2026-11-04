/**
 * 一个会话的对话区（assistant-ui LocalRuntime）。
 * 边界：只认 Conversation（进）和 onMessages（出）；怎么发请求在 store.ts 的 streamChat 里，换后端只改那里。
 */
import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps } from '@assistant-ui/react-markdown';
import { ArrowUp, Check, Copy, Square } from 'lucide-react';
import { streamChat, withGroupMentions, type ChatTurn, type Conversation } from './store';

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

/** 把 streamChat 接成 assistant-ui 的 ChatModelAdapter */
export function makeAdapter(conv: () => Conversation, fetchImpl?: typeof fetch): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const turns = toTurns(messages);
      const c = conv();
      const last = turns[turns.length - 1];
      if (last?.role === 'user') last.text = withGroupMentions(last.text, c.group);
      try {
        for await (const text of streamChat(turns, c.model, abortSignal, fetchImpl)) {
          yield { content: [{ type: 'text', text }] };
        }
      } catch (e) {
        if (abortSignal.aborted) return; // 点了停止：保留已经收到的部分
        throw e;
      }
    },
  };
}

/** 代码块标题栏：语言名 + 一键复制 */
const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const [done, setDone] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  };
  return (
    <div className="chat-code-header">
      <span>{language || '代码'}</span>
      <button type="button" className="chat-btn chat-btn-ghost" onClick={copy} aria-label={done ? '已复制代码' : '复制代码'}>
        {done ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span>{done ? '已复制' : '复制'}</span>
      </button>
    </div>
  );
};

/** Markdown：react-markdown 默认不渲染原始 HTML；skipHtml 再明确丢掉 HTML 片段（防注入） */
const MarkdownText: FC = () => <MarkdownTextPrimitive skipHtml className="chat-md" components={{ CodeHeader }} />;

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="chat-row chat-row-user" aria-label="你说">
    <div className="chat-bubble chat-bubble-user">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="chat-row chat-row-assistant" aria-label="回复">
    <div className="chat-bubble chat-bubble-assistant">
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      <MessagePrimitive.Error>
        <p role="alert" className="chat-error">
          出错了，请稍后再试。
        </p>
      </MessagePrimitive.Error>
    </div>
    <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="chat-actions">
      <ActionBarPrimitive.Copy className="chat-btn chat-btn-ghost" aria-label="复制整条回复">
        <Copy aria-hidden="true" />
        <span>复制</span>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  </MessagePrimitive.Root>
);

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
  const adapter = useMemo(() => makeAdapter(() => convRef.current, fetchImpl), [fetchImpl]);
  const initialMessages = useMemo(() => conversation.messages.map((m) => ({ role: m.role, content: m.text })), [conversation.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const runtime = useLocalRuntime(adapter, { initialMessages });
  const [status, setStatus] = useState('');
  const save = useRef(onMessages);
  save.current = onMessages;

  // 回复结束 → 存本机；同时给读屏一句状态
  useEffect(() => {
    let wasRunning = false;
    return runtime.thread.subscribe(() => {
      const s = runtime.thread.getState();
      if (s.isRunning && !wasRunning) setStatus('正在回复…');
      if (!s.isRunning && wasRunning) {
        setStatus('回复完成');
        save.current(toTurns(s.messages));
      }
      wasRunning = s.isRunning;
    });
  }, [runtime]);

  // 抽屉里点了成员：把「@名字 」放进输入框
  useEffect(() => {
    if (!insert) return;
    const c = runtime.thread.composer;
    const cur = c.getState().text;
    c.setText(cur && !cur.endsWith(' ') ? `${cur} ${insert.text}` : cur + insert.text);
    document.getElementById('chat-input')?.focus();
  }, [insert, runtime]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="chat-thread">
        <ThreadPrimitive.Viewport className="chat-viewport" role="log" aria-label="对话内容" aria-live="off">
          <ThreadPrimitive.Empty>
            <div className="chat-empty">
              <p>{conversation.group?.length ? `群聊：${conversation.group.join('、')}` : '有什么想说的？'}</p>
              <p className="chat-muted">直接说就交给负责人；想找某位成员，用「@名字」。</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
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
          <ComposerPrimitive.Input id="chat-input" className="chat-input" placeholder="说点什么…" aria-label="输入消息" rows={1} autoFocus />
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
  );
}
