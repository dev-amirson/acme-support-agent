'use client';

import { useState } from 'react';
import {
  Ban,
  BookOpen,
  ChevronRight,
  CircleCheck,
  CircleX,
  LoaderCircle,
  Receipt,
  Search,
  ShieldCheck,
  Sparkles,
  Ticket,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { StepRecord } from '@acme/contracts';
import { fmtMs } from '@/lib/format';
import { cn } from '@/lib/utils';

const TOOL_ICONS: Record<string, LucideIcon> = {
  verify_customer_identity: UserCheck,
  search_knowledge_base: Search,
  get_billing_history: Receipt,
  issue_refund: Receipt,
  update_account_settings: Wrench,
  create_escalation_ticket: Ticket,
};

function iconFor(step: StepRecord): LucideIcon {
  if (step.kind === 'llm') return Sparkles;
  if (step.kind === 'guardrail') return ShieldCheck;
  return TOOL_ICONS[step.name] ?? BookOpen;
}

function StatusIcon({ status }: { status: StepRecord['status'] }) {
  if (status === 'running') return <LoaderCircle className="size-3.5 animate-spin text-brand-hover" />;
  if (status === 'ok') return <CircleCheck className="size-3.5 text-success" />;
  if (status === 'skipped') return <Ban className="size-3.5 text-disabled" />;
  return <CircleX className="size-3.5 text-danger" />;
}

/**
 * Live view of the agent's reasoning loop: every model call, tool call and guardrail check as it
 * happens. Expanded while the turn runs; collapses to a one-line summary when it's done.
 */
export function StepTimeline({ steps, live }: { steps: StepRecord[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  const expanded = live || open;
  const tools = steps.filter((s) => s.kind === 'tool').length;
  const total = steps.reduce((ms, s) => ms + (s.durationMs ?? 0), 0);
  const recovered = steps.some((s) => s.status === 'error');

  return (
    <div className="mb-2">
      {!live && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-compact py-0.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
        >
          <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
          {steps.length} steps · {tools} tool call{tools === 1 ? '' : 's'} · {fmtMs(total)}
          {recovered && <span className="text-warning">· recovered</span>}
        </button>
      )}
      {expanded && (
        <ol className={cn('relative space-y-1.5 border-l border-border-subtle pl-4', !live && 'mt-1.5')}>
          {steps.map((s) => {
            const Icon = iconFor(s);
            const lastProgress = s.progress?.at(-1);
            return (
              <li key={s.stepId} className="relative animate-fade-in text-[13px]">
                <span className="absolute -left-[23px] top-0.5 flex size-3.5 items-center justify-center rounded-full bg-background">
                  <StatusIcon status={s.status} />
                </span>
                <div className="flex items-start gap-1.5">
                  <Icon className={cn('mt-0.5 size-3.5 shrink-0', s.kind === 'guardrail' ? 'text-success' : s.kind === 'llm' ? 'text-brand-hover' : 'text-muted-foreground')} />
                  <div className="min-w-0">
                    <span className={cn(s.status === 'running' ? 'font-bold text-foreground' : 'text-foreground/80')}>
                      {s.status === 'running' ? s.label : (s.summary ?? s.label)}
                    </span>
                    {s.durationMs !== undefined && s.status !== 'running' && <span className="ml-1.5 font-mono text-[11px] text-disabled">{fmtMs(s.durationMs)}</span>}
                    {s.status === 'running' && lastProgress && <div className="animate-pulse-soft text-xs text-muted-foreground">{lastProgress}</div>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
