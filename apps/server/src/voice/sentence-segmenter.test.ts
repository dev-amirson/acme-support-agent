import { describe, expect, it } from 'vitest';
import { SentenceSegmenter, type SegmenterOptions } from './sentence-segmenter';

/** Stream text through the segmenter in fixed-size deltas, the way model tokens arrive. */
function segment(text: string, opts?: SegmenterOptions, deltaSize = 1): string[] {
  const s = new SentenceSegmenter(opts);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += deltaSize) out.push(...s.push(text.slice(i, i + deltaSize)));
  out.push(...s.flush());
  return out;
}

/** Word-level deltas (closer to real tokenisation than single characters). */
const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];

describe('SentenceSegmenter', () => {
  it('splits at sentence ends', () => {
    expect(segment('Your refund of $49.00 has been issued. It will arrive in 5–10 business days. Anything else?')).toEqual([
      'Your refund of $49.00 has been issued.',
      'It will arrive in 5–10 business days.',
      'Anything else?',
    ]);
  });

  it('never splits inside a decimal amount, even when the delta boundary falls on the dot', () => {
    const s = new SentenceSegmenter();
    expect(s.push('The annual plan costs $490.')).toEqual([]);
    expect(s.push('00 per workspace and renews yearly. ')).toEqual(['The annual plan costs $490.00 per workspace and renews yearly.']);
  });

  it('does not emit a sentence until whitespace confirms the boundary', () => {
    const s = new SentenceSegmenter();
    expect(s.push('Your ticket number is ready now.')).toEqual([]);
    expect(s.push(' ')).toEqual(['Your ticket number is ready now.']);
  });

  it('may break the first segment at a clause boundary to get audio out sooner', () => {
    const s = new SentenceSegmenter();
    const out: string[] = [];
    for (const w of words('I have looked at your billing history carefully, and I can see the duplicate charge, which I will refund now. ')) {
      out.push(...s.push(w));
    }
    out.push(...s.flush());
    // Only the FIRST segment may break at a clause; later ones wait for the sentence end.
    expect(out).toEqual(['I have looked at your billing history carefully,', 'and I can see the duplicate charge, which I will refund now.']);
  });

  it('does not clause-break before firstClauseMinChars', () => {
    const out = segment('Sure, Alice, let me look into that for you right away. ', undefined, 4);
    expect(out[0]).toBe('Sure, Alice, let me look into that for you right away.');
  });

  it('merges very short sentences into the next one', () => {
    expect(segment('Yes. That refund is on its way to your card now. ')).toEqual(['Yes. That refund is on its way to your card now.']);
  });

  it('does not split after common abbreviations', () => {
    expect(segment('Please contact Dr. Smith about the invoice. Thanks for waiting!')).toEqual([
      'Please contact Dr. Smith about the invoice.',
      'Thanks for waiting!',
    ]);
    expect(segment('Use a strong secret, e.g. a long passphrase. Then save it.')).toEqual([
      'Use a strong secret, e.g. a long passphrase.',
      'Then save it.',
    ]);
  });

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(segment('Select the option called "Billing." Then click save, please.')).toEqual([
      'Select the option called "Billing."',
      'Then click save, please.',
    ]);
  });

  it('treats newlines as boundaries', () => {
    expect(segment('Here is what I found for you\nYour plan renews monthly')).toEqual([
      'Here is what I found for you',
      'Your plan renews monthly',
    ]);
  });

  it('caps run-on text at maxChars on a word boundary', () => {
    const runOn = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const out = segment(runOn, { maxChars: 100 }, 7);
    expect(out.length).toBeGreaterThan(3);
    for (const seg of out) expect(seg.length).toBeLessThanOrEqual(100);
    expect(out.join(' ')).toBe(runOn); // nothing lost, no word cut in half
  });

  it('flush() returns the remainder once and then nothing', () => {
    const s = new SentenceSegmenter();
    s.push('Trailing words without punctuation');
    expect(s.flush()).toEqual(['Trailing words without punctuation']);
    expect(s.flush()).toEqual([]);
    expect(new SentenceSegmenter().flush()).toEqual([]);
  });

  it('output segments reassemble to the input text', () => {
    const text = 'Thanks, Alice — I found it. Invoice INV-1001-04 was a duplicate of INV-1001-03, so I refunded $49.00. It arrives in 5–10 business days. Anything else?';
    expect(segment(text, undefined, 3).join(' ')).toBe(text);
  });
});
