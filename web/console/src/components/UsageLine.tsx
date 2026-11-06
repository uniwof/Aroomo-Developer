/**
 * 成员一行的「今天几次 / 每天上限」（从 pages/Members.tsx 拆出，#281）：对话页设置 › 成员只要这一行，
 * 不再顺带把旧成员页和能力地图打进对话页包（能力地图点开才下载，见 capability-panel）。
 */
import { useState } from 'react';
import { QuotaRing } from '@/components/brand';
import type { UsageRow } from '@/lib/usage';
import { api } from '@/lib/api';

/** 今天几次 + 每天上限（所有者自己填；没填 = 未知）。PUT /api/usage/limits/:memberId */
export function UsageLine({ row, onSaved }: { row: UsageRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const [err, setErr] = useState('');
  async function save(next: number | null) {
    setErr('');
    try {
      await api('PUT', `/api/usage/limits/${encodeURIComponent(row.memberId)}`, { dailyLimit: next });
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const limitText = row.quota.limit != null ? `${row.quota.limit}` : '未知';
  return (
    <div className="flex flex-wrap items-center gap-2 text-[var(--muted)]">
      <QuotaRing used={row.quota.used} limit={row.quota.limit} size={24} />
      <span>
        今天 {row.today.requests} 次{row.today.limited > 0 && ' · 被限流'} · 每天上限 {limitText}
      </span>
      {!editing && (
        <button type="button" className="btn btn-quiet" onClick={() => setEditing(true)} aria-label={`设置 ${row.name} 每天次数上限`}>
          设上限
        </button>
      )}
      {editing && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(val);
            if (!Number.isInteger(n) || n < 1) return setErr('填一个大于 0 的整数');
            void save(n);
          }}
        >
          <label className="sr-only" htmlFor={`lim-${row.memberId}`}>
            {row.name} 每天次数上限
          </label>
          <input id={`lim-${row.memberId}`} inputMode="numeric" className="w-28" value={val} onChange={(e) => setVal(e.target.value)} />
          <button type="submit" className="btn btn-primary">
            保存
          </button>
          {row.quota.limit != null && (
            <button type="button" className="btn btn-outline" onClick={() => void save(null)}>
              清除
            </button>
          )}
          <button type="button" className="btn btn-outline" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      )}
      {err && <span role="alert">{err}</span>}
    </div>
  );
}
