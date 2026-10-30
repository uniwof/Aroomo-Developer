import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Inbox, LogOut, KeyRound, Library, Map, Monitor, Settings, Wrench } from 'lucide-react';
import { Brand, QuotaRing } from './brand';
import { Button } from './ui/button';
import { api, logout } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useUsage, worstRow } from '@/lib/usage';

/** D195 控制台页面 */
export const NAV = [
  { to: '/members', label: '能力地图与成员', icon: Map },
  { to: '/tools', label: '工具', icon: Wrench },
  { to: '/library', label: '资源库', icon: Library },
  { to: '/inbox', label: '收件箱', icon: Inbox },
  { to: '/executors', label: '本机执行员', icon: Monitor },
  { to: '/keys', label: 'Key 与接入', icon: KeyRound },
  { to: '/settings', label: '设置', icon: Settings },
] as const;

/** 收件箱未处理数（/api/inbox/unread-count），每 60 秒刷新；查不到就不显示，不编造 */
function useInboxCount(): number {
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

export function Layout() {
  const inboxCount = useInboxCount();
  const worst = worstRow(useUsage().rows);
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only">
        跳到正文
      </a>
      <aside className="border-b border-[var(--border)] md:sticky md:top-0 md:h-dvh md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex min-h-14 items-center justify-between px-4">
          <Brand />
          <div className="flex items-center gap-1">
            {/* 额度圆环（D7）：取上限已填的成员里最满的一位；都没填上限=空圆环 */}
            <QuotaRing used={worst?.quota.used} limit={worst?.quota.limit} />
            <Button variant="ghost" aria-label="退出登录" onClick={() => void logout()}>
              <LogOut className="size-5" aria-hidden="true" />
              <span className="sr-only md:not-sr-only">退出</span>
            </Button>
          </div>
        </div>
        <nav aria-label="控制台" className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex min-h-11 shrink-0 items-center gap-3 rounded-xl px-3 whitespace-nowrap hover:bg-[var(--card)]',
                  isActive && 'bg-[var(--card)] font-semibold',
                )
              }
            >
              <Icon className="size-5" aria-hidden="true" />
              {label}
              {to === '/inbox' && inboxCount > 0 && (
                <span className="ml-auto min-w-6 rounded-full bg-[var(--fg)] px-2 text-center text-[14px] text-[var(--bg)]">
                  {inboxCount}
                  <span className="sr-only"> 条待处理</span>
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 p-4 md:p-8">
        <Outlet />
      </main>
    </div>
  );
}
