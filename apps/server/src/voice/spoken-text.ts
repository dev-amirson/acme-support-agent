/**
 * Normalise display text into what should be *spoken*. The transcript keeps the readable form
 * (citations, bold IDs); TTS gets plain speech.
 */
const spell = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').split('').join(' ');

export function toSpokenText(text: string): string {
  return (
    text
      // citations [1] / [1][2]
      .replace(/\s?\[\d+\]/g, '')
      // markdown links [label](url) → label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      // bold/italic/code markers
      .replace(/(\*\*|__|\*|_|`)/g, '')
      // headings / bullets / numbered list markers at line start
      .replace(/^\s{0,3}(#{1,6}\s+|[-*•]\s+|\d+\.\s+)/gm, '')
      // identifiers → spelled out ("E S C 4 8 2 9 1 7")
      .replace(/\b(ESC|RF|AC|INV)-[\dA-Z-]+\b/g, (id) => spell(id))
      // ranges "5–10" → "5 to 10"
      .replace(/(\d)\s?[–-]\s?(\d)/g, '$1 to $2')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}

/** Very short noises / acknowledgements that shouldn't trigger a new turn while the agent talks. */
const BACKCHANNEL = /^(?:uh+|um+|hmm+|mm+-?hmm+|mhm|ok(?:ay)?|yeah|yep|yes|right|sure|got it|i see|alright)[.!?,\s]*$/i;
export function isBackchannel(transcript: string): boolean {
  return BACKCHANNEL.test(transcript.trim());
}

/** Trim display text to roughly what was heard, cutting on a word boundary. */
export function heardPrefix(text: string, fraction: number): string {
  if (fraction >= 1) return text;
  if (fraction <= 0) return '';
  const cut = Math.floor(text.length * fraction);
  const boundary = text.lastIndexOf(' ', cut);
  return `${text.slice(0, boundary > 0 ? boundary : cut).trimEnd()}…`;
}
