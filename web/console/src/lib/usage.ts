import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

/** GET /api/usage 的一行（后台线 #145）。上限没填 = quotaKnown:false，圆环不画比例。 */
export interface UsageRow {
  memberId: string;
  name: string;
  today: { requests: number; errors: number; limited: number };
  last7DaysRequests: number;
  quota: { used: number; limit: number | null; unit: string };
  quotaKnown: boolean;
  ratio: number | null;
  state: 'unknown' | 'ok' | 'warn' | 'full' | 'limited';
}

/** 读额度；失败或格式不对就返回 null（显示「未知」，不编造） */
export function useUsage(refreshMs = 60_000): { rows: UsageRow[] | null; reload: () => Promise<void> } {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await api<{ members?: UsageRow[] }>('GET', '/api/usage');
      setRows(Array.isArray(r.members) ? r.members : null);
    } catch {
      setRows(null);
    }
  }, []);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), refreshMs);
    return () => clearInterval(t);
  }, [reload, refreshMs]);
  return { rows, reload };
}

/** 顶栏圆环：取已填上限的成员里用得最满的一位；一位都没填上限 = 空圆环（未知） */
export function worstRow(rows: UsageRow[] | null): UsageRow | null {
  const known = (rows ?? []).filter((r) => r.quotaKnown && r.quota.limit != null);
  if (known.length === 0) return null;
  return known.reduce((a, b) => ((b.ratio ?? 0) > (a.ratio ?? 0) ? b : a));
}
