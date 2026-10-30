import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { ACCESS_LABEL, KIND_LABEL, SAMPLE_ITEMS, quotaText, summaryLine, type CapabilityItem, type CapabilityKind, type CapabilityList } from '@/lib/capabilities';
import { QuotaRing } from './brand';
import { cn } from '@/lib/utils';

const KINDS: CapabilityKind[] = ['text', 'image', 'video'];

/** 能力清单：顶部汇总「文本 N · 生图 N · 视频 N」，每项显示永久免费/试用徽标与额度（查不到显示「未知」）。 */
export function CapabilityMap() {
  const [data, setData] = useState<CapabilityList | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api<{ items: CapabilityItem[] }>('GET', '/api/capabilities')
      .then((r) => alive && setData({ items: r.items ?? [] }))
      .catch((e: unknown) => {
        if (!alive) return;
        // 后台线的接口还没上线：先用示例数据，页面上明示
        if (e instanceof ApiError && (e.status === 404 || e.status === 501)) setData({ items: SAMPLE_ITEMS, sample: true });
        else setError(e instanceof Error ? e.message : '加载失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="text-[var(--muted)]">正在加载能力清单…</p>;

  return (
    <section aria-labelledby="cap-title" className="space-y-3">
      <h2 id="cap-title" className="text-[18px] font-semibold" data-testid="cap-summary">
        {summaryLine(data.items)}
      </h2>
      {data.sample && (
        <p className="text-[var(--muted)]" role="note">
          示例数据：能力清单接口还没接上，下面的数字不是你的真实情况。
        </p>
      )}
      {KINDS.map((k) => {
        const rows = data.items.filter((i) => i.kind === k);
        return (
          <div key={k} className="space-y-2">
            <h3 className="font-semibold">
              {KIND_LABEL[k]}（{rows.length}）
            </h3>
            {rows.length === 0 ? (
              <p className="text-[var(--muted)]">暂无{KIND_LABEL[k]}能力。</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-2xl bg-[var(--card)]">
                {rows.map((i) => (
                  <li key={i.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                    <QuotaRing used={i.quota?.used} limit={i.quota?.limit} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{i.name}</div>
                      <div className="truncate text-[var(--muted)]">
                        {i.provider} · {quotaText(i.quota)}
                        {i.trialEndsAt && ` · 试用到 ${i.trialEndsAt}`}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full border px-3 py-1 text-[14px]',
                        i.access === 'free' ? 'border-[var(--color-brand)] font-medium' : 'border-[var(--border)]',
                      )}
                      data-access={i.access}
                    >
                      {ACCESS_LABEL[i.access]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
