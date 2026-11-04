/** 收件箱：待决定 / 候选 / 简报（/api/inbox）。重要动作走两步确认卡。 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api, type Challenge } from '@/lib/api';
import { ConfirmCard } from '@/components/ConfirmCard';
import { TakeoverCards } from '@/components/TakeoverCards';

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

export function Inbox() {
  const [data, setData] = useState<Record<string, Item[]> | null>(null);
  const [msg, setMsg] = useState('');
  // 正在两步确认的动作：重要动作第一次点会拿到 428 + 确认卡
  const [pending, setPending] = useState<{ item: Item; action: Action; challenge: Challenge } | null>(null);

  const load = useCallback(() => {
    api<{ groups: Record<string, Item[]> }>('GET', '/api/inbox?status=open')
      // 接管卡已由上面的 TakeoverCards 显示，收件箱里同一张卡不再重复出现
      .then((r) => setData(Object.fromEntries(Object.entries(r.groups).map(([k, v]) => [k, v.filter((i) => i.kind !== 'executor.takeover')]))))
      .catch((e) => setMsg(e instanceof ApiError && e.status === 403 ? '这个账号还不能查看收件箱' : '加载失败，请稍后再试'));
  }, []);
  useEffect(load, [load]);

  async function act(item: Item, a: Action, confirmToken?: string) {
    setMsg('');
    try {
      await api('POST', `/api/inbox/${item.id}/actions/${a.id}`, confirmToken ? { confirmToken } : {});
      setPending(null);
      setMsg('已处理');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 428 && e.confirm) setPending({ item, action: a, challenge: e.confirm });
      else if (confirmToken) throw e;
      else setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }

  /** 知道了：把条目移出收件箱（POST /api/inbox/dismiss，批量）。 */
  async function dismiss(ids: string[]) {
    setMsg('');
    try {
      await api('POST', '/api/inbox/dismiss', { ids });
      setMsg(ids.length > 1 ? `已清掉 ${ids.length} 条` : '已清掉');
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }
  const canDismiss = (i: Item) => i.group !== 'decision' || (i.actions ?? []).length === 0;

  return (
    <section aria-labelledby="inbox-title" className="space-y-6">
      <h1 id="inbox-title" className="text-[20px] font-semibold">
        收件箱
      </h1>
      <p role="status" className="text-[var(--muted)]">
        {msg}
      </p>
      <TakeoverCards />
      {data === null && !msg && <p className="text-[var(--muted)]">加载中…</p>}
      {data &&
        groups.map((g) => (
          <div key={g.key} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-[16px] font-semibold">{g.title}</h2>
              {g.key === 'brief' && (data[g.key] ?? []).length > 1 && (
                <Button variant="outline" className="min-h-11" onClick={() => dismiss((data[g.key] ?? []).map((i) => i.id))}>
                  全部知道了
                </Button>
              )}
            </div>
            {(data[g.key] ?? []).length === 0 && <p className="text-[var(--muted)]">暂时没有</p>}
            <ul className="space-y-2">
              {(data[g.key] ?? []).map((i) => (
                <li key={i.id} className="space-y-2 rounded-xl border border-[var(--border)] p-3">
                  <p className="font-medium">
                    {i.urgency === 'urgent' ? '【紧急】' : ''}
                    {i.title}
                  </p>
                  {i.summary && <p className="whitespace-pre-wrap text-[var(--muted)]">{i.summary}</p>}
                  <p className="text-[14px] text-[var(--muted)]">{formatTime(i.createdAt)}</p>
                  <div className="flex flex-wrap gap-2">
                    {(i.actions ?? []).map((a) => (
                      <Button key={a.id} className="min-h-11" variant={a.confirm && a.confirm.kind !== 'normal' ? 'outline' : 'default'} onClick={() => void act(i, a)}>
                        {a.label}
                      </Button>
                    ))}
                    {canDismiss(i) && (
                      <Button variant="outline" className="min-h-11" aria-label={`知道了：${i.title}`} onClick={() => dismiss([i.id])}>
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
