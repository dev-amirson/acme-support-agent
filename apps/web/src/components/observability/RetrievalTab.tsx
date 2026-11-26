'use client';

import type { Confidence, GroundingReport } from '@acme/contracts';
import type { TurnView } from '@/lib/conversation';
import { useApp } from '@/lib/store';
import { cn } from '@/lib/utils';
import { Badge, type BadgeProps } from '../ui/badge';
import { SectionCard } from '../ui/card';
import { StatusMessage } from '../ui/status-message';
import { SummaryGroup, SummaryRow } from '../ui/summary';
import { Empty } from './shared';

interface Candidate {
  chunk: string;
  section: string;
  similarity: number;
  vectorRank: number | null;
  lexicalRank: number | null;
}

const BAND: Record<Confidence['band'], { badge: BadgeProps['variant']; card: 'success' | 'warning' | 'error' }> = {
  high: { badge: 'success', card: 'success' },
  medium: { badge: 'warning', card: 'warning' },
  low: { badge: 'destructive', card: 'error' },
};

/**
 * The guardrail pipeline for a turn, in order: hybrid retrieval vs. thresholds → answerability
 * judge → confidence gate → post-generation grounding check.
 */
export function RetrievalTab({ turn }: { turn: TurnView | undefined }) {
  const guardrails = useApp((s) => s.config?.guardrails);
  const spans = turn?.spans ?? [];
  const searches = spans.filter((s) => s.kind === 'retrieval');
  const judges = spans.filter((s) => s.name === 'answerability_judge');
  const gate = spans.find((s) => s.name === 'confidence_gate' || s.name === 'mandatory_escalation');
  const grounding = spans.find((s) => s.name === 'grounding_check');

  if (!turn) return <Empty>No turn selected.</Empty>;

  return (
    <>
      {!searches.length && (
        <StatusMessage type="info" title="No retrieval" className="bg-white">
          This turn used account tools or conversation context only.
        </StatusMessage>
      )}

      {searches.map((span, i) => {
        const conf = span.attributes.confidence as Confidence | undefined;
        const candidates = (span.attributes.candidates as Candidate[] | undefined) ?? [];
        return (
          <SectionCard
            key={span.id}
            title={`1 · Retrieval${searches.length > 1 ? ` #${i + 1}` : ''}`}
            description={`Scope: ${String(span.attributes.tier ?? '')}`}
            status={conf ? BAND[conf.band].card : 'default'}
            actions={conf && <Badge variant={BAND[conf.band].badge}>{conf.band} · {conf.score.toFixed(2)}</Badge>}
          >
            {conf && (
              <>
                <p className="mb-2 text-sm">{conf.rationale}</p>
                <SummaryGroup label="Signals">
                  {conf.signals.map((s) => (
                    <SummaryRow key={s.name} label={s.name} value={<span className="font-mono text-xs">{s.value}</span>} hint={s.detail} />
                  ))}
                </SummaryGroup>
              </>
            )}
            <div className="mb-1 mt-3 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">Candidates (cosine similarity)</div>
            <ul className="space-y-1.5">
              {candidates.map((c) => (
                <li key={c.chunk} className="text-xs">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate" title={c.chunk}>
                      {c.section}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      v{c.vectorRank ?? '–'} · k{c.lexicalRank ?? '–'}
                    </span>
                    <span className="w-10 text-right font-mono font-bold">{c.similarity.toFixed(2)}</span>
                  </div>
                  <div className="relative mt-0.5 h-1.5 rounded-full bg-surface-muted ring-1 ring-border-subtle">
                    <div className="absolute inset-y-0 left-0 rounded-full bg-info" style={{ width: `${Math.max(0, Math.min(1, c.similarity)) * 100}%` }} />
                    {guardrails && <div className="absolute inset-y-[-3px] w-0.5 bg-danger" style={{ left: `${guardrails.minSimilarity * 100}%` }} title={`hard floor ${guardrails.minSimilarity}`} />}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-muted-foreground">
              v = vector rank · k = keyword (full-text) rank · red line = hard floor{guardrails ? ` ${guardrails.minSimilarity}` : ''}
              {guardrails && ` · bands: low < ${guardrails.lowConfidence} ≤ medium < ${guardrails.highConfidence} ≤ high`}
            </p>
          </SectionCard>
        );
      })}

      {judges.map((span) => {
        const verdict = span.attributes.verdict as { inDomain: boolean; answerable: boolean; confidence: number; rationale: string } | undefined;
        return (
          <SectionCard
            key={span.id}
            title="2 · Answerability judge"
            description={String(span.attributes.reason ?? '')}
            status={verdict?.answerable ? 'success' : 'error'}
            actions={verdict && <Badge variant={verdict.answerable ? 'success' : 'destructive'}>{verdict.answerable ? 'answerable' : 'not answerable'}</Badge>}
          >
            {verdict ? (
              <>
                <p className="text-sm">{verdict.rationale}</p>
                <SummaryGroup label="Verdict" className="mt-2">
                  <SummaryRow label="Confidence" value={verdict.confidence.toFixed(2)} />
                  <SummaryRow label="Domain" value={verdict.inDomain ? 'in domain' : 'out of domain'} />
                </SummaryGroup>
              </>
            ) : (
              <p className="text-sm text-danger">{span.error ?? 'No verdict'}</p>
            )}
          </SectionCard>
        );
      })}

      {gate && (
        <StatusMessage type="warning" title="3 · Confidence gate tripped" className="bg-white">
          {String(gate.attributes.decision ?? gate.attributes.reason ?? 'Escalation enforced').replaceAll('_', ' ')} — the model was not allowed to improvise an answer; the orchestrator
          routed the conversation to a human.
        </StatusMessage>
      )}

      {grounding && <GroundingCard report={grounding.attributes.grounding as GroundingReport | undefined} confidence={grounding.attributes.confidence as Confidence | null | undefined} />}
    </>
  );
}

function GroundingCard({ report, confidence }: { report: GroundingReport | undefined; confidence: Confidence | null | undefined }) {
  if (!report) return null;
  return (
    <SectionCard
      title="4 · Grounding check"
      description="Every amount, %, duration and citation in the answer must exist in this turn's evidence"
      status={report.passed ? 'success' : 'warning'}
      actions={<Badge variant={report.passed ? 'success' : 'warning'}>{report.passed ? 'passed' : 'flagged'}</Badge>}
    >
      <p className="text-sm">{report.passed ? `${report.checkedClaims} specific claim(s) found in the evidence.` : 'Some specifics are not supported by the evidence:'}</p>
      {!report.passed && (
        <ul className={cn('mt-1 list-disc pl-5 font-mono text-xs text-warning')}>
          {report.unsupportedClaims.map((c) => (
            <li key={c}>{c}</li>
          ))}
          {report.invalidCitations.map((i) => (
            <li key={i}>citation [{i}] was never retrieved</li>
          ))}
        </ul>
      )}
      {confidence && (
        <SummaryGroup label="Final answer confidence" className="mt-3">
          <SummaryRow label="Score" value={<Badge variant={BAND[confidence.band].badge}>{confidence.band} · {confidence.score.toFixed(2)}</Badge>} />
        </SummaryGroup>
      )}
    </SectionCard>
  );
}
