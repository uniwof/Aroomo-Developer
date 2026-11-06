/**
 * X-03 任务卡（功能补充 v1，开关 TASK_CARDS，默认关）：放在组长那条消息下面，一张卡讲完一件事。
 * - 标题「资源周报 · 第 12 次」；步骤一行一个「小B · 搜索 · 完成」（状态是静态文字，不转圈）；
 * - 确认块：想做什么、为什么、花多少，下面「拒绝 / 同意」。真正的重要确认仍走 Core 的确认卡（onApprove 里接 428 两步流程）；
 * - 反问块：成员问你一个问题，下面是快速回复（X-11）或一个输入框。
 * 数据来自 Core 的 run_steps（只追加，取每步最后一条）和流里的数据块，接口好之前不挂到对话页。
 */
import { useId, useState, type FormEvent } from 'react';
import { Avatar } from '../../Avatar';
import { QuickReplies } from './QuickReplies';
import './cards.css';

/**
 * 和线 C 的 run_steps 对齐。成员那一步用 X-06 送达状态：已派出 → 已收到 → 在做 → 已回复（docs/api/stream-parts.md §2），
 * 成员没反应时她能看出卡在哪一步；组长那几步和确认仍是 等待 / 进行中 / 完成。
 */
export type StepStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped' | 'confirm' | 'sent' | 'received' | 'working' | 'replied';
export const STEP_LABEL: Record<StepStatus, string> = {
  waiting: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  confirm: '等你确认',
  sent: '已派出',
  received: '已收到',
  working: '在做',
  replied: '已回复',
};
/** 算「完成」的状态 */
const FINISHED: readonly StepStatus[] = ['done', 'replied'];

export interface TaskStep {
  id: string;
  who: string;
  what: string;
  status: StepStatus;
}
export interface TaskConfirm {
  what: string;
  why?: string;
  cost?: string;
  /** open = 还在等你；其余是处理过的静态结果 */
  state: 'open' | 'approved' | 'rejected' | 'expired';
  onApprove: () => void;
  onReject: () => void;
}
export interface TaskQuestion {
  who: string;
  text: string;
  replies?: string[];
  onReply: (text: string) => void;
}

const CONFIRM_DONE: Record<Exclude<TaskConfirm['state'], 'open'>, string> = { approved: '已同意', rejected: '已拒绝', expired: '已过期' };

/** 一句话进度：「3 步，完成 1 步」，有在等你的就写在最前面 */
export function progressText(steps: TaskStep[]): string {
  const done = steps.filter((s) => FINISHED.includes(s.status)).length;
  const wait = steps.some((s) => s.status === 'confirm');
  return `${wait ? '有一步等你确认 · ' : ''}${steps.length} 步，完成 ${done} 步`;
}

export function TaskCard({ id, title, steps, confirm, question }: { id?: string; title: string; steps: TaskStep[]; confirm?: TaskConfirm; question?: TaskQuestion }) {
  const hid = useId();
  return (
    // tabIndex -1：从收件箱「等你处理」点过来时，滚到这张卡并把焦点放上来（X-04）
    <section id={id} className="task-card" aria-labelledby={`${hid}-t`} tabIndex={-1}>
      <div className="task-head">
        <h3 id={`${hid}-t`} className="task-title">
          {title}
        </h3>
        <p className="task-progress">{progressText(steps)}</p>
      </div>
      {steps.length > 0 && (
        <ol className="task-steps" aria-label="步骤">
          {steps.map((s) => (
            <li key={s.id} className="task-step">
              <Avatar name={s.who} size="xs" />
              <span className="task-step-text">
                {s.who} · {s.what}
              </span>
              <span className={s.status === 'confirm' || s.status === 'failed' ? 'task-step-status task-step-strong' : 'task-step-status'}>{STEP_LABEL[s.status]}</span>
            </li>
          ))}
        </ol>
      )}
      {confirm && <ConfirmBlock c={confirm} />}
      {question && <QuestionBlock q={question} />}
    </section>
  );
}

function ConfirmBlock({ c }: { c: TaskConfirm }) {
  return (
    <div className="task-block" role="group" aria-label="等你确认">
      <p className="task-block-title">等你确认</p>
      <p className="task-block-text">{c.what}</p>
      {c.why && <p className="task-block-hint">为什么：{c.why}</p>}
      {c.cost && <p className="task-block-hint">花多少：{c.cost}</p>}
      {c.state === 'open' ? (
        <div className="task-actions">
          <button type="button" className="btn btn-outline" onClick={c.onReject}>
            拒绝
          </button>
          <button type="button" className="btn btn-primary" onClick={c.onApprove}>
            同意
          </button>
        </div>
      ) : (
        <p className="task-block-done">{CONFIRM_DONE[c.state]}</p>
      )}
    </div>
  );
}

function QuestionBlock({ q }: { q: TaskQuestion }) {
  const [writing, setWriting] = useState(!q.replies?.length);
  const [sent, setSent] = useState<string | null>(null);
  const iid = useId();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get('answer') ?? '').trim();
    if (!text) return;
    setSent(text);
    q.onReply(text);
  }
  return (
    <div className="task-block" role="group" aria-label={`${q.who} 问你`}>
      <p className="task-block-title">{q.who} 问你</p>
      <p className="task-block-text">{q.text}</p>
      {sent !== null ? (
        <p className="quick-sent">已回复：{sent}</p>
      ) : writing ? (
        <form className="task-answer" onSubmit={submit}>
          <label htmlFor={iid} className="sr-only">
            回答 {q.who}
          </label>
          {/* 从「我自己写…」点进来时焦点直接到输入框 */}
          <input id={iid} name="answer" autoComplete="off" placeholder="写你的回答" autoFocus={!!q.replies?.length} />
          <button type="submit" className="btn btn-primary">
            发送
          </button>
        </form>
      ) : (
        <QuickReplies options={q.replies ?? []} label={`回答 ${q.who} 的快速回复`} onSend={q.onReply} onWrite={() => setWriting(true)} />
      )}
    </div>
  );
}
