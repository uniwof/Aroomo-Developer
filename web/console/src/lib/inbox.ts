import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** 收件箱处理完一条后发这个事件，铃铛马上重查（不等一分钟；审计 I5） */
export const INBOX_CHANGED = 'aroomo:inbox-changed';
export const inboxChanged = () => window.dispatchEvent(new Event(INBOX_CHANGED));

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
    const on = () => void load();
    window.addEventListener(INBOX_CHANGED, on);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(INBOX_CHANGED, on);
    };
  }, []);
  return n;
}
