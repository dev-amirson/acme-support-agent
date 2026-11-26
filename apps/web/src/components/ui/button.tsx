import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/** Proof8 button: uppercase, bold, tracked; lime primary; density-driven heights. */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control text-xs font-bold uppercase tracking-[0.05em] transition-all duration-[160ms] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-brand)] disabled:pointer-events-none disabled:opacity-55 [&_svg]:size-[var(--icon-size)] [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border border-transparent bg-brand text-foreground hover:bg-brand-hover',
        destructive: 'border border-transparent bg-danger text-white hover:opacity-90 focus-visible:shadow-[var(--shadow-focus-danger)]',
        outline: 'border border-border-subtle bg-white text-foreground hover:border-border-strong hover:bg-field-hover',
        secondary: 'border border-transparent bg-surface-muted text-muted-foreground hover:bg-border-subtle',
        ghost: 'border border-transparent text-foreground hover:bg-surface-muted',
        success: 'border border-transparent bg-success text-white hover:opacity-90',
        /** Navigation pill (simple_rhf PlaygroundNav). */
        nav: 'border border-transparent text-[13px] font-medium normal-case tracking-normal text-muted-foreground hover:bg-surface-muted hover:text-foreground',
        navActive: 'border border-transparent bg-brand text-[13px] font-bold normal-case tracking-normal text-foreground hover:bg-brand-hover',
      },
      size: {
        default: 'h-[var(--density-button-height)] px-4',
        sm: 'h-[var(--density-small-button-height)] rounded-compact px-3',
        lg: 'h-12 px-8',
        icon: 'size-[var(--density-icon-button-size)] p-0',
        'icon-sm': 'size-[30px] rounded-compact p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
Button.displayName = 'Button';

export { buttonVariants };
