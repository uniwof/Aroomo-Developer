/** 接管卡：本机执行员遇到验证码/登录等需要所有者亲自处理时出现。按钮：我已处理 / 继续 / 放弃。 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { useAsk } from '@/components/Dialog';

interface Task {
  id: string;
  site?: string;
  kind?: string;
  status: string;
}
interface Takeover {
  id: string;
  taskId: string;
  reason: string;
  message: string;
  status: 'pending' | 'resolved' | 'cancelled';
}

const reasons: Record<string, string> = {
  captcha: '遇到验证码',
  '2fa': '需要二次验证',
  payment: '需要付款确认',
  login_failed: '登录失败',
  not_allowed: '不在允许范围内',
};

export function TakeoverCards() {
  const [cards, setCards] = useState<Array<Takeover & { site?: string }>>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const ask = useAsk();

  const load = useCallback(async () => {
    try {
      const { tasks } = await api<{ tasks: Task[] }>('GET', '/api/tasks');
      const live = tasks.filter((t) => !['succeeded', 'failed', 'cancelled'].includes(t.status));
      const lists = await Promise.all(
        live.map((t) =>
          api<{ takeovers: Takeover[] }>('GET', `/api/tasks/${t.id}/takeovers`).then((r) =>
            r.takeovers.filter((x) => x.status === 'pending').map((x) => ({ ...x, site: t.site })),
          ),
        ),
      );
      setCards(lists.flat());
    } catch (e) {
      if (!(e instanceof ApiError && (e.status === 403 || e.status === 404))) setMsg('接管卡加载失败，请稍后再试');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(c: Takeover & { site?: string }, cancel: boolean) {
    if (busy) return;
    // 放弃 = 取消整个任务：先确认，说清是哪个任务（审计 I2）；关掉确认不做决定
    if (cancel && !(await ask.confirm({ title: `放弃${c.site ? `「${c.site}」` : '这个'}任务？`, desc: '任务会被取消，关掉这个窗口不会做任何决定。', ok: '放弃任务', danger: true }))) return;
    setBusy(c.id);
    setMsg('');
    try {
      await api('POST', `/api/tasks/${c.taskId}/takeovers/${c.id}/resolve`, { cancel });
      setMsg(cancel ? '已放弃这个任务' : '好的，任务继续');
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    } finally {
      setBusy(null);
    }
  }

  if (cards.length === 0 && !msg) return null;
  return (
    <div className="space-y-2" aria-labelledby="takeover-title" role="region">
      {ask.node}
      <h3 id="takeover-title" className="group-title">
        需要你亲自处理
      </h3>
      <p role="status" className="text-[var(--muted)]">
        {msg}
      </p>
      <ul className="space-y-2">
        {cards.map((c) => (
          <li key={c.id} className="card space-y-2">
            <p className="font-medium">
              {reasons[c.reason] ?? '需要你处理'}
              {c.site ? `（${c.site}）` : ''}
            </p>
            <p className="whitespace-pre-wrap text-[var(--muted)]">{c.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy === c.id} onClick={() => resolve(c, false)}>
                我已处理，继续
              </Button>
              <Button disabled={busy === c.id} onClick={() => resolve(c, true)}>
                放弃
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
