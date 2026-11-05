/**
 * 助手的三处界面（#250 integrate/stage2，开关 FLAGS.assistants / schedulePage / assistantDraft / taskCards）。点开才下载（对话页包 ≤150 KB gz）。
 * - NewAssistantDialog：新建助手（任务说明、成员和组长、计划预设、额度档）→「预览」调 POST /api/assistants/preview，
 *   回来的 data-aroomo-assistant-draft 数据块渲染成 X-15 草稿卡；只有点「建好」才 POST /api/assistants。
 * - AssistantDetail：固定会话（GET …/messages，按 seq 追加）+ 当前运行的 X-03 任务卡（GET …/runs/:run 的步骤）+ 运行记录 + 立即运行 + 暂停 / 继续。
 * - ScheduleView：X-02「全部计划」整页，启用开关接 pause / resume。
 * 只调 docs/api/design-assistants-v1.md §2 的接口；没有接口的动作不放按钮。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Member } from '@/lib/api';
import { assistantsApi, isActive, newIdemKey, type Assistant, type AssistantInput, type AssistantMessage, type AssistantRun, type BudgetLevel, type CoreSchedule, type DraftPart, type RunStep } from '@/lib/assistants';
import { FLAGS } from '@/lib/flags';
import { Dialog } from '@/components/Dialog';
import { Avatar } from '../../Avatar';
import { errText } from '../../ui';
import { AssistantDraftCard, BUDGET_LABEL, type AssistantDraft } from '../../thread/cards/AssistantDraftCard';
import { TaskCard, type StepStatus, type TaskStep } from '../../thread/cards/TaskCard';
import { RUN_LABEL, SchedulePage, type ScheduleRow } from './schedule';
import { PRESETS, scheduleText, whenText } from './schedule-text';
import '../../thread/cards/cards.css';

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const nameOf = (members: Member[], id: string | null | undefined) => (id ? (members.find((m) => m.id === id)?.name ?? id) : '组长');

/** 计划选项：「只在我叫它时」+ 四个预设（不让她写 cron） */
const SCHEDULES: { id: string; label: string; schedule: CoreSchedule }[] = [
  { id: 'manual', label: '只在我叫它时', schedule: { kind: 'manual' } },
  ...PRESETS.map((p) => ({ id: p.id, label: p.label, schedule: { kind: p.kind, ...p.spec } })),
];

// ---------------- 新建助手 + X-15 草稿卡 ----------------

interface Form {
  name: string;
  instructions: string;
  members: string[];
  lead: string;
  scheduleId: string;
  budget: BudgetLevel;
}

export function toInput(f: Form, options = SCHEDULES): AssistantInput {
  const lead = f.members.includes(f.lead) ? f.lead : f.members[0];
  return {
    name: f.name.trim(),
    instructions: f.instructions.trim(),
    members: f.members,
    ...(lead ? { leadMemberId: lead } : {}),
    schedule: (options.find((s) => s.id === f.scheduleId) ?? SCHEDULES[0]!).schedule,
    timezone: localZone(),
    budgetLevel: f.budget,
  };
}

const sameSchedule = (a: CoreSchedule, b: CoreSchedule) =>
  a.kind === b.kind && (a.time ?? '') === (b.time ?? '') && (a.days ?? []).join() === (b.days ?? []).join() && (a.everyHours ?? 0) === (b.everyHours ?? 0);

/**
 * 「改一改」带过来的草稿 → 表单 + 计划选项。聊天里说的计划不在预设里（如「每周三 15:00」）时，多放一个「聊天里说的」选项并选中，不丢。
 * 只认她自己的成员：草稿里的成员不在列表里就不带。
 */
export function formFromInput(initial: AssistantInput | undefined, members: Member[]): { form: Form; options: typeof SCHEDULES } {
  const empty: Form = { name: '', instructions: '', members: [], lead: '', scheduleId: 'manual', budget: 'low' };
  if (!initial) return { form: empty, options: SCHEDULES };
  const ids = initial.members.filter((id) => members.some((m) => m.id === id));
  const preset = SCHEDULES.find((s) => sameSchedule(s.schedule, initial.schedule));
  const options = preset ? SCHEDULES : [...SCHEDULES, { id: 'chat', label: `${scheduleText(initial.schedule.kind, initial.schedule)}（聊天里说的）`, schedule: initial.schedule }];
  return {
    form: { name: initial.name, instructions: initial.instructions, members: ids, lead: initial.leadMemberId && ids.includes(initial.leadMemberId) ? initial.leadMemberId : (ids[0] ?? ''), scheduleId: preset?.id ?? 'chat', budget: initial.budgetLevel ?? 'low' },
    options,
  };
}

/** Core 的草稿数据块 → 草稿卡要的样子（成员 id 换成名字） */
export function draftFromPart(p: DraftPart, members: Member[]): AssistantDraft {
  const { kind, text: _text, ...spec } = p.data.schedule;
  return {
    name: p.data.name,
    instructions: p.data.instructions,
    lead: nameOf(members, p.data.leadMemberId),
    members: p.data.members.map((id) => nameOf(members, id)),
    scheduleKind: kind,
    scheduleSpec: spec,
    timezone: p.data.timezone,
    nextRunAt: p.data.nextRunAt,
    budget: p.data.budgetLevel,
  };
}

/** initial = 聊天草稿卡点「改一改」带过来的内容（表单预先填好） */
export function NewAssistantDialog({ members, onClose, onCreated, initial }: { members: Member[]; onClose: () => void; onCreated: (a: Assistant) => void; initial?: AssistantInput }) {
  const [start] = useState(() => formFromInput(initial, members));
  const options = start.options;
  const [f, setF] = useState<Form>(start.form);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  /** key：这张草稿的幂等键（「建好」重试、连点只建一个；改了再预览就是新的一张） */
  const [draft, setDraft] = useState<{ input: AssistantInput; card: AssistantDraft; key: string } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function preview(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!f.name.trim()) return setMsg('请给助手起个名字');
    if (Array.from(f.instructions.trim()).length < 10) return setMsg('任务说明再写具体一点（至少 10 个字）');
    if (f.members.length === 0) return setMsg('至少选 1 位成员');
    setMsg('');
    setBusy(true);
    try {
      const input = toInput(f, options);
      const r = await assistantsApi.preview(input);
      setDraft({ input, card: draftFromPart(r.part, members), key: newIdemKey('new') });
    } catch (err) {
      setMsg(errText(err, '没算出来，请稍后再试'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="新建助手" desc="助手是为一件长期的事设的小队：写清要做什么，挑成员和组长，定好什么时候做。" onClose={onClose}>
      {draft && FLAGS.assistantDraft ? (
        <AssistantDraftCard
          draft={draft.card}
          onCreate={async () => {
            try {
              onCreated(await assistantsApi.create(draft.input, draft.key));
            } catch (err) {
              throw new Error(errText(err, '没建成，请稍后再试'));
            }
          }}
          onEdit={() => setDraft(null)}
          onDismiss={onClose}
        />
      ) : (
        <form className="dlg-form" onSubmit={(e) => void preview(e)} noValidate>
          <label className="form-field">
            <span className="form-label">名字（必填）</span>
            <input name="name" maxLength={60} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="如：资源周报" />
          </label>
          <label className="form-field">
            <span className="form-label">任务说明（必填）</span>
            <textarea name="instructions" rows={4} maxLength={4000} value={f.instructions} onChange={(e) => set('instructions', e.target.value)} placeholder="如：每周找全网新的免费模型，筛好了告诉我" />
          </label>
          <fieldset className="form-field form-fieldset">
            <legend className="form-label">成员（至少 1 位）</legend>
            {members.length === 0 ? (
              <p className="note">还没有成员。先在资源库里添加一位。</p>
            ) : (
              <div className="check-grid">
                {members.map((m) => (
                  <label key={m.id} className="check-row">
                    <input
                      type="checkbox"
                      className="check"
                      checked={f.members.includes(m.id)}
                      onChange={(e) => set('members', e.target.checked ? [...f.members, m.id] : f.members.filter((x) => x !== m.id))}
                    />
                    <span>{m.name}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          {f.members.length > 1 && (
            <fieldset className="form-field form-fieldset">
              <legend className="form-label">组长（负责分工和汇总）</legend>
              <div className="check-grid">
                {f.members.map((id) => (
                  <label key={id} className="check-row">
                    <input type="radio" className="check" name="lead" checked={(f.members.includes(f.lead) ? f.lead : f.members[0]) === id} onChange={() => set('lead', id)} />
                    <span>{nameOf(members, id)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <fieldset className="form-field form-fieldset">
            <legend className="form-label">什么时候做</legend>
            <div className="check-grid check-grid-wide">
              {options.map((s) => (
                <label key={s.id} className="check-row">
                  <input type="radio" className="check" name="schedule" checked={f.scheduleId === s.id} onChange={() => set('scheduleId', s.id)} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="form-field form-fieldset">
            <legend className="form-label">额度档</legend>
            <div className="check-grid check-grid-wide">
              {(Object.keys(BUDGET_LABEL) as BudgetLevel[]).map((b) => (
                <label key={b} className="check-row">
                  <input type="radio" className="check" name="budget" checked={f.budget === b} onChange={() => set('budget', b)} />
                  <span>{BUDGET_LABEL[b]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {msg && (
            <p role="alert" className="note note-error">
              {msg}
            </p>
          )}
          <div className="dlg-foot">
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? '正在预览…' : '预览'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

// ---------------- X-03 任务卡（运行步骤） ----------------

const STEP_STATUS: Record<RunStep['status'], StepStatus> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
  waiting_confirmation: 'confirm',
};
const ACTION: Record<RunStep['action'], string> = { plan: '分工', work: '做事', summarize: '汇总', confirm: '付费确认' };

export function stepsToTask(steps: RunStep[], members: Member[]): TaskStep[] {
  return steps.map((s) => {
    const d = s.detail.replace(/\s+/g, ' ').trim();
    return {
      id: String(s.stepNo),
      who: s.memberId ? nameOf(members, s.memberId) : '系统',
      what: d ? `${ACTION[s.action]}：${d.length > 60 ? `${d.slice(0, 60)}…` : d}` : ACTION[s.action],
      status: STEP_STATUS[s.status],
    };
  });
}

function RunCard({ a, runId, members, live }: { a: Assistant; runId: string; members: Member[]; live: boolean }) {
  const [run, setRun] = useState<(AssistantRun & { steps: RunStep[] }) | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      assistantsApi
        .run(a.id, runId)
        .then((r) => alive && (setRun(r), setErr('')))
        .catch((e: unknown) => alive && setErr(errText(e, '这次运行的步骤没加载出来')));
    void load();
    const t = live ? setInterval(load, 2000) : undefined;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [a.id, runId, live]);
  if (err) return <p role="alert" className="note note-error">{err}</p>;
  if (!run) return <p role="status" className="note">正在加载步骤…</p>;
  if (!FLAGS.taskCards) return null;
  return <TaskCard title={`${a.name} · ${whenText(run.requestedAt)} · ${RUN_LABEL[run.status]}`} steps={stepsToTask(run.steps, members)} />;
}

// ---------------- 助手详情 ----------------

function MessageRow({ m, members, lead }: { m: AssistantMessage; members: Member[]; lead: string | null }) {
  const name = m.role === 'system' ? '系统' : m.role === 'user' ? '我' : nameOf(members, m.memberId);
  return (
    <li className="msg">
      <div className="msg-row">
        <Avatar name={name} kind={m.role === 'user' ? 'user' : 'member'} size="msg" />
        <div className="msg-main">
          <div className="msg-head">
            <span className="msg-name">{name}</span>
            {m.memberId && m.memberId === lead && <span className="msg-role">组长</span>}
            <time className="msg-time" dateTime={m.createdAt}>
              {whenText(m.createdAt)}
            </time>
          </div>
          <div className="msg-body msg-body-user">{m.content}</div>
        </div>
      </div>
    </li>
  );
}

function durationText(ms: number | null): string {
  if (ms === null) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `用时 ${s} 秒` : `用时 ${Math.round(s / 60)} 分钟`;
}

export function AssistantDetail({ id, members, onChanged, onInbox }: { id: string; members: Member[]; onChanged: () => void; onInbox: () => void }) {
  const [a, setA] = useState<Assistant | null>(null);
  const [err, setErr] = useState('');
  const [msgs, setMsgs] = useState<AssistantMessage[]>([]);
  const [runs, setRuns] = useState<AssistantRun[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState(false);
  const lastSeq = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [x, r, m] = await Promise.all([assistantsApi.get(id), assistantsApi.runs(id), assistantsApi.messages(id, lastSeq.current)]);
    setA(x);
    setRuns(r.runs);
    setMore(r.nextBefore);
    if (m.length) {
      lastSeq.current = m.reduce((n, y) => Math.max(n, y.seq ?? 0), lastSeq.current ?? 0);
      setMsgs((old) => [...old, ...m.filter((y) => !old.some((o) => o.id === y.id))]);
      void assistantsApi.markRead(id).catch(() => undefined);
    }
  }, [id]);

  useEffect(() => {
    lastSeq.current = undefined;
    setMsgs([]);
    setA(null);
    setRuns(null);
    setErr('');
    setNote('');
    // refresh 拿到消息时已经清过未读，这里只通知会话栏刷新
    refresh()
      .then(onChanged)
      .catch((e: unknown) => setErr(errText(e, '这个助手没加载出来')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const active = runs?.find((r) => isActive(r.status) || r.status === 'waiting_confirmation') ?? null;
  const live = !!active && isActive(active.status);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void refresh().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [live, refresh]);
  // 运行从进行中变成结束：通知会话栏刷新（未读、上次结果）
  const wasLive = useRef(false);
  useEffect(() => {
    // 「已开始运行…」这句在运行结束后就过时了，换成结果
    if (wasLive.current && !live) {
      onChanged();
      setNote((n) => (n.startsWith('已开始运行') ? '这次运行结束了，结果在下面' : n));
    }
    wasLive.current = live;
  }, [live, onChanged]);

  /** 「立即运行」的幂等键：一次点击一个；没成功（网络断了）再点用同一个，成功后换新的 */
  const runKey = useRef<string | null>(null);
  const act = async (label: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(label);
    setNote('');
    try {
      await fn();
      await refresh();
      onChanged();
      setNoteErr(false);
      setNote(done);
    } catch (e) {
      setNoteErr(true);
      setNote(errText(e, '没做成，请稍后再试'));
    } finally {
      setBusy('');
    }
  };

  const loadMore = async () => {
    if (!more || busy) return;
    setBusy('more');
    try {
      const r = await assistantsApi.runs(id, more);
      setRuns((old) => [...(old ?? []), ...r.runs]);
      setMore(r.nextBefore);
    } catch (e) {
      setNoteErr(true);
      setNote(errText(e, '更早的记录没加载出来'));
    } finally {
      setBusy('');
    }
  };

  const names = useMemo(() => (a ? a.members.map((m) => nameOf(members, m.memberId)) : []), [a, members]);
  if (err) return <div className="panel"><p role="alert" className="note note-error">{err}</p></div>;
  if (!a) return <div className="panel"><p role="status" className="note">正在加载…</p></div>;
  const paused = !!a.pausedAt;
  const next = paused ? '已暂停' : a.schedule.kind === 'manual' ? '只在你叫它时运行' : `下次运行：${whenText(a.nextRunAt, a.timezone)}`;

  return (
    <div className="panel assistant-detail">
      <div className="profile">
        <Avatar name={a.name} kind="group" size="lg" />
        <div>
          <p className="profile-name">{a.name}</p>
          <p className="muted">
            {a.schedule.text ?? scheduleText(a.schedule.kind, a.schedule)} · {next}
          </p>
          <p className="muted">
            组长 {nameOf(members, a.leadMemberId)}
            {names.length > 1 ? ` · 成员 ${names.filter((n) => n !== nameOf(members, a.leadMemberId)).join('、')}` : ''} · 额度 {BUDGET_LABEL[a.budgetLevel]}
          </p>
        </div>
      </div>
      <div className="panel-actions">
        <button type="button" className="btn btn-primary" disabled={!!busy || !!active} onClick={() => void act('run', () => assistantsApi.runNow(a.id, (runKey.current ??= newIdemKey('run'))).then(() => (runKey.current = null)), '已开始运行，结果会写进下面的对话')}>
          {active && isActive(active.status) ? '正在运行…' : busy === 'run' ? '正在开始…' : '立即运行'}
        </button>
        <button
          type="button"
          className="btn btn-outline"
          disabled={!!busy}
          onClick={() => void (paused ? act('resume', () => assistantsApi.resume(a.id), '已继续，会按计划运行') : act('pause', () => assistantsApi.pause(a.id), '已暂停，不会按计划运行'))}
        >
          {paused ? '继续' : '暂停'}
        </button>
        {active && (
          <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => void act('cancel', () => assistantsApi.cancelRun(a.id, active.id), '这次运行已取消')}>
            取消这次运行
          </button>
        )}
      </div>
      {note && (
        <p role={noteErr ? 'alert' : 'status'} className={noteErr ? 'note note-error' : 'note'}>
          {note}
        </p>
      )}

      {active && (
        <section className="group-block" aria-label="这次运行">
          <h2 className="group-title">这次运行</h2>
          <RunCard a={a} runId={active.id} members={members} live={live} />
          {active.status === 'waiting_confirmation' && (
            <div className="btn-row">
              <p className="note">要调用付费模型，等你在收件箱里确认。</p>
              <button type="button" className="btn btn-outline" onClick={onInbox}>
                去收件箱确认
              </button>
            </div>
          )}
        </section>
      )}

      <section className="group-block" aria-label="对话">
        <h2 className="group-title">对话</h2>
        {msgs.length === 0 ? (
          <p className="note">还没有消息。点「立即运行」，结果会写在这里。</p>
        ) : (
          <ol className="assistant-msgs" aria-label={`${a.name} 的对话`} aria-live="polite">
            {msgs.map((m) => (
              <MessageRow key={m.id} m={m} members={members} lead={a.leadMemberId} />
            ))}
          </ol>
        )}
      </section>

      <section className="group-block" aria-label="运行记录">
        <h2 className="group-title">运行记录</h2>
        {!runs ? (
          <p role="status" className="note">正在加载…</p>
        ) : runs.length === 0 ? (
          <p className="note">还没跑过。</p>
        ) : (
          <ul className="group run-list">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" className="row row-button" aria-expanded={open === r.id} onClick={() => setOpen((o) => (o === r.id ? null : r.id))}>
                  <span className="row-text">
                    <span className="row-label">
                      {whenText(r.requestedAt)} · {r.trigger === 'manual' ? '手动' : '定时'} · {RUN_LABEL[r.status]}
                    </span>
                    <span className="row-hint">{[r.summary, durationText(r.durationMs)].filter(Boolean).join(' · ') || '—'}</span>
                  </span>
                </button>
                {open === r.id && (
                  <div className="run-steps">
                    <RunCard a={a} runId={r.id} members={members} live={isActive(r.status)} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {more && (
          <button type="button" className="btn btn-outline" disabled={busy === 'more'} onClick={() => void loadMore()}>
            更早的记录
          </button>
        )}
      </section>
    </div>
  );
}

// ---------------- X-02 全部计划 ----------------

export function toRow(a: Assistant, members: Member[]): ScheduleRow {
  const { kind, text: _t, ...spec } = a.schedule;
  return {
    id: a.id,
    name: a.name,
    members: a.members.map((m) => nameOf(members, m.memberId)),
    instructions: a.instructions,
    scheduleKind: kind,
    scheduleSpec: spec,
    timezone: a.timezone,
    nextRunAt: a.nextRunAt,
    lastRun: a.lastRun ? { status: a.lastRun.status, ...(a.lastRun.summary ? { summary: a.lastRun.summary } : {}), ...(a.lastRun.finishedAt ? { finishedAt: a.lastRun.finishedAt } : {}) } : null,
    enabled: a.enabled && !a.pausedAt,
  };
}

export function ScheduleView({ list, error, members, onOpen, onChanged }: { list: Assistant[] | null; error: string; members: Member[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  // 同一个助手的开关请求没回来之前再点不发第二次（避免暂停 / 继续互相覆盖）
  const pending = useRef(new Set<string>());
  const toggle = async (id: string, on: boolean) => {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    setNote(null);
    try {
      await (on ? assistantsApi.resume(id) : assistantsApi.pause(id));
      onChanged();
      setNote({ text: on ? '已继续' : '已暂停', err: false });
    } catch (e) {
      setNote({ text: errText(e, '没改成，请稍后再试'), err: true });
    } finally {
      pending.current.delete(id);
    }
  };
  return (
    <div className="panel">
      <SchedulePage rows={list ? list.map((a) => toRow(a, members)) : null} {...(error ? { error } : {})} onToggle={(id, on) => void toggle(id, on)} onOpen={onOpen} />
      {note && (
        <p role={note.err ? 'alert' : 'status'} className={note.err ? 'note note-error' : 'note'}>
          {note.text}
        </p>
      )}
    </div>
  );
}
