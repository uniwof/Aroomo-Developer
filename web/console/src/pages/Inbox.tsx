/** 收件箱：待决定 / 候选 / 简报（/api/inbox）。需要两步确认的动作先提示，待确认卡组件接入。 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

interface Action {
  id: string;
  label: string;
  confirm?: { kind: string; consequences?: string[] };
}
interface Item {
  id: string;
  group: 'decision' | 'candidate' | 'brief';
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

export function Inbox() {
  const [data, setData] = useState<Record<string, Item[]> | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<{ groups: Record<string, Item[]> }>('GET', '/api/inbox?status=open')
      .then((r) => setData(r.groups))
      .catch((e) => setMsg(e instanceof ApiError && e.status === 403 ? '这个账号还不能查看收件箱' : '加载失败，请稍后再试'));
  }, []);
  useEffect(load, [load]);

  async function act(item: Item, a: Action) {
    setMsg('');
    try {
      await api('POST', `/api/inbox/${item.id}/actions/${a.id}`, {});
      setMsg('已处理');
      load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }

  return (
    <section aria-labelledby="inbox-title" className="space-y-6">
      <h1 id="inbox-title" className="text-[20px] font-semibold">
        收件箱
      </h1>
      <p role="status" className="text-[var(--muted)]">
        {msg}
      </p>
      {data === null && !msg && <p className="text-[var(--muted)]">加载中…</p>}
      {data &&
        groups.map((g) => (
          <div key={g.key} className="space-y-2">
            <h2 className="text-[16px] font-semibold">{g.title}</h2>
            {(data[g.key] ?? []).length === 0 && <p className="text-[var(--muted)]">暂时没有</p>}
            <ul className="space-y-2">
              {(data[g.key] ?? []).map((i) => (
                <li key={i.id} className="space-y-2 rounded-xl border border-[var(--border)] p-3">
                  <p className="font-medium">
                    {i.urgency === 'urgent' ? '【紧急】' : ''}
                    {i.title}
                  </p>
                  {i.summary && <p className="whitespace-pre-wrap text-[var(--muted)]">{i.summary}</p>}
                  <div className="flex flex-wrap gap-2">
                    {(i.actions ?? []).map((a) =>
                      a.confirm ? (
                        <span key={a.id} className="min-h-11 content-center text-[var(--muted)]">
                          「{a.label}」需要两步确认，确认卡正在接入
                        </span>
                      ) : (
                        <Button key={a.id} className="min-h-11" onClick={() => act(i, a)}>
                          {a.label}
                        </Button>
                      ),
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}
