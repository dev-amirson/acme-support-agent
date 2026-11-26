import * as React from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Kind = 'info' | 'success' | 'warning' | 'error';

const KIND: Record<Kind, { box: string; text: string; icon: LucideIcon }> = {
  info: { box: 'bg-[rgba(2,136,209,0.06)] border-info', text: 'text-info', icon: Info },
  success: { box: 'bg-[rgba(127,161,27,0.06)] border-success', text: 'text-success', icon: CircleCheck },
  warning: { box: 'bg-[rgba(237,108,2,0.06)] border-warning', text: 'text-warning', icon: TriangleAlert },
  error: { box: 'bg-[rgba(211,47,47,0.06)] border-danger', text: 'text-danger', icon: CircleAlert },
};

/** Proof8 StatusMessage: left-ruled notice with an uppercase title. */
export function StatusMessage({
  type = 'info',
  title,
  children,
  action,
  className,
}: {
  type?: Kind;
  title?: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  const k = KIND[type];
  const Icon = k.icon;
  return (
    <div className={cn('flex gap-2.5 rounded-control border border-l-4 p-3', k.box, className)}>
      <Icon className={cn('mt-px size-4 shrink-0', k.text)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {title && <span className={cn('text-[11px] font-bold uppercase tracking-wider', k.text)}>{title}</span>}
        {children && <div className="text-sm text-foreground">{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
