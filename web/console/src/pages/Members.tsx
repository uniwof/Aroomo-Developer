import { useEffect, useState } from 'react';
import { MemberAvatar } from '@/components/brand';
import { api, type Member } from '@/lib/api';

/** 能力地图与成员。能力清单 API（/api/capabilities）由后台线提供后再加能力地图；先列成员。 */
export function Members() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState('');

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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
