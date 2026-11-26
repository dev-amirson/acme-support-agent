import type { GroundingReport } from '@acme/contracts';

/**
 * Post-generation grounding check — deterministic, zero-latency, zero-cost.
 *
 * Hallucinations in support answers are overwhelmingly *specifics*: a wrong refund window, a made-up
 * price, an invented SLA. So we extract every quantitative claim (money, percentages, durations,
 * quantities with units) from the answer and require each to appear in the evidence the model was
 * given this turn (retrieved passages + tool outputs + authoritative session facts). We also check
 * that every [n] citation refers to a source that was actually retrieved.
 */

const UNIT =
  '(?:business\\s+days?|days?|hours?|hrs?|minutes?|mins?|seconds?|weeks?|months?|years?|requests?|seats?|projects?|attempts?|times|gb|tb|mb)';
const CLAIM_RE = new RegExp(
  [
    '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?', // $49, $2,400.00
    '\\d[\\d,]*(?:\\.\\d+)?\\s?%', // 99.95%
    `\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:-|–|to)\\s?\\d[\\d,]*(?:\\.\\d+)?)?\\s?${UNIT}\\b`, // 5–10 business days, 600 requests
  ].join('|'),
  'gi',
);

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function normalizeNumber(raw: string): string {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? String(n) : raw;
}

export function extractClaims(text: string): Array<{ claim: string; numbers: string[] }> {
  const withoutCitations = text.replace(/\[\d+\]/g, ' ');
  const claims: Array<{ claim: string; numbers: string[] }> = [];
  for (const match of withoutCitations.matchAll(CLAIM_RE)) {
    const claim = match[0].trim();
    const numbers = (claim.match(NUMBER_RE) ?? []).map(normalizeNumber);
    if (numbers.length) claims.push({ claim, numbers });
  }
  return claims;
}

export function evidenceNumbers(evidence: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const text of evidence) {
    for (const m of text.match(NUMBER_RE) ?? []) set.add(normalizeNumber(m));
  }
  return set;
}

export function checkGrounding(params: {
  answer: string;
  evidence: readonly string[];
  validCitationIndices: ReadonlySet<number>;
}): GroundingReport {
  const claims = extractClaims(params.answer);
  const known = evidenceNumbers(params.evidence);
  const unsupportedClaims = claims.filter((c) => !c.numbers.every((n) => known.has(n))).map((c) => c.claim);
  const cited = [...params.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const invalidCitations = [...new Set(cited.filter((i) => !params.validCitationIndices.has(i)))];
  return {
    passed: unsupportedClaims.length === 0 && invalidCitations.length === 0,
    checkedClaims: claims.length,
    unsupportedClaims: [...new Set(unsupportedClaims)],
    invalidCitations,
  };
}
