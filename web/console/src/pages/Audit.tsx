/**
 * 审计（只读，M2 验收第⑤步）：GET /api/audit?limit=50，新的在前，「加载更多」用 nextCursor。
 * audit:read 只给所有者（设计如此）：账号用户打开时后端回 403，页面只说明一句，不报错。
 * 筛选（动作前缀、结果）在已加载的记录上做：后端 action 参数是精确匹配，前缀筛选不往后端传。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
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
  const statusRef = useRef<HTMLParagraphElement>(null);

  const loadPage = useCallback(async (after: string | null) => {
    setBusy(true);
    setMsg('');
    try {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (after) qs.set('cursor', after);
      const r = await api<{ entries: AuditRow[]; nextCursor: string | null }>('GET', `/api/audit?${qs.toString()}`);
      setRows((prev) => (after && prev ? [...prev, ...r.entries] : r.entries));
      setCursor(r.nextCursor);
      // 「加载更多」点完没有下一页时按钮会消失：焦点放到状态行，键盘用户不会掉回页首
      if (after && !r.nextCursor) requestAnimationFrame(() => statusRef.current?.focus());
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
      <section aria-labelledby="audit-title" className="page">
        <h1 id="audit-title" className="page-title">
          审计
        </h1>
        <p role="status" className="note">
          审计只有所有者能看。
        </p>
      </section>
    );
  }

  const p = prefix.trim();
  const shown = (rows ?? []).filter((r) => (!p || r.action.startsWith(p)) && (!result || r.result === result));

  // 照 sumus 设置页：灰色说明一句 → 一排筛选（搜索框 + 下拉，和全站同一种）→ 细边分组卡，一行一条记录（#250 unify5，不再用灰底卡片）
  return (
    <section aria-labelledby="audit-title" className="page">
      <div className="page-head">
        <h1 id="audit-title" className="page-title">
          审计
        </h1>
        <p className="page-sub">谁在什么时候做了什么，只能看，不能改。新的在前。</p>
      </div>

      <div className="toolbar">
        <label className="search2 toolbar-search">
          <Search aria-hidden="true" />
          <span className="sr-only">动作开头</span>
          <input type="search" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="动作开头，如 gateway." />
        </label>
        <div className="toolbar-select">
          <span id="audit-result-label" className="toolbar-select-label">
            结果
          </span>
          <select className="field-select" aria-labelledby="audit-result-label" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">全部</option>
            <option value="ok">成功</option>
            <option value="denied">被拒绝</option>
            <option value="failed">失败</option>
          </select>
        </div>
      </div>

      <p ref={statusRef} tabIndex={-1} role="status" aria-live="polite" className="note">
        {rows === null ? '正在加载…' : msg || `显示 ${shown.length} 条（已加载 ${rows.length} 条）`}
      </p>

      {rows !== null && shown.length === 0 && !msg ? (
        <div className="empty">
          <p className="empty-text">{rows.length ? '没有符合筛选的记录。' : '还没有记录。'}</p>
        </div>
      ) : (
        <ul className="group" aria-label="审计记录">
          {shown.map((r) => (
            <li key={r.id} className="row audit-row">
              <span className="row-text">
                <span className="row-label row-break">{r.action}</span>
                <span className="row-hint row-break">
                  对象：{r.target.type}/{r.target.id}
                </span>
                <span className="row-hint row-break">
                  {fmt(r.ts)} · {actorText(r.actor, clientNames)}
                </span>
                {r.note && <span className="row-hint row-break">备注：{r.note}</span>}
              </span>
              <span className={r.result === 'ok' ? 'row-value' : 'row-value audit-bad'}>{RESULT_LABEL[r.result] ?? r.result}</span>
            </li>
          ))}
        </ul>
      )}

      {cursor && (
        <button type="button" className="btn btn-outline audit-more" disabled={busy} onClick={() => void loadPage(cursor)}>
          {busy ? '正在加载…' : '加载更多'}
        </button>
      )}
    </section>
  );
}
