import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(
  ({ className, ...props }, ref) => (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'peer inline-flex h-6 w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-border transition-all duration-[160ms] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-brand)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=unchecked]:bg-[#DADAD5]',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-[18px] rounded-full border border-border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-transform data-[state=checked]:translate-x-[14px] data-[state=unchecked]:translate-x-[2px]" />
    </SwitchPrimitive.Root>
  ),
);
Switch.displayName = 'Switch';
