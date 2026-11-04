/** 工具页：算力、沙盒、云手机等（取自 /api/capabilities 的 tools，按分组显示；额度查不到显示「未知」）。 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { ACCESS_LABEL, quotaText, type CapabilityAccess } from '@/lib/capabilities';
import { QuotaRing } from '@/components/brand';

export interface ToolItem {
  id: string;
  name: string;
  group: string;
  access: CapabilityAccess;
  status: string;
  quota: { used: number | null; limit: number | null; unit: string } | null;
  note: string | null;
}

export const STATUS_LABEL: Record<string, string> = {
  ready: '可用',
  unverified: '未验证',
  failed: '验证失败',
  missing: '未填 Key',
  keyless: '免 Key',
};

export function groupTools(tools: ToolItem[]): [string, ToolItem[]][] {
  const m = new Map<string, ToolItem[]>();
  for (const t of tools) m.set(t.group, [...(m.get(t.group) ?? []), t]);
  return [...m.entries()];
}

export function Tools() {
  const [tools, setTools] = useState<ToolItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api<{ tools?: ToolItem[] }>('GET', '/api/capabilities')
      .then((r) => alive && setTools(r.tools ?? []))
      .catch(() => alive && setError('加载失败，请稍后再试'));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">工具</h1>
      {error && <p role="alert">{error}</p>}
      {!error && !tools && <p className="text-[var(--muted)]">正在加载…</p>}
      {tools?.length === 0 && <p className="text-[var(--muted)]">还没有工具。</p>}
      {tools &&
        groupTools(tools).map(([g, rows]) => (
          <section key={g} aria-label={g} className="space-y-2">
            <h2 className="font-semibold">
              {g}（{rows.length}）
            </h2>
            <ul className="divide-y divide-[var(--border)] rounded-2xl bg-[var(--card)]">
              {rows.map((t) => (
                <li key={t.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                  <QuotaRing used={t.quota?.used} limit={t.quota?.limit} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{t.name}</div>
                    <div className="text-[var(--muted)]">
                      {STATUS_LABEL[t.status] ?? t.status} · {quotaText(t.quota)}
                    </div>
                    {t.note && <div className="text-[var(--muted)]">{t.note}</div>}
                  </div>
                  <span className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-[14px]">{ACCESS_LABEL[t.access]}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
