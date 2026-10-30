import { NavLink, Outlet } from 'react-router-dom';
import { Inbox, LogOut, KeyRound, Library, Map, Monitor, Settings, Wrench } from 'lucide-react';
import { Brand, QuotaRing } from './brand';
import { Button } from './ui/button';
import { logout } from '@/lib/api';
import { cn } from '@/lib/utils';

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

export function Layout() {
  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only">
        跳到正文
      </a>
      <aside className="border-b border-[var(--border)] md:sticky md:top-0 md:h-dvh md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex min-h-14 items-center justify-between px-4">
          <Brand />
          <div className="flex items-center gap-1">
            {/* 额度：后台线提供 /api/usage 前显示为空圆环（不编造数字） */}
            <QuotaRing />
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
