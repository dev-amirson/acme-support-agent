'use client';

import type { UsageKind } from '@acme/contracts';
import type { TurnView } from '@/lib/conversation';
import { useApp } from '@/lib/store';
import { fmtMs, fmtTokens, fmtUsd } from '@/lib/format';
import { Badge } from '../ui/badge';
import { SectionCard } from '../ui/card';
import { SummaryGroup, SummaryRow } from '../ui/summary';
import { Empty } from './shared';

const KIND_LABEL: Record<UsageKind, string> = { llm: 'Reasoning (LLM)', embedding: 'Embeddings', stt: 'Speech-to-text', tts: 'Text-to-speech' };

export function OverviewTab({ turn }: { turn: TurnView | undefined }) {
  const totals = useApp((s) => s.totals);
  const turns = useApp((s) => s.conversation.turns);
  const order = useApp((s) => s.conversation.turnOrder);
  const config = useApp((s) => s.config);
  const recent = order.slice(-10).map((id) => turns[id]).filter((t): t is TurnView => Boolean(t?.metrics));
  const maxLatency = Math.max(1, ...recent.map((t) => t.metrics!.e2eLatencyMs));
  const m = turn?.metrics;

  const usageByKind = new Map<UsageKind, number>();
  for (const s of turn?.spans ?? []) if (s.usage) usageByKind.set(s.usage.kind, (usageByKind.get(s.usage.kind) ?? 0) + s.usage.costUsd);

  return (
    <>
      <SectionCard title="Summary" description="Costs are estimates from list prices; the provider invoice is authoritative.">
        <SummaryGroup label="Session">
          <SummaryRow label="Estimated cost" value={fmtUsd(totals.costUsd)} />
          <SummaryRow label="Tokens in / out" value={`${fmtTokens(totals.inputTokens)} / ${fmtTokens(totals.outputTokens)}`} />
          <SummaryRow label="Turns" value={totals.turns} />
        </SummaryGroup>

        {!turn ? (
          <Empty>Send a message to see latency, token and cost metrics.</Empty>
        ) : (
          <>
            <SummaryGroup label="Selected turn">
              <SummaryRow label="Status" value={<Badge variant={turn.status === 'ok' ? 'success' : turn.status === 'escalated' ? 'warning' : turn.status === 'running' ? 'secondary' : 'destructive'}>{turn.status}</Badge>} />
              <SummaryRow label="End-to-end latency" value={fmtMs(m?.e2eLatencyMs)} hint="Turn start → turn persisted" />
              <SummaryRow label="Time to first token" value={fmtMs(m?.ttftMs)} hint="Turn start → first streamed answer token" />
              <SummaryRow label="Voice latency" value={fmtMs(m?.timeToFirstAudioMs)} hint="End of customer speech → first audio of the reply" />
              <SummaryRow label="LLM calls / tool calls" value={`${m?.llmCalls ?? '—'} / ${m?.toolCalls ?? '—'}`} />
              <SummaryRow label="Input tokens (cached)" value={`${fmtTokens(m?.inputTokens)} (${fmtTokens(m?.cachedInputTokens)})`} hint="Prompt-cache hits are billed at a discount" />
              <SummaryRow label="Output tokens" value={fmtTokens(m?.outputTokens)} />
              <SummaryRow label="Estimated cost" value={fmtUsd(m?.costUsd)} />
            </SummaryGroup>

            {usageByKind.size > 0 && (
              <SummaryGroup label="Cost breakdown">
                {[...usageByKind.entries()].map(([kind, cost]) => (
                  <SummaryRow key={kind} label={KIND_LABEL[kind]} value={fmtUsd(cost)} />
                ))}
              </SummaryGroup>
            )}
          </>
        )}
      </SectionCard>

      {recent.length > 1 && (
        <SectionCard title="Latency history" description="Bar = end-to-end · black mark = first token">
          <ul className="space-y-1.5">
            {recent.map((t) => (
              <li key={t.turnId} className="flex items-center gap-2 text-xs">
                <span className="w-28 truncate text-muted-foreground">
                  {t.mode === 'voice' ? 'voice · ' : ''}
                  {t.userText}
                </span>
                <span className="relative h-2.5 flex-1 rounded-full bg-surface-muted ring-1 ring-border-subtle">
                  <span className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${(t.metrics!.e2eLatencyMs / maxLatency) * 100}%` }} />
                  {t.metrics!.ttftMs !== null && <span className="absolute inset-y-[-2px] w-0.5 bg-foreground" style={{ left: `${(t.metrics!.ttftMs / maxLatency) * 100}%` }} />}
                </span>
                <span className="w-12 text-right font-mono font-bold">{fmtMs(t.metrics!.e2eLatencyMs)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {config && (
        <SectionCard title="Models">
          <SummaryGroup label="OpenAI">
            <SummaryRow label="Chat" value={<span className="font-mono text-xs">{config.models.chat}</span>} />
            <SummaryRow label="Embeddings" value={<span className="font-mono text-xs">{config.models.embedding}</span>} />
            <SummaryRow label="Speech-to-text" value={<span className="font-mono text-xs">{config.models.transcription}</span>} />
            <SummaryRow label="Text-to-speech" value={<span className="font-mono text-xs">{config.models.tts}</span>} />
          </SummaryGroup>
        </SectionCard>
      )}
    </>
  );
}
