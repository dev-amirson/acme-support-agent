'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { Button } from '../ui/button';
import { SelectField } from '../ui/select';
import { FailureLab } from './FailureLab';
import { OverviewTab } from './OverviewTab';
import { PromptsTab } from './PromptsTab';
import { RetrievalTab } from './RetrievalTab';
import { TraceTab } from './TraceTab';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'trace', label: 'Trace' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'retrieval', label: 'Guardrails' },
  { id: 'chaos', label: 'Failure lab' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function ObservabilityDrawer() {
  const [tab, setTab] = useState<TabId>('overview');
  const toggleDrawer = useApp((s) => s.toggleDrawer);
  const turnOrder = useApp((s) => s.conversation.turnOrder);
  const turns = useApp((s) => s.conversation.turns);
  const selected = useApp((s) => s.selectedTurnId);
  const selectTurn = useApp((s) => s.selectTurn);
  const turnId = selected && turns[selected] ? selected : (turnOrder.at(-1) ?? null);
  const turn = turnId ? turns[turnId] : undefined;

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2.5 border-b border-border-subtle bg-background px-3 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <div>
            <div className="text-[15px] font-bold leading-tight">Observability</div>
            <div className="text-[11px] text-muted-foreground">Traces, prompts, latency, tokens and cost — live</div>
          </div>
          <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => toggleDrawer(false)} aria-label="Close">
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <Button key={t.id} variant={tab === t.id ? 'navActive' : 'nav'} size="sm" className="h-8" onClick={() => setTab(t.id)}>
              {t.label}
            </Button>
          ))}
        </div>
        {tab !== 'chaos' && (
          <SelectField
            label="Turn"
            value={turnId ?? ''}
            onValueChange={(v) => selectTurn(v || null)}
            placeholder="No turns yet"
            disabled={!turnOrder.length}
            options={[...turnOrder].reverse().flatMap((id, i) => {
              const t = turns[id];
              return t
                ? [{ value: id, label: `#${turnOrder.length - i} · ${t.mode === 'voice' ? 'voice · ' : ''}${t.userText.slice(0, 54)}${t.userText.length > 54 ? '…' : ''}` }]
                : [];
            })}
          />
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {tab === 'overview' && <OverviewTab turn={turn} />}
        {tab === 'trace' && <TraceTab turn={turn} />}
        {tab === 'prompts' && <PromptsTab turn={turn} />}
        {tab === 'retrieval' && <RetrievalTab turn={turn} />}
        {tab === 'chaos' && <FailureLab />}
      </div>
    </div>
  );
}
