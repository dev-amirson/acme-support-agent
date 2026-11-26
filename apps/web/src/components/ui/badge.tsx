import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold transition-colors [&_svg]:size-3', {
  variants: {
    variant: {
      default: 'border-transparent bg-brand text-foreground',
      secondary: 'border-transparent bg-surface-muted text-muted-foreground',
      outline: 'border-border-subtle bg-white text-foreground',
      success: 'border-transparent bg-[rgba(127,161,27,0.1)] text-success',
      warning: 'border-transparent bg-[rgba(237,108,2,0.08)] text-warning',
      destructive: 'border-transparent bg-[rgba(211,47,47,0.08)] text-danger',
      info: 'border-transparent bg-[rgba(2,136,209,0.08)] text-info',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
