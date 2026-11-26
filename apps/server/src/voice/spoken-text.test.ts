import { describe, expect, it } from 'vitest';
import { heardPrefix, isBackchannel, toSpokenText } from './spoken-text';

describe('toSpokenText', () => {
  it('strips citation markers', () => {
    expect(toSpokenText('Pro charges are refundable within 14 days [1][2].')).toBe('Pro charges are refundable within 14 days.');
    expect(toSpokenText('See [3] for details.')).toBe('See for details.');
  });

  it('strips markdown emphasis, code, headings and list markers', () => {
    expect(toSpokenText('## Your options\n- **Refund** the charge\n* _Credit_ your account\n1. Use `acme login`')).toBe(
      'Your options Refund the charge Credit your account Use acme login',
    );
  });

  it('keeps link labels and drops URLs', () => {
    expect(toSpokenText('Check the [status page](https://status.acmecloud.example) first.')).toBe('Check the status page first.');
  });

  it('spells identifiers out character by character', () => {
    expect(toSpokenText('Your ticket is **ESC-482917**.')).toBe('Your ticket is E S C 4 8 2 9 1 7.');
    expect(toSpokenText('Refund RF-123456 for INV-1001-04 on AC-1001.')).toBe(
      'Refund R F 1 2 3 4 5 6 for I N V 1 0 0 1 0 4 on A C 1 0 0 1.',
    );
  });

  it('keeps dollar amounts intact', () => {
    expect(toSpokenText('I refunded $49.00 and $2,400 is due.')).toBe('I refunded $49.00 and $2,400 is due.');
  });

  it('reads numeric ranges naturally', () => {
    expect(toSpokenText('It arrives in 5–10 business days, or 3-5 for cards.')).toBe('It arrives in 5 to 10 business days, or 3 to 5 for cards.');
    // …but an identifier's hyphenated digits are never read as a range.
    expect(toSpokenText('INV-1001-04')).not.toContain(' to ');
  });

  it('collapses newlines and whitespace', () => {
    expect(toSpokenText('  First line.\n\n   Second   line.  ')).toBe('First line. Second line.');
  });
});

describe('isBackchannel', () => {
  it.each(['uh', 'Um...', 'hmm', 'mm-hmm', 'mhm', 'Okay.', 'ok', 'yeah', 'Yep!', 'yes', 'right', ' Sure, ', 'Got it.', 'I see', 'alright'])(
    '%j is a backchannel',
    (t) => {
      expect(isBackchannel(t)).toBe(true);
    },
  );

  it.each(['', 'Okay, but what about my refund?', 'yes please refund it', 'stop', 'wait', 'no', 'Actually I have a question'])(
    '%j is a real turn',
    (t) => {
      expect(isBackchannel(t)).toBe(false);
    },
  );
});

describe('heardPrefix', () => {
  const text = 'Your refund has been issued and will arrive soon';

  it('returns everything / nothing at the extremes', () => {
    expect(heardPrefix(text, 1)).toBe(text);
    expect(heardPrefix(text, 1.5)).toBe(text);
    expect(heardPrefix(text, 0)).toBe('');
    expect(heardPrefix(text, -1)).toBe('');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const half = heardPrefix(text, 0.5);
    expect(half).toBe('Your refund has been…');
    expect(text.startsWith(half.slice(0, -1))).toBe(true);
  });

  it('cuts mid-word only when there is no earlier space', () => {
    expect(heardPrefix('Supercalifragilistic', 0.5)).toBe('Supercalif…');
  });

  it('is monotonic in the fraction heard', () => {
    let prev = 0;
    for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const len = heardPrefix(text, f).length;
      expect(len).toBeGreaterThanOrEqual(prev);
      prev = len;
    }
  });
});
