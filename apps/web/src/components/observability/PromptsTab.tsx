'use client';

import type { TurnView } from '@/lib/conversation';
import { fmtMs, fmtTokens, fmtUsd } from '@/lib/format';
import { SectionCard } from '../ui/card';
import { Collapsible, Empty, Json } from './shared';

interface PromptAttr {
  system?: string;
  historyMessagesOmitted?: number;
  messages?: Array<{ role: string; content: string; toolCalls?: string[] }>;
}

/** Exactly what the model saw and said on every reasoning step of the turn. */
export function PromptsTab({ turn }: { turn: TurnView | undefined }) {
  const calls = (turn?.spans ?? []).filter((s) => s.kind === 'llm');
  if (!calls.length) return <Empty>No model calls in this turn yet.</Empty>;

  return (
    <>
      {calls.map((span, i) => {
        const a = span.attributes as Record<string, unknown>;
        const prompt = a.prompt as PromptAttr | undefined;
        const attempts = (a.attempts as Array<{ model: string; ok: boolean; error?: { code: string; message: string } }> | undefined) ?? [];
        const toolCalls = (a.toolCalls as Array<{ name: string; arguments: string }> | undefined) ?? [];
        const retried = attempts.some((x) => !x.ok);
        return (
          <SectionCard
            key={span.id}
            title={`Step ${i + 1}`}
            status={span.status === 'error' ? 'error' : retried ? 'warning' : 'default'}
            description={<span className="font-mono">{String(a.model ?? '')}</span>}
            actions={
              <span className="text-right font-mono text-[11px] leading-tight text-muted-foreground">
                {fmtMs(span.durationMs)} · {fmtUsd(span.usage?.costUsd)}
                <br />
                {fmtTokens(span.usage?.inputTokens)} in / {fmtTokens(span.usage?.outputTokens)} out
              </span>
            }
            contentClassName="space-y-1.5"
          >
            {retried && (
              <ul className="space-y-0.5">
                {attempts.map((x, j) => (
                  <li key={j} className={x.ok ? 'text-xs text-success' : 'text-xs text-warning'}>
                    attempt {j + 1} · {x.model} · {x.ok ? 'ok' : `${x.error?.code}: ${x.error?.message}`}
                  </li>
                ))}
              </ul>
            )}
            {prompt?.system && (
              <Collapsible title="System prompt">
                <Json value={prompt.system} />
              </Collapsible>
            )}
            {prompt?.messages && (
              <Collapsible title={`Messages (${prompt.messages.length}${prompt.historyMessagesOmitted ? ` + ${prompt.historyMessagesOmitted} earlier` : ''})`}>
                <ul className="space-y-1.5">
                  {prompt.messages.map((m, k) => (
                    <li key={k} className="text-xs">
                      <span className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">{m.role}</span>
                      <p className="whitespace-pre-wrap break-words">{m.content || (m.toolCalls ? m.toolCalls.join('\n') : '∅')}</p>
                    </li>
                  ))}
                </ul>
              </Collapsible>
            )}
            {toolCalls.length > 0 && (
              <Collapsible title={`Tool calls → ${toolCalls.map((t) => t.name).join(', ')}`} defaultOpen>
                <Json value={toolCalls.map((t) => ({ name: t.name, arguments: safeJson(t.arguments) }))} />
              </Collapsible>
            )}
            {typeof a.response === 'string' && a.response && (
              <Collapsible title="Response" defaultOpen={!toolCalls.length}>
                <Json value={a.response} />
              </Collapsible>
            )}
          </SectionCard>
        );
      })}
    </>
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
