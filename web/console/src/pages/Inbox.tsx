/**
 * 收件箱：待决定 / 候选 / 简报（/api/inbox）。重要动作走两步确认卡。
 * X-04（功能补充 v1）：最上面一个筛选「等你处理 / 全部」，默认「等你处理」= 带动作按钮、要你点一下的条目（确认、入职候选等）；
 * 「全部」再加上只是告诉你一声的简报。家人只看到自己的（Core 按账号过滤）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, type Challenge } from '@/lib/api';
import { ConfirmCard } from '@/components/ConfirmCard';
import { TakeoverCards } from '@/components/TakeoverCards';
import { useAsk } from '@/components/Dialog';
import { inboxChanged } from '@/lib/inbox';

/** 拒绝、驳回这类动作：先确认，关掉确认不做决定（规范 §8 拒绝状态机） */
const isReject = (a: Action) => /^(reject|deny|decline|dismiss|refuse)/i.test(a.id) || /^(拒绝|驳回|不同意|不批准)/.test(a.label);

interface Action {
  id: string;
  label: string;
  confirm?: { kind: string; consequences?: string[] };
}
interface Item {
  id: string;
  group: 'decision' | 'candidate' | 'brief';
  kind?: string;
  title: string;
  summary?: string;
  urgency?: 'urgent' | 'normal' | 'low';
  actions?: Action[];
  createdAt: string;
}

/** 要你点一下才算处理完的条目 */
export const needsYou = (i: Item) => (i.actions ?? []).length > 0;

const groups: { key: Item['group']; title: string }[] = [
  { key: 'decision', title: '等你决定' },
  { key: 'candidate', title: '候选' },
  { key: 'brief', title: '简报' },
];

/** 2026-10-31 08:05 这样的短时间，读屏友好；解析失败就原样显示。 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** onBack：空状态的那一个动作（回到对话）；对话页里传入 */
export function Inbox({ onBack }: { onBack?: () => void } = {}) {
  const [data, setData] = useState<Record<string, Item[]> | null>(null);
  const [msg, setMsg] = useState('');
  // 正在两步确认的动作：重要动作第一次点会拿到 428 + 确认卡
  const [pending, setPending] = useState<{ item: Item; action: Action; challenge: Challenge } | null>(null);
  const [show, setShow] = useState<'mine' | 'all'>('mine');
  // 正在处理的那一条：它的按钮全部锁住，防重复提交（审计 I1；规范 §8 待定 → 已确认 → 执行中 → 完成 / 失败）
  const [busyId, setBusyId] = useState<string | null>(null);
  const ask = useAsk();

  const load = useCallback(() => {
    api<{ groups: Record<string, Item[]> }>('GET', '/api/inbox?status=open')
      // 接管卡已由上面的 TakeoverCards 显示，收件箱里同一张卡不再重复出现
      .then((r) => setData(Object.fromEntries(Object.entries(r.groups).map(([k, v]) => [k, v.filter((i) => i.kind !== 'executor.takeover')]))))
      .catch((e) => setMsg(e instanceof ApiError && e.status === 403 ? '这个账号还不能查看收件箱' : '加载失败，请稍后再试'));
  }, []);
  useEffect(load, [load]);

  async function act(item: Item, a: Action, confirmToken?: string) {
    if (busyId && !confirmToken) return;
    if (!confirmToken && isReject(a) && !(await ask.confirm({ title: `${a.label}「${item.title}」？`, desc: '关掉这个窗口不会做任何决定。', ok: a.label, danger: true }))) return;
    setBusyId(item.id);
    setMsg(`正在处理：${a.label}「${item.title}」…`);
    try {
      await api('POST', `/api/inbox/${item.id}/actions/${a.id}`, confirmToken ? { confirmToken } : {});
      setPending(null);
      // 只在 Core 回了成功之后才说完成，不提前打勾
      setMsg(`已处理：${a.label}「${item.title}」`);
      load();
      inboxChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 428 && e.confirm) {
        setPending({ item, action: a, challenge: e.confirm });
        setMsg('');
      } else if (confirmToken) throw e;
      else setMsg(`没处理成：${e instanceof ApiError ? e.message : '请稍后再试'}（这一条还在，可以再点一次）`);
    } finally {
      setBusyId(null);
    }
  }

  /** 知道了：把条目移出收件箱（POST /api/inbox/dismiss，批量）。 */
  async function dismiss(ids: string[]) {
    setMsg('');
    try {
      await api('POST', '/api/inbox/dismiss', { ids });
      setMsg(ids.length > 1 ? `已清掉 ${ids.length} 条` : '已清掉');
      load();
      inboxChanged();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }
  const canDismiss = (i: Item) => i.group !== 'decision' || (i.actions ?? []).length === 0;

  const all = data ?? {};
  const view: Record<string, Item[]> = Object.fromEntries(groups.map((g) => [g.key, (all[g.key] ?? []).filter((i) => show === 'all' || needsYou(i))]));
  const total = groups.reduce((n, g) => n + (all[g.key] ?? []).length, 0);
  const shown = groups.reduce((n, g) => n + (view[g.key] ?? []).length, 0);

  return (
    <section aria-labelledby="inbox-title" className="page">
      {ask.node}
      <h1 id="inbox-title" className="page-title">
        收件箱
      </h1>
      {/* 照 sumus 全站唯一那种分段筛选（是筛选，不是标签页） */}
      <div className="seg inbox-filter" role="radiogroup" aria-label="收件箱筛选">
        {(
          [
            ['mine', '等你处理'],
            ['all', '全部'],
          ] as const
        ).map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={show === v} className="seg-item" onClick={() => setShow(v)}>
            {text}
          </button>
        ))}
      </div>
      <p role="status" className="row-status">
        {msg}
      </p>
      <TakeoverCards />
      {data === null && !msg && <p className="muted">加载中…</p>}
      {/* 自审 B17：都空时只显示一个空状态（一句话 + 一个动作），不再三个框各写「暂时没有」 */}
      {data && shown === 0 && (
        <div className="empty">
          <p className="empty-text">{total === 0 ? '收件箱是空的。有要你决定的事，会出现在这里。' : '没有等你处理的事。'}</p>
          {total > 0 ? (
            <button type="button" className="btn btn-outline" onClick={() => setShow('all')}>
              看全部（{total} 条）
            </button>
          ) : (
            onBack && (
              <button type="button" className="btn btn-outline" onClick={onBack}>
                回到对话
              </button>
            )
          )}
        </div>
      )}
      {data &&
        shown > 0 &&
        groups
          // 空的组不占地方（「全部」里也一样，不再一个个写「暂时没有」）
          .filter((g) => (view[g.key] ?? []).length > 0)
          .map((g) => (
          <div key={g.key} className="group-block">
            <div className="group-head">
              <h2 className="group-title">{g.title}</h2>
              {g.key === 'brief' && (view[g.key] ?? []).length > 1 && (
                <Button variant="outline" onClick={() => dismiss((view[g.key] ?? []).map((i) => i.id))}>
                  全部知道了
                </Button>
              )}
            </div>
            <ul className="group">
              {(view[g.key] ?? []).map((i) => (
                <li key={i.id} className="row row-stack">
                  <p className="row-label">
                    {i.urgency === 'urgent' ? '【紧急】' : ''}
                    {i.title}
                  </p>
                  {i.summary && <p className="row-hint whitespace-pre-wrap">{i.summary}</p>}
                  <p className="row-hint">{formatTime(i.createdAt)}</p>
                  <div className="row-actions">
                    {(i.actions ?? []).map((a) => (
                      <Button key={a.id} variant={a.confirm && a.confirm.kind !== 'normal' ? 'outline' : 'default'} disabled={busyId === i.id} onClick={() => void act(i, a)}>
                        {a.label}
                      </Button>
                    ))}
                    {canDismiss(i) && (
                      <Button variant="outline" aria-label={`知道了：${i.title}`} disabled={busyId === i.id} onClick={() => dismiss([i.id])}>
                        知道了
                      </Button>
                    )}
                  </div>
                  {pending?.item.id === i.id && (
                    <ConfirmCard
                      challenge={pending.challenge}
                      onCancel={() => setPending(null)}
                      onToken={(t) => act(pending.item, pending.action, t)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
