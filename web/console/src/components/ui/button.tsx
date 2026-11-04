// shadcn/ui Button（MIT），按 Aroomo 品牌改色；手机点击区 ≥44px（min-h-11）
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-4 text-[14px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // 珊瑚色只作填充，上面用深色字（对比度规则）
        default: 'bg-brand text-brand-ink hover:brightness-95',
        outline: 'border border-[var(--border)] bg-transparent hover:bg-[var(--card)]',
        ghost: 'bg-transparent hover:bg-[var(--card)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />;
});
Button.displayName = 'Button';
