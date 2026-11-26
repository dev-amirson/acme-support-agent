'use client';

import { ArrowRight, BookOpen, Receipt, ShieldAlert, Ticket } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Card } from '../ui/card';

const SCENARIOS = [
  {
    icon: Receipt,
    title: 'Refund a duplicate charge',
    text: 'I was charged twice this month. My account is AC-1001 and my ZIP is 94107 — can you refund the duplicate?',
    flow: 'verify → billing → refund',
  },
  {
    icon: Ticket,
    title: 'Refund above the agent limit',
    text: "I'm Frank, account AC-1006, ZIP 98101. I bought the annual plan by mistake — please refund it.",
    flow: 'policy engine → escalation',
  },
  {
    icon: BookOpen,
    title: 'Plan-specific policy question',
    text: 'Account AC-1003, ZIP 60601. How do I set up SCIM provisioning, and what are our API rate limits?',
    flow: 'enterprise-only docs',
  },
  {
    icon: ShieldAlert,
    title: "Something our policies don't cover",
    text: 'Do you offer a student discount?',
    flow: 'low confidence → human',
  },
];

export function EmptyState() {
  const send = useApp((s) => s.send);
  return (
    <div className="pt-6">
      <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">How can we help today?</h1>
      <p className="mt-2 max-w-xl text-base text-muted-foreground">
        Ask about billing, refunds, your plan or troubleshooting — type, or tap the mic to talk. Every step the agent takes is shown as it happens.
      </p>
      <div className="mt-6 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Try a scenario</div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {SCENARIOS.map((s) => (
          <Card
            key={s.title}
            role="button"
            tabIndex={0}
            onClick={() => void send(s.text)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && void send(s.text)}
            className="group cursor-pointer p-[var(--density-section-padding)] transition-colors hover:border-border-strong hover:bg-field-hover"
          >
            <div className="flex items-center gap-2 text-[15px] font-bold">
              <s.icon className="size-4 text-brand-hover" />
              {s.title}
              <ArrowRight className="ml-auto size-4 text-disabled transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">{s.text}</p>
            <div className="mt-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-disabled">{s.flow}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
