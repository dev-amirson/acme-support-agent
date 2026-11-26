import { describe, expect, it } from 'vitest';
import { checkGrounding, evidenceNumbers, extractClaims, normalizeNumber } from './grounding';

const claimsOf = (text: string) => extractClaims(text).map((c) => c.claim);

describe('extractClaims', () => {
  it('extracts money, percentages, ranges and quantities with units', () => {
    expect(claimsOf('The Pro plan is $49 per month, or $2,400.00 for the team bundle.')).toEqual(['$49', '$2,400.00']);
    expect(claimsOf('We guarantee 99.95% uptime and a 10 % credit.')).toEqual(['99.95%', '10 %']);
    expect(claimsOf('Funds arrive within 5–10 business days.')).toEqual(['5–10 business days']);
    expect(claimsOf('Funds arrive within 5-10 business days.')).toEqual(['5-10 business days']);
    expect(claimsOf('Expect a reply in 3 to 5 hours.')).toEqual(['3 to 5 hours']);
    expect(claimsOf('The API allows 600 requests per minute across 3 projects.')).toEqual(['600 requests', '3 projects']);
    expect(claimsOf('Refunds are possible within 14 days, duplicates for 90 days.')).toEqual(['14 days', '90 days']);
  });

  it('normalises the numbers inside a claim', () => {
    expect(extractClaims('$2,400.00')).toEqual([{ claim: '$2,400.00', numbers: ['2400'] }]);
    expect(extractClaims('5–10 business days')).toEqual([{ claim: '5–10 business days', numbers: ['5', '10'] }]);
    expect(normalizeNumber('49.00')).toBe('49');
    expect(normalizeNumber('1,000')).toBe('1000');
  });

  it('does not treat identifiers as claims', () => {
    const text = 'Refund RF-123456 for invoice INV-1001-04 on account AC-1001 — ticket ESC-482917 is open.';
    expect(extractClaims(text)).toEqual([]);
  });

  it('ignores citation markers and bare numbers without a unit', () => {
    expect(extractClaims('See the refund policy [2][3]. You have 2 options.')).toEqual([]);
  });
});

describe('evidenceNumbers', () => {
  it('collects normalised numbers from text and JSON tool output', () => {
    const set = evidenceNumbers(['{"amount_usd":49,"days_since_charge":4}', 'within 5–10 business days', '$2,400.00']);
    expect([...set].sort()).toEqual(['10', '2400', '4', '49', '5'].sort());
  });
});

describe('checkGrounding', () => {
  const evidence = [
    'Funds arrive within 5–10 business days after the refund is issued.',
    '{"status":"refunded","refund_id":"RF-123456","amount_usd":49,"reason":"duplicate_charge"}',
    'The API allows 600 requests per minute.',
  ];

  it('passes when every specific claim appears in the evidence', () => {
    const r = checkGrounding({
      answer: 'I refunded $49.00 (RF-123456). It arrives in 5–10 business days [1]. The limit is 600 requests per minute.',
      evidence,
      validCitationIndices: new Set([1]),
    });
    expect(r).toEqual({ passed: true, checkedClaims: 3, unsupportedClaims: [], invalidCitations: [] });
  });

  it('flags claims whose numbers are missing from the evidence', () => {
    const r = checkGrounding({
      answer: 'Your $49 refund arrives in 5–15 business days and you get a 20% credit.',
      evidence,
      validCitationIndices: new Set(),
    });
    expect(r.passed).toBe(false);
    expect(r.checkedClaims).toBe(3);
    // A range is only supported if *both* ends are — "15" never appeared.
    expect(r.unsupportedClaims).toEqual(['5–15 business days', '20%']);
  });

  it('de-duplicates repeated unsupported claims', () => {
    const r = checkGrounding({ answer: 'It costs $99. Yes, $99.', evidence, validCitationIndices: new Set() });
    expect(r.unsupportedClaims).toEqual(['$99']);
    expect(r.checkedClaims).toBe(2);
  });

  it('flags citations to sources that were not retrieved this turn', () => {
    const r = checkGrounding({
      answer: 'Duplicate charges are refundable [1][3], see also [3] and [7].',
      evidence,
      validCitationIndices: new Set([1, 2]),
    });
    expect(r.passed).toBe(false);
    expect(r.invalidCitations).toEqual([3, 7]);
    expect(r.unsupportedClaims).toEqual([]);
  });

  it('a conversational reply with no specifics trivially passes', () => {
    const r = checkGrounding({ answer: 'Happy to help! What is your account ID?', evidence: [], validCitationIndices: new Set() });
    expect(r).toEqual({ passed: true, checkedClaims: 0, unsupportedClaims: [], invalidCitations: [] });
  });

  it('identifiers in the answer never count as unsupported, even with empty evidence', () => {
    const r = checkGrounding({ answer: 'Your ticket is ESC-482917 and refund RF-654321.', evidence: [], validCitationIndices: new Set() });
    expect(r.passed).toBe(true);
    expect(r.checkedClaims).toBe(0);
  });
});
