// shadcn/ui Button（MIT）；外观用全站 .btn（照 sumus：黑色主按钮、细边次按钮），点击区 ≥44px 由 .btn 透明外扩保证
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// #250 统一风格：直接用全站唯一一套按钮类（index.css .btn），不再单独一套 Tailwind 样式
const buttonVariants = cva('btn', {
  variants: {
    variant: {
      default: 'btn-primary',
      outline: 'btn-outline',
      ghost: 'btn-quiet',
      danger: 'btn-outline btn-danger',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />;
});
Button.displayName = 'Button';
