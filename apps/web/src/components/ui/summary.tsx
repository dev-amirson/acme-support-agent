import * as React from 'react';
import { cn } from '@/lib/utils';

/** Proof8 wizard summary: overline group label + label/value rows with hairline dividers. */
export function SummaryGroup({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mb-4 last:mb-0', className)}>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <dl className="divide-y divide-border-subtle">{children}</dl>
    </div>
  );
}

export function SummaryRow({ label, value, hint, className }: { label: React.ReactNode; value: React.ReactNode; hint?: string; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-1.5 text-sm', className)} title={hint}>
      <dt className="text-foreground/80">{label}</dt>
      <dd className="text-right font-bold tabular-nums">{value}</dd>
    </div>
  );
}
