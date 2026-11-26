import * as React from 'react';
import { cn } from '@/lib/utils';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-card border border-border-subtle bg-white text-foreground', className)} {...props} />
));
Card.displayName = 'Card';

type Status = 'default' | 'warning' | 'error' | 'success' | 'info';

const STATUS_EDGE: Record<Status, string> = {
  default: '',
  warning: 'border-l-[3px] border-l-warning',
  error: 'border-l-[3px] border-l-danger',
  success: 'border-l-[3px] border-l-success',
  info: 'border-l-[3px] border-l-info',
};

const STATUS_HEADER: Record<Status, string> = {
  default: 'bg-surface-header',
  warning: 'bg-[rgba(237,108,2,0.04)]',
  error: 'bg-[rgba(211,47,47,0.04)]',
  success: 'bg-[rgba(127,161,27,0.04)]',
  info: 'bg-[rgba(2,136,209,0.04)]',
};

/** Proof8 SectionCard: tinted header band with title / description / actions, optional footer. */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  status = 'default',
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  status?: Status;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cn('overflow-hidden', STATUS_EDGE[status], className)}>
      <div className={cn('flex items-center justify-between gap-3 border-b border-border-subtle px-[var(--density-section-padding)] py-2.5', STATUS_HEADER[status])}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-[15px] font-bold leading-tight tracking-tight">{title}</h3>
          {description && <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && <div className={cn('p-[var(--density-section-padding)]', contentClassName)}>{children}</div>}
      {footer && <div className="border-t border-border-subtle bg-surface-header px-[var(--density-section-padding)] py-2.5">{footer}</div>}
    </Card>
  );
}
