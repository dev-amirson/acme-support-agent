'use client';

import { useEffect, useRef } from 'react';
import { Headphones, Ticket, UserCheck } from 'lucide-react';
import type { ContractStatus } from '@acme/contracts';
import { useApp } from '@/lib/store';
import { Badge, type BadgeProps } from '../ui/badge';
import { VoicePanel } from '../voice/VoicePanel';
import { Composer } from './Composer';
import { EmptyState } from './EmptyState';
import { MessageView } from './MessageView';

const CONTRACT_BADGE: Record<ContractStatus, BadgeProps['variant']> = {
  active: 'success',
  past_due: 'warning',
  cancelled: 'secondary',
  expired: 'destructive',
};

function ContextBar() {
  const customer = useApp((s) => s.conversation.customer);
  const escalation = useApp((s) => s.conversation.escalation);
  if (!customer && !escalation) return null;
  return (
    <div className="border-b border-border-subtle bg-white">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-4 py-2 text-sm">
        {customer ? (
          <>
            <UserCheck className="size-4 text-success" />
            <span className="font-bold">{customer.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{customer.id}</span>
            <Badge className="capitalize">{customer.tier}</Badge>
            <span className="text-xs text-muted-foreground">{customer.plan}</span>
            <Badge variant={CONTRACT_BADGE[customer.contractStatus]}>contract {customer.contractStatus.replace('_', ' ')}</Badge>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Customer not verified</span>
        )}
        {escalation && (
          <Badge variant="warning" className="ml-auto">
            <Ticket />
            Human handoff · {escalation.id} · {escalation.queue} · reply within {escalation.slaHours}h
          </Badge>
        )}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const messages = useApp((s) => s.conversation.messages);
  const voiceStatus = useApp((s) => s.voice.status);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Auto-scroll only while the reader is at (or near) the bottom.
  const lastText = messages.at(-1)?.text.length ?? 0;
  const lastSteps = messages.at(-1)?.steps.length ?? 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, lastText, lastSteps]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextBar />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="scrollbar-thin min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
          {messages.length === 0 ? <EmptyState /> : messages.map((m) => <MessageView key={m.key} message={m} />)}
        </div>
      </div>
      <div className="border-t border-border-subtle bg-background">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          {voiceStatus === 'off' ? <Composer /> : <VoicePanel />}
          <p className="mt-2 flex items-center justify-center gap-1 text-center text-[11px] text-muted-foreground">
            {voiceStatus === 'off' ? (
              <>Answers are grounded in Acme policies and verified before they&apos;re shown. A human is one ask away.</>
            ) : (
              <>
                <Headphones className="size-3" /> Headphones give the best interruption handling. Just start talking to cut in.
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
