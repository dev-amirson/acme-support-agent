import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Proof8 select: a floating-label field surface (uppercase label inside the box) with a Radix menu.
 */
export function SelectField({
  label,
  value,
  onValueChange,
  placeholder,
  options,
  disabled,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  options: Array<{ value: string; label: React.ReactNode }>;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <div className={cn('field-shell__surface', className)} data-disabled={disabled ? 'true' : 'false'}>
        <span className="field-shell__label">{label}</span>
        <SelectPrimitive.Trigger className="relative flex w-full min-w-0 items-center pr-6 text-left text-[length:var(--value-font-size)] focus:outline-none focus-visible:shadow-none data-[placeholder]:text-disabled [&>span]:truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
          <SelectPrimitive.Icon asChild>
            <ChevronDown className="absolute right-0 top-1/2 size-[var(--icon-size)] -translate-y-1/2 text-muted-foreground" />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
      </div>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-control border border-border-subtle bg-white shadow-md"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((o) => (
              <SelectPrimitive.Item
                key={o.value}
                value={o.value}
                className="relative flex h-9 cursor-default select-none items-center rounded-compact py-1.5 pl-8 pr-2 text-sm outline-none data-[highlighted]:bg-surface-muted data-[state=checked]:font-bold"
              >
                <span className="absolute left-2 flex size-4 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check className="size-4 text-brand-hover" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
