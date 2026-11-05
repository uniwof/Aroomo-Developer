// shadcn/ui Input（MIT）；外观由 index.css 全站输入框规则统一（照 sumus）
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn('w-full', className)}
    {...props}
  />
));
Input.displayName = 'Input';
