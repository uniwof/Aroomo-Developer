// shadcn/ui Input（MIT）
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      'min-h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 text-[14px] placeholder:text-[var(--muted)]',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
