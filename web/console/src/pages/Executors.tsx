/** 本机执行员（M3）：设备在线/离线、任务进度、吊销设备（走确认卡）。接 /api/executors、/api/tasks、DELETE /api/clients/:id。 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { Allowlist } from '@/components/Allowlist';

export interface ExecutorInfo {
  id: string;
  clientId?: string;
  deviceName: string;
  platform: string;
  version: string;
  adapters: string[];
  lastSeenAt: string;
  online: boolean;
}
export interface TaskInfo {
  id: string;
  kind: string;
  site: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  lastStage: string | null;
  lastMessage: string | null;
  resultSummary: string | null;
  resultError: string | null;
  createdAt: string;
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
const KIND_LABEL: Record<string, string> = { checkin: '签到', login: '登录', signup: '注册', browse: '浏览' };

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export function Executors() {
  const [devices, setDevices] = useState<ExecutorInfo[] | null>(null);
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState<{ kind: 'revoke' | 'cancel'; id: string; label: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api<{ executors: ExecutorInfo[] }>('GET', '/api/executors'), api<{ tasks: TaskInfo[] }>('GET', '/api/tasks')]);
      setDevices(d.executors);
      setTasks(t.tasks);
    } catch (e) {
      setDevices((v) => v ?? []);
      setTasks((v) => v ?? []);
      setMsg(e instanceof ApiError && e.status === 404 ? '本机执行员功能还没上线，稍后再来' : '加载失败，请稍后再试');
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function doConfirm() {
    if (!confirm) return;
    const c = confirm;
    setConfirm(null);
    setMsg('');
    try {
      if (c.kind === 'revoke') {
        await api('DELETE', `/api/clients/${c.id}`);
        setMsg(`已吊销「${c.label}」，这台电脑立刻不能再领任务`);
      } else {
        await api('POST', `/api/tasks/${c.id}/cancel`);
        setMsg('已请求取消这个任务');
      }
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : '操作失败，请稍后再试');
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">本机执行员</h1>
      {msg && <p role="status">{msg}</p>}

      {confirm && (
        <div role="alertdialog" aria-labelledby="exec-confirm-title" className="rounded-xl border-2 border-[var(--border)] p-4">
          <h2 id="exec-confirm-title" className="text-[16px] font-semibold">
            {confirm.kind === 'revoke' ? `吊销「${confirm.label}」？` : '取消这个任务？'}
          </h2>
          <p className="mt-1 text-[var(--muted)]">{confirm.kind === 'revoke' ? '吊销后这台电脑马上不能再领任务，想恢复要重新配对。' : '正在进行的步骤会在下一个检查点停下。'}</p>
          <div className="mt-3 flex gap-2">
            <Button type="button" className="min-h-11" onClick={() => void doConfirm()}>
              {confirm.kind === 'revoke' ? '确认吊销' : '确认取消任务'}
            </Button>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirm(null)}>
              先不了
            </Button>
          </div>
        </div>
      )}

      <section aria-labelledby="exec-devices" className="flex flex-col gap-2">
        <h2 id="exec-devices" className="text-[16px] font-semibold">
          电脑
        </h2>
        {devices === null && <p className="text-[var(--muted)]">正在加载…</p>}
        {devices?.length === 0 && <p className="text-[var(--muted)]">还没有电脑连上来。装好本机执行员并配对后会出现在这里。</p>}
        <ul className="flex flex-col gap-2">
          {devices?.map((d) => (
            <li key={d.id} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.deviceName}</span>
                <span className="rounded-full border border-[var(--border)] px-2 py-0.5">{d.online ? '● 在线' : '○ 离线'}</span>
              </div>
              <div className="text-[var(--muted)]">
                {d.platform} · 版本 {d.version} · 最近一次联系 {ago(d.lastSeenAt)}
              </div>
              {d.clientId && (
                <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={() => setConfirm({ kind: 'revoke', id: d.clientId as string, label: d.deviceName })} aria-label={`吊销 ${d.deviceName}`}>
                  吊销这台电脑
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <Allowlist />

      <section aria-labelledby="exec-tasks" className="flex flex-col gap-2">
        <h2 id="exec-tasks" className="text-[16px] font-semibold">
          任务
        </h2>
        {tasks === null && <p className="text-[var(--muted)]">正在加载…</p>}
        {tasks?.length === 0 && <p className="text-[var(--muted)]">还没有任务。</p>}
        <ul className="flex flex-col gap-2">
          {tasks?.slice(0, 30).map((t) => (
            <li key={t.id} className="rounded-xl border border-[var(--border)] p-3">
              <div className="font-medium break-all">
                {KIND_LABEL[t.kind] ?? t.kind} · {t.site}
              </div>
              <div>
                {STATUS_LABEL[t.status] ?? t.status}
                {t.status === 'running' && t.lastMessage ? `：${t.lastMessage}` : ''}
              </div>
              {t.resultSummary && <p className="break-words text-[var(--muted)]">{t.resultSummary}</p>}
              {t.resultError && <p className="break-words">{t.resultError}</p>}
              <div className="text-[var(--muted)]">{ago(t.createdAt)}创建</div>
              {(t.status === 'queued' || t.status === 'running') && (
                <Button type="button" variant="outline" className="mt-2 min-h-11" onClick={() => setConfirm({ kind: 'cancel', id: t.id, label: t.site })} aria-label={`取消任务 ${t.site}`}>
                  取消任务
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
