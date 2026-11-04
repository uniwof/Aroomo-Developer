/**
 * 审计（只读，M2 验收第⑤步）：GET /api/audit?limit=50，新的在前，「加载更多」用 nextCursor。
 * audit:read 只给所有者（设计如此）：账号用户打开时后端回 403，页面只说明一句，不报错。
 * 筛选（动作前缀、结果）在已加载的记录上做：后端 action 参数是精确匹配，前缀筛选不往后端传。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';

export interface AuditRow {
  id: string;
  ts: string;
  actor: { type: string; id: string };
  action: string;
  target: { type: string; id: string };
  result: 'ok' | 'denied' | 'failed';
  note?: string;
}

const PAGE = 50;

export const RESULT_LABEL: Record<string, string> = { ok: '成功', denied: '被拒绝', failed: '失败' };
const RESULT_CLASS: Record<string, string> = {
  ok: 'border-green-600 text-green-700 dark:text-green-400',
  denied: 'border-amber-600 text-amber-700 dark:text-amber-400',
  failed: 'border-red-600 text-red-700 dark:text-red-400',
};
const ACTOR_LABEL: Record<string, string> = {
  owner: '所有者',
  operator: '操作员',
  system: '系统',
  member: '成员',
  user: '账号',
  client: '客户端',
};

/** 谁：所有者 / 账号 xxx / 客户端「名字」（名字查不到就显示 id，不编造） */
export function actorText(a: AuditRow['actor'], clientNames: Record<string, string>): string {
  if (a.type === 'owner') return '所有者';
  if (a.type === 'system') return '系统';
  const label = ACTOR_LABEL[a.type] ?? a.type;
  if (a.type === 'client' && clientNames[a.id]) return `客户端「${clientNames[a.id]}」`;
  return `${label} ${a.id}`;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [result, setResult] = useState('');
  const [clientNames, setClientNames] = useState<Record<string, string>>({});

  const loadPage = useCallback(async (after: string | null) => {
    setBusy(true);
    setMsg('');
    try {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (after) qs.set('cursor', after);
      const r = await api<{ entries: AuditRow[]; nextCursor: string | null }>('GET', `/api/audit?${qs.toString()}`);
      setRows((prev) => (after && prev ? [...prev, ...r.entries] : r.entries));
      setCursor(r.nextCursor);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setMsg(e instanceof ApiError ? e.message : '加载失败，请稍后再试');
      setRows((v) => v ?? []);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadPage(null);
    // 客户端名字：只能查到自己的客户端；查不到就显示 id
    api<{ clients: Array<{ id: string; name: string }> }>('GET', '/api/clients')
      .then((r) => setClientNames(Object.fromEntries(r.clients.map((c) => [c.id, c.name]))))
      .catch(() => undefined);
  }, [loadPage]);

  if (forbidden) {
    return (
      <section aria-labelledby="audit-title" className="space-y-4">
        <h1 id="audit-title" className="text-[1.25rem] font-semibold">
          审计
        </h1>
        <p role="status">审计只有所有者能看。</p>
      </section>
    );
  }

  const p = prefix.trim();
  const shown = (rows ?? []).filter((r) => (!p || r.action.startsWith(p)) && (!result || r.result === result));

  return (
    <section aria-labelledby="audit-title" className="space-y-4">
      <h1 id="audit-title" className="text-[1.25rem] font-semibold">
        审计
      </h1>
      <p className="text-[var(--muted)]">谁在什么时候做了什么，只能看，不能改。新的在前。</p>

      <div className="flex flex-wrap gap-4 rounded-2xl bg-[var(--card)] p-4">
        <label className="flex flex-col gap-1">
          <span>动作开头</span>
          <input
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="如 gateway. 或 mcp."
            className="min-h-12 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>结果</span>
          <select value={result} onChange={(e) => setResult(e.target.value)} className="min-h-12 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3">
            <option value="">全部</option>
            <option value="ok">成功</option>
            <option value="denied">被拒绝</option>
            <option value="failed">失败</option>
          </select>
        </label>
      </div>

      <p role="status" aria-live="polite" className="text-[var(--muted)]">
        {rows === null ? '正在加载…' : msg || `显示 ${shown.length} 条（已加载 ${rows.length} 条）`}
      </p>

      <ul className="flex flex-col gap-2" aria-label="审计记录">
        {shown.map((r) => (
          <li key={r.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-all">{r.action}</span>
              <span className={`rounded-full border px-2 py-0.5 ${RESULT_CLASS[r.result] ?? ''}`}>{RESULT_LABEL[r.result] ?? r.result}</span>
            </div>
            <div className="break-all">
              对象：{r.target.type}/{r.target.id}
            </div>
            <div className="text-[var(--muted)] break-all">
              {fmt(r.ts)} · {actorText(r.actor, clientNames)}
            </div>
            {r.note && <div className="break-words text-[var(--muted)]">备注：{r.note}</div>}
          </li>
        ))}
      </ul>

      {cursor && (
        <Button variant="outline" className="min-h-12" disabled={busy} onClick={() => void loadPage(cursor)}>
          {busy ? '正在加载…' : '加载更多'}
        </Button>
      )}
    </section>
  );
}
