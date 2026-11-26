import { describe, expect, it } from 'vitest';
import { applyJudgement, scoreRetrieval, type ConfidenceThresholds } from './confidence';
import type { SearchHit } from './kb-repository';

/** The production defaults from config.ts. */
const T: ConfidenceThresholds = { minSimilarity: 0.3, similarityCeiling: 0.62, high: 0.7, low: 0.42 };

let seq = 0;
function hit(over: Partial<SearchHit> & { similarity: number }): SearchHit {
  seq++;
  return {
    chunkId: `doc::${seq}`,
    docId: 'refund-policy',
    docTitle: 'Refund Policy',
    headingPath: ['Pro Plan Refunds'],
    content: 'Pro subscription charges can be refunded within 14 days.',
    tiers: [],
    vectorRank: 1,
    lexicalRank: null,
    rrf: 0.016,
    ...over,
  };
}

const signal = (c: ReturnType<typeof scoreRetrieval>, name: string) => c.signals.find((s) => s.name === name)?.value;

describe('scoreRetrieval', () => {
  it('no candidates → score 0, low band', () => {
    const c = scoreRetrieval([], T);
    expect(c).toMatchObject({ score: 0, band: 'low' });
    expect(c.rationale).toMatch(/No knowledge-base passages/);
  });

  it('strong similarity + keyword agreement + clear doc winner → high', () => {
    const c = scoreRetrieval(
      [hit({ similarity: 0.66, lexicalRank: 1 }), hit({ docId: 'billing', similarity: 0.4 })],
      T,
    );
    expect(c.band).toBe('high');
    expect(c.score).toBe(1); // 0.75·1 + 0.15·1 + 0.10·1
    expect(signal(c, 'similarity_score')).toBe(1);
    expect(signal(c, 'lexical_agreement')).toBe(1);
    expect(signal(c, 'doc_margin')).toBe(1);
    expect(signal(c, 'top_similarity')).toBe(0.66);
  });

  it('moderate similarity with an ambiguous runner-up → medium', () => {
    // s_sim = (0.5 − 0.3) / 0.32 = 0.625 → 0.469; no lexical; margin 0.
    const c = scoreRetrieval([hit({ similarity: 0.5 }), hit({ docId: 'billing', similarity: 0.5 })], T);
    expect(c.score).toBeCloseTo(0.469, 3);
    expect(c.band).toBe('medium');
  });

  it('weak similarity → low', () => {
    const c = scoreRetrieval([hit({ similarity: 0.35 }), hit({ docId: 'billing', similarity: 0.34 })], T);
    expect(c.band).toBe('low');
    expect(c.score).toBeLessThan(T.low);
  });

  it('band boundaries are inclusive at the thresholds', () => {
    // A single-doc result has margin 1 → score = 0.75·s_sim + 0.10.
    // s_sim = 0.8 → 0.70 exactly = high threshold.
    const atHigh = scoreRetrieval([hit({ similarity: 0.3 + 0.8 * 0.32 })], T);
    expect(atHigh.score).toBe(0.7);
    expect(atHigh.band).toBe('high');
    // s_sim = 0.4267 → 0.42 = low threshold.
    const atLow = scoreRetrieval([hit({ similarity: 0.3 + (0.32 * 0.32) / 0.75 })], T);
    expect(atLow.score).toBe(0.42);
    expect(atLow.band).toBe('medium');
  });

  it('hard similarity floor: below minSimilarity is low even if other signals would pass', () => {
    // With a lenient low threshold, lexical + margin alone (0.25) would otherwise be "medium".
    const lenient = { ...T, low: 0.2 };
    const c = scoreRetrieval([hit({ similarity: 0.29, lexicalRank: 1 })], lenient);
    expect(c.band).toBe('low');
    expect(c.score).toBeLessThan(lenient.low);
    expect(c.rationale).toMatch(/below the hard floor 0.3/);
    // Just above the floor the same signals produce a passing band.
    const above = scoreRetrieval([hit({ similarity: 0.31, lexicalRank: 1 })], lenient);
    expect(above.band).toBe('medium');
  });

  it('lexical agreement is read from the top *fused* hit and adds 0.15', () => {
    const base = scoreRetrieval([hit({ similarity: 0.5 })], T);
    const lexical = scoreRetrieval([hit({ similarity: 0.5, lexicalRank: 2 })], T);
    expect(lexical.score - base.score).toBeCloseTo(0.15, 3);
    expect(lexical.rationale).toMatch(/keyword match/);

    // A lexical-only hit (no vector rank) does not count as agreement.
    const lexOnly = scoreRetrieval([hit({ similarity: 0.5, vectorRank: null, lexicalRank: 1 })], T);
    expect(signal(lexOnly, 'lexical_agreement')).toBe(0);

    // Agreement on a lower-ranked fused hit doesn't count: only hits[0] matters.
    const second = scoreRetrieval([hit({ similarity: 0.5 }), hit({ similarity: 0.45, lexicalRank: 1 })], T);
    expect(signal(second, 'lexical_agreement')).toBe(0);
  });

  it('doc margin uses the best hit from a *different* document', () => {
    // Same-doc runner-ups don't create ambiguity.
    const sameDoc = scoreRetrieval([hit({ similarity: 0.5 }), hit({ similarity: 0.49 })], T);
    expect(signal(sameDoc, 'doc_margin')).toBe(1);
    // A close competitor from another doc lowers the margin: (0.5 − 0.47) / 0.1 = 0.3.
    const close = scoreRetrieval([hit({ similarity: 0.5 }), hit({ docId: 'billing', similarity: 0.47 })], T);
    expect(signal(close, 'doc_margin')).toBeCloseTo(0.3, 3);
    expect(close.score).toBeLessThan(sameDoc.score);
  });

  it('uses the highest-similarity hit even when fusion ranked it lower', () => {
    const c = scoreRetrieval([hit({ similarity: 0.4, headingPath: ['A'] }), hit({ similarity: 0.6, headingPath: ['B'] })], T);
    expect(signal(c, 'top_similarity')).toBe(0.6);
    expect(c.signals[0]!.detail).toContain('B');
  });
});

describe('applyJudgement', () => {
  const medium = scoreRetrieval([hit({ similarity: 0.5 }), hit({ docId: 'billing', similarity: 0.5 })], T);

  it('answerable with high verifier confidence can upgrade the band', () => {
    const c = applyJudgement(medium, { answerable: true, confidence: 0.95 }, T);
    expect(c.score).toBeCloseTo(0.5 * medium.score + 0.5 * 0.95, 3);
    expect(c.band).toBe('high');
    expect(c.signals.at(-1)).toEqual({ name: 'judge_confidence', value: 0.95, detail: 'answerable' });
    expect(c.rationale).toMatch(/Verifier confirmed/);
  });

  it('answerable but unsure verifier can drop to low', () => {
    const c = applyJudgement(medium, { answerable: true, confidence: 0.3 }, T);
    expect(c.score).toBeCloseTo(0.5 * medium.score + 0.15, 3);
    expect(c.band).toBe('low');
  });

  it('not answerable → always low, score capped at 0.2, regardless of retrieval strength', () => {
    const strong = scoreRetrieval([hit({ similarity: 0.7, lexicalRank: 1 })], T);
    const c = applyJudgement(strong, { answerable: false, confidence: 0.99 }, T);
    expect(c.band).toBe('low');
    expect(c.score).toBe(0.2);
    expect(c.signals.at(-1)?.detail).toBe('not answerable');
    expect(c.rationale).toMatch(/do not answer the question/);

    const weak = applyJudgement({ ...medium, score: 0.1 }, { answerable: false, confidence: 0.5 }, T);
    expect(weak.score).toBe(0.1);
  });

  it('keeps the retrieval signals for observability', () => {
    const c = applyJudgement(medium, { answerable: true, confidence: 0.8 }, T);
    expect(c.signals.slice(0, medium.signals.length)).toEqual(medium.signals);
  });
});
