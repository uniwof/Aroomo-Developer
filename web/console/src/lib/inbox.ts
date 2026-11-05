import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** 铃铛上的未读数（每分钟刷新；查不到就当 0，不显示） */
export function useInboxCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ total: number }>('GET', '/api/inbox/unread-count')
        .then((r) => alive && typeof r.total === 'number' && setN(r.total))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return n;
}
