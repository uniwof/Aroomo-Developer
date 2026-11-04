/**
 * 标签页（所有者 2026-11-04：能切换分类的地方用标签页，不做一长页往下滚）。
 * WAI-ARIA tabs：左右方向键 / Home / End 切换，读屏会读出「标签 x / 共 n」；只渲染当前标签页的内容。
 * 不依赖第三方库；控制台页面和对话抽屉共用。
 */
import { useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export interface TabsProps {
  /** 给读屏的分组名，例如「设置分类」 */
  label: string;
  items: TabItem[];
  /** 受控：当前标签 id；不传则自己记 */
  value?: string;
  onChange?: (id: string) => void;
  className?: string;
  /** 标签栏右边的额外内容（例如抽屉的关闭按钮） */
  aside?: ReactNode;
  /** 标签放不下时换行（默认横向滚动）。窄屏抽屉用：所有分类一眼都能看到 */
  wrap?: boolean;
}

export function Tabs({ label, items, value, onChange, className, aside, wrap }: TabsProps) {
  const [own, setOwn] = useState(items[0]?.id ?? '');
  const current = value ?? own;
  const select = (id: string) => {
    if (value === undefined) setOwn(id);
    onChange?.(id);
  };
  const base = useId();
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const go = (i: number) => {
    const t = items[(i + items.length) % items.length]!;
    select(t.id);
    refs.current[t.id]?.focus();
  };
  const idx = Math.max(
    0,
    items.findIndex((t) => t.id === current),
  );
  const active = items[idx];
  return (
    <div className={className}>
      <div className="flex items-center gap-1 border-b border-[var(--border)]">
        <div role="tablist" aria-label={label} className={cn('flex flex-1 gap-1', wrap ? 'flex-wrap' : 'overflow-x-auto')}>
          {items.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${t.id}`}
              aria-selected={i === idx}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={i === idx ? 0 : -1}
              className={cn(
                'min-h-12 shrink-0 whitespace-nowrap border-b-[3px] border-transparent px-3 hover:bg-[var(--card)]',
                i === idx && 'border-[var(--color-brand)] font-semibold',
              )}
              onClick={() => select(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') go(i + 1);
                else if (e.key === 'ArrowLeft') go(i - 1);
                else if (e.key === 'Home') go(0);
                else if (e.key === 'End') go(items.length - 1);
                else return;
                e.preventDefault();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {aside}
      </div>
      {active && (
        <div role="tabpanel" id={`${base}-panel-${active.id}`} aria-labelledby={`${base}-tab-${active.id}`} tabIndex={0} className="pt-4 focus-visible:outline-2">
          {active.content}
        </div>
      )}
    </div>
  );
}
