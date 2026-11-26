import type { Confidence, ConfidenceBand, GroundingReport } from '@acme/contracts';
import type { ConfidenceThresholds } from '../rag/confidence';
import type { TurnState } from './turn-state';

const band = (score: number, t: Pick<ConfidenceThresholds, 'high' | 'low'>): ConfidenceBand =>
  score >= t.high ? 'high' : score >= t.low ? 'medium' : 'low';

/**
 * The confidence chip on each assistant message. It reflects *what the answer was grounded in*:
 *   - knowledge-base answers inherit the best retrieval confidence (incl. verifier verdict);
 *   - account-data answers are grounded in system-of-record tool output;
 *   - either is penalised if the post-generation grounding check finds unsupported specifics.
 * Pure conversational turns (greetings, clarifying questions) get no chip, unless they contain
 * unsupported specifics — which is exactly the hallucination case.
 */
export function scoreAnswer(turn: TurnState, grounding: GroundingReport, t: ConfidenceThresholds): Confidence | null {
  const best = turn.bestRetrieval;
  const usedData = turn.toolEvidence.length > 0;
  let base: Confidence | null = null;

  if (best) {
    base = { ...best.confidence, signals: [...best.confidence.signals] };
  } else if (usedData) {
    const degraded = turn.failedTools.size > 0;
    base = {
      score: degraded ? 0.5 : 0.92,
      band: degraded ? 'medium' : 'high',
      signals: [{ name: 'system_of_record', value: degraded ? 0.5 : 1, detail: degraded ? `tool failure: ${[...turn.failedTools].join(', ')}` : 'verified tool output' }],
      rationale: degraded ? 'Some internal systems were unavailable while answering.' : 'Answer based on verified account data from internal systems.',
    };
  }

  if (grounding.checkedClaims === 0 && grounding.invalidCitations.length === 0) return base;

  const groundingSignal = { name: 'grounding_check', value: grounding.passed ? 1 : 0, detail: grounding.passed ? `${grounding.checkedClaims} specific claim(s) verified against evidence` : `unsupported: ${[...grounding.unsupportedClaims, ...grounding.invalidCitations.map((i) => `[${i}]`)].join(', ')}` };

  if (!base) {
    // Specifics stated without consulting any tool → by definition ungrounded.
    return grounding.passed
      ? null
      : { score: 0.2, band: 'low', signals: [groundingSignal], rationale: 'The answer states specifics that were not checked against any source.' };
  }
  if (grounding.passed) return { ...base, signals: [...base.signals, groundingSignal] };
  const score = Math.round(base.score * 0.5 * 1000) / 1000;
  return {
    score,
    band: band(score, t),
    signals: [...base.signals, groundingSignal],
    rationale: `${base.rationale} Grounding check flagged details not found in the sources.`,
  };
}
