/**
 * X-15 助手草稿卡（功能补充 v1，开关 ASSISTANT_DRAFT，默认关）。
 * 她在聊天里说「每周一早上 9 点帮我…」，负责人回这张卡；**只有点「建好」才调用 POST /api/assistants**，只靠聊天不会自己建出助手。
 * 卡上：名字、任务说明、组长和成员、计划（人话 + 时区）、下次运行、额度档；三个按钮「建好」「改一改」「不用了」。
 * 家人第一版不能建助手：调用方不给家人渲染这张卡（Core 也会 403）。
 */
import { useEffect, useState } from 'react';
import { scheduleText, whenText, zoneText, type ScheduleKind, type ScheduleSpec } from '../../pages/assistants/schedule-text';
import './cards.css';

export interface AssistantDraft {
  name: string;
  instructions: string;
  lead: string;
  members: string[];
  scheduleKind: ScheduleKind;
  scheduleSpec: ScheduleSpec;
  timezone: string;
  nextRunAt?: string | null;
  budget: 'low' | 'mid' | 'high';
}

export const BUDGET_LABEL: Record<AssistantDraft['budget'], string> = { low: '低（只用免费模型）', mid: '中', high: '高' };

/** initial：聊天里的卡刷新后保留她点过的结果（done / dismissed） */
export function AssistantDraftCard({ draft, onCreate, onEdit, onDismiss, initial = 'open' }: { draft: AssistantDraft; onCreate: () => Promise<void>; onEdit: () => void; onDismiss: () => void; initial?: 'open' | 'done' | 'dismissed' }) {
  const [state, setState] = useState<'open' | 'busy' | 'done' | 'dismissed'>(initial);
  const [err, setErr] = useState('');
  // 在别处建好了（「改一改」的弹窗里）：卡跟着变
  useEffect(() => {
    if (initial !== 'open') setState(initial);
  }, [initial]);
  const others = draft.members.filter((m) => m !== draft.lead);
  async function create() {
    setErr('');
    setState('busy');
    try {
      await onCreate();
      setState('done');
    } catch (e) {
      setErr(e instanceof Error && e.message ? e.message : '没建成，请稍后再试');
      setState('open');
    }
  }
  return (
    <section className="task-card" aria-label={`助手草稿：${draft.name}`}>
      <div className="task-head">
        <h3 className="task-title">助手草稿：{draft.name}</h3>
        <p className="task-progress">还没建，点「建好」才会建</p>
      </div>
      <dl className="draft-list">
        <dt>任务说明</dt>
        <dd className="row-break">{draft.instructions}</dd>
        <dt>组长</dt>
        <dd>{draft.lead}</dd>
        {others.length > 0 && (
          <>
            <dt>成员</dt>
            <dd>{others.join('、')}</dd>
          </>
        )}
        <dt>什么时候做</dt>
        <dd>
          {scheduleText(draft.scheduleKind, draft.scheduleSpec)}
          {draft.scheduleKind !== 'manual' && ` · ${zoneText(draft.timezone)}`}
        </dd>
        {draft.scheduleKind !== 'manual' && (
          <>
            <dt>下次运行</dt>
            <dd>{whenText(draft.nextRunAt, draft.timezone)}</dd>
          </>
        )}
        <dt>额度档</dt>
        <dd>{BUDGET_LABEL[draft.budget]}</dd>
      </dl>
      {err && (
        <p role="alert" className="note note-error">
          {err}
        </p>
      )}
      {state === 'done' ? (
        <p role="status" className="task-block-done">
          已建好「{draft.name}」
        </p>
      ) : state === 'dismissed' ? (
        <p role="status" className="task-block-done">
          不用了，没有建
        </p>
      ) : (
        <div className="task-actions">
          <button type="button" className="btn btn-quiet" disabled={state === 'busy'} onClick={() => { setState('dismissed'); onDismiss(); }}>
            不用了
          </button>
          <button type="button" className="btn btn-outline" disabled={state === 'busy'} onClick={onEdit}>
            改一改
          </button>
          <button type="button" className="btn btn-primary" disabled={state === 'busy'} onClick={() => void create()}>
            {state === 'busy' ? '正在建…' : '建好'}
          </button>
        </div>
      )}
    </section>
  );
}
