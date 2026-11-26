'use client';

import { useState } from 'react';
import type { TraceSpan } from '@acme/contracts';
import type { TurnView } from '@/lib/conversation';
import { fmtMs, fmtUsd } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SectionCard } from '../ui/card';
import { Empty, Json, KIND_COLOR } from './shared';

/** Waterfall of every span in the turn on a shared timeline. */
export function TraceTab({ turn }: { turn: TurnView | undefined }) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!turn?.spans.length) return <Empty>No trace yet for this turn.</Empty>;

  const spans = [...turn.spans].sort((a, b) => a.startedAt - b.startedAt);
  const t0 = Math.min(...spans.map((s) => s.startedAt));
  const end = Math.max(...spans.map((s) => s.endedAt ?? Date.now()), t0 + 1);
  const total = end - t0;
  const depth = (s: TraceSpan): number => {
    let d = 0;
    let p = s.parentId;
    while (p && d < 4) {
      p = spans.find((x) => x.id === p)?.parentId ?? null;
      d++;
    }
    return d;
  };
  const current = spans.find((s) => s.id === selected);

  return (
    <>
      <SectionCard title="Span waterfall" description={`${spans.length} spans · ${fmtMs(total)} · click a span to inspect`} actions={<Legend />}>
        <ul className="-mx-1 space-y-0.5">
          {spans.map((s) => {
            const left = ((s.startedAt - t0) / total) * 100;
            const width = Math.max(0.8, (((s.endedAt ?? Date.now()) - s.startedAt) / total) * 100);
            return (
              <li key={s.id}>
                <button
                  onClick={() => setSelected(s.id === selected ? null : s.id)}
                  className={cn('grid w-full grid-cols-[136px_1fr_44px] items-center gap-2 rounded-compact px-1 py-1 text-left text-xs hover:bg-surface-muted', s.id === selected && 'bg-brand-soft')}
                >
                  <span className="truncate" style={{ paddingLeft: depth(s) * 8 }}>
                    <span className={cn('mr-1.5 inline-block size-2 rounded-full align-middle', KIND_COLOR[s.kind])} />
                    <span className={cn(s.status === 'error' && 'font-bold text-danger')}>{s.name}</span>
                  </span>
                  <span className="relative h-2.5 rounded-full bg-surface-muted ring-1 ring-border-subtle">
                    <span
                      className={cn('absolute inset-y-0 rounded-full', KIND_COLOR[s.kind], s.status === 'running' && 'animate-pulse-soft', s.status === 'error' && 'ring-2 ring-danger')}
                      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                    />
                  </span>
                  <span className="text-right font-mono text-[11px] text-muted-foreground">{fmtMs(s.durationMs)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </SectionCard>
      {current && (
        <SectionCard
          title={`${current.kind} · ${current.name}`}
          status={current.status === 'error' ? 'error' : 'default'}
          actions={current.usage ? <span className="font-mono text-xs font-bold">{fmtUsd(current.usage.costUsd)}</span> : undefined}
        >
          {current.error && <p className="mb-2 text-sm text-danger">{current.error}</p>}
          <Json value={{ attributes: current.attributes, usage: current.usage }} />
        </SectionCard>
      )}
    </>
  );
}

function Legend() {
  return (
    <span className="hidden flex-wrap gap-x-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground sm:flex">
      {(['llm', 'tool', 'retrieval', 'guardrail'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1">
          <span className={cn('size-2 rounded-full', KIND_COLOR[k])} />
          {k}
        </span>
      ))}
    </span>
  );
}
