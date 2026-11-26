import type { Confidence, ConfidenceBand, ConfidenceSignal } from '@acme/contracts';
import type { SearchHit } from './kb-repository';

export interface ConfidenceThresholds {
  /** Below this top-1 cosine similarity nothing is trusted, whatever else agrees. */
  minSimilarity: number;
  /** Similarity at which the similarity signal saturates to 1.0. */
  similarityCeiling: number;
  high: number;
  low: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Retrieval confidence = calibrated dense similarity, nudged by lexical agreement.
 *
 *   s_sim  = clamp((top1_cos − min) / (ceiling − min))         dense relevance, 0..1
 *   s_lex  = 1 if the top fused hit also matched full-text      exact terminology agrees
 *   s_marg = clamp((top1 − top2_other_doc) / 0.10)             one doc clearly wins (less ambiguity)
 *   score  = 0.75·s_sim + 0.15·s_lex + 0.10·s_marg
 *
 * Cosine similarities are not probabilities and their scale is model-specific, which is why the
 * floor/ceiling are config and are calibrated with `npm run eval:retrieval` (see README).
 */
export function scoreRetrieval(hits: SearchHit[], t: ConfidenceThresholds): Confidence {
  if (!hits.length) {
    return {
      score: 0,
      band: 'low',
      signals: [{ name: 'top_similarity', value: 0, detail: 'no candidates' }],
      rationale: 'No knowledge-base passages matched the question.',
    };
  }
  const bySim = [...hits].sort((a, b) => b.similarity - a.similarity);
  const top = bySim[0]!;
  const runnerUp = bySim.find((h) => h.docId !== top.docId);
  const fusedTop = hits[0]!;

  const sSim = clamp01((top.similarity - t.minSimilarity) / (t.similarityCeiling - t.minSimilarity));
  const sLex = fusedTop.lexicalRank !== null && fusedTop.vectorRank !== null ? 1 : 0;
  const sMargin = runnerUp ? clamp01((top.similarity - runnerUp.similarity) / 0.1) : 1;
  const score = round3(0.75 * sSim + 0.15 * sLex + 0.1 * sMargin);

  const signals: ConfidenceSignal[] = [
    { name: 'top_similarity', value: round3(top.similarity), detail: `${top.docTitle} › ${top.headingPath.join(' › ')}` },
    { name: 'similarity_score', value: round3(sSim) },
    { name: 'lexical_agreement', value: sLex },
    { name: 'doc_margin', value: round3(sMargin) },
  ];

  if (top.similarity < t.minSimilarity) {
    return {
      score: Math.min(score, t.low - 0.01),
      band: 'low',
      signals,
      rationale: `Best match similarity ${top.similarity.toFixed(3)} is below the hard floor ${t.minSimilarity}.`,
    };
  }
  const band: ConfidenceBand = score >= t.high ? 'high' : score >= t.low ? 'medium' : 'low';
  return {
    score,
    band,
    signals,
    rationale: `Composite ${score.toFixed(2)} (similarity ${top.similarity.toFixed(3)}${sLex ? ', keyword match' : ''}) → ${band}.`,
  };
}

/** Combine retrieval confidence with the answerability judge's verdict. */
export function applyJudgement(
  retrieval: Confidence,
  judge: { answerable: boolean; confidence: number },
  t: Pick<ConfidenceThresholds, 'high' | 'low'>,
): Confidence {
  const score = round3(judge.answerable ? 0.5 * retrieval.score + 0.5 * judge.confidence : Math.min(retrieval.score, 0.2));
  const band: ConfidenceBand = !judge.answerable ? 'low' : score >= t.high ? 'high' : score >= t.low ? 'medium' : 'low';
  return {
    score,
    band,
    signals: [...retrieval.signals, { name: 'judge_confidence', value: round3(judge.confidence), detail: judge.answerable ? 'answerable' : 'not answerable' }],
    rationale: judge.answerable
      ? `${retrieval.rationale} Verifier confirmed the sources answer the question (${judge.confidence.toFixed(2)}).`
      : `${retrieval.rationale} Verifier found the sources do not answer the question.`,
  };
}
