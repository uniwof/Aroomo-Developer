import { useEffect, useState } from 'react';
import { MemberAvatar } from '@/components/brand';
import { useUsage } from '@/lib/usage';
import { api, type Member } from '@/lib/api';
import { HoverCard } from '@/components/HoverCard';
import { CapabilityMap } from '@/components/CapabilityMap';
import { UsageLine } from '@/components/UsageLine';

// #281：UsageLine 挪到 components/UsageLine.tsx（对话页只要这一行）；这里照旧导出，旧的引用不用改
export { UsageLine };

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
      <h1 id="members-title" className="text-[1.25rem] font-semibold">
        能力地图与成员
      </h1>
      <CapabilityMap />
      <h2 className="text-[1.125rem] font-semibold">成员</h2>
      {error && <p role="alert">{error}</p>}
      {!members && !error && <p className="text-[var(--muted)]">正在加载…</p>}
      {members && members.length === 0 && <p className="text-[var(--muted)]">还没有成员。到「Key 与接入」填一个模型 Key，模型就会成为候选成员。</p>}
      {members && members.length > 0 && (
        <ul className="group">
          {members.map((m) => {
            const online = m.online ?? (m.enabled && m.status === 'active');
            return (
              <li key={m.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                <HoverCard memberId={m.id}>
                  <MemberAvatar
                    name={m.name}
                    online={online}
                    status={!m.enabled ? 'paused' : online ? 'available' : 'sleeping'}
                    used={usage?.find((u) => u.memberId === m.id)?.quota.used}
                    limit={usage?.find((u) => u.memberId === m.id)?.quota.limit}
                  />
                </HoverCard>
                <div className="min-w-0 flex-1">
                  <div className="font-medium [overflow-wrap:anywhere]">{m.name}</div>
                  <div className="text-[var(--muted)] [overflow-wrap:anywhere]">
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
