import { useEffect, useState } from 'react';
import { MemberAvatar, QuotaRing } from '@/components/brand';
import { useUsage, type UsageRow } from '@/lib/usage';
import { api, type Member } from '@/lib/api';
import { CapabilityMap } from '@/components/CapabilityMap';

/** 今天几次 + 每天上限（所有者自己填；没填 = 未知）。PUT /api/usage/limits/:memberId */
function UsageLine({ row, onSaved }: { row: UsageRow; onSaved: () => void }) {
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
    <div className="flex flex-wrap items-center gap-2 text-[14px] text-[var(--muted)]">
      <QuotaRing used={row.quota.used} limit={row.quota.limit} size={24} />
      <span>
        今天 {row.today.requests} 次{row.today.limited > 0 && ' · 被限流'} · 每天上限 {limitText}
      </span>
      {!editing && (
        <button type="button" className="min-h-11 rounded-xl px-3 underline" onClick={() => setEditing(true)} aria-label={`设置 ${row.name} 每天次数上限`}>
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
          <input id={`lim-${row.memberId}`} inputMode="numeric" className="min-h-11 w-28 rounded-xl border border-[var(--border)] bg-transparent px-3 text-[14px]" value={val} onChange={(e) => setVal(e.target.value)} />
          <button type="submit" className="min-h-11 rounded-xl px-3 font-semibold">
            保存
          </button>
          {row.quota.limit != null && (
            <button type="button" className="min-h-11 rounded-xl px-3" onClick={() => void save(null)}>
              清除
            </button>
          )}
          <button type="button" className="min-h-11 rounded-xl px-3" onClick={() => setEditing(false)}>
            取消
          </button>
        </form>
      )}
      {err && <span role="alert">{err}</span>}
    </div>
  );
}

/** 能力地图与成员。能力清单 API（/api/capabilities）由后台线提供后再加能力地图；先列成员。 */
export function Members() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const { rows: usage, reload: reloadUsage } = useUsage(120_000);

  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>('GET', '/api/members')
      .then((r) => alive && setMembers(r.members))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <section aria-labelledby="members-title" className="space-y-4">
      <h1 id="members-title" className="text-[20px] font-semibold">
        能力地图与成员
      </h1>
      <CapabilityMap />
      <h2 className="text-[18px] font-semibold">成员</h2>
      {error && <p role="alert">{error}</p>}
      {!members && !error && <p className="text-[var(--muted)]">正在加载…</p>}
      {members && members.length === 0 && <p className="text-[var(--muted)]">还没有成员。到「Key 与接入」填一个模型 Key，模型就会成为候选成员。</p>}
      {members && members.length > 0 && (
        <ul className="divide-y divide-[var(--border)] rounded-2xl bg-[var(--card)]">
          {members.map((m) => {
            const online = m.online ?? (m.enabled && m.status === 'active');
            return (
              <li key={m.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <MemberAvatar name={m.name} online={online} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{m.name}</div>
                  <div className="truncate text-[var(--muted)]">
                    {m.status === 'candidate' ? '候选' : online ? '在线' : '离线'}
                    {m.capabilityTags.length > 0 && ` · ${m.capabilityTags.join('、')}`}
                  </div>
                  {(() => {
                    const row = usage?.find((u) => u.memberId === m.id);
                    return row ? <UsageLine row={row} onSaved={() => void reloadUsage()} /> : null;
                  })()}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
