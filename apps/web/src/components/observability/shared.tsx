'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { SpanKind } from '@acme/contracts';
import { cn } from '@/lib/utils';

/** Span colours, drawn from the Proof8 semantic palette. */
export const KIND_COLOR: Record<SpanKind, string> = {
  turn: 'bg-border-strong',
  llm: 'bg-brand-hover',
  tool: 'bg-warning',
  retrieval: 'bg-info',
  embedding: 'bg-[#7e57c2]',
  guardrail: 'bg-success',
  stt: 'bg-[#c2185b]',
  tts: 'bg-[#00897b]',
};

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

export function Collapsible({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-control border border-border-subtle">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1 bg-surface-header px-2.5 py-1.5 text-left text-xs font-bold">
        <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
        {title}
      </button>
      {open && <div className="border-t border-border-subtle p-2">{children}</div>}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return (
    <pre className="scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-compact bg-surface-muted p-2 font-mono text-[11px] leading-relaxed text-foreground/80">
      {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}
