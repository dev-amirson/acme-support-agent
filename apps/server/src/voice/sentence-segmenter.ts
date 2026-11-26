/**
 * Turns a token stream into speakable segments for streaming TTS.
 *
 * Latency vs. prosody: TTS sounds best with whole sentences, but waiting for a full first sentence
 * delays first audio. So the *first* segment may break at a clause boundary (comma, colon, dash)
 * once it's long enough to sound natural; later segments break at sentence ends. A hard cap keeps
 * a run-on sentence from stalling audio.
 */
const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|etc|vs|mr|mrs|ms|dr|inc|approx|no)\.)$/i;

export interface SegmenterOptions {
  firstClauseMinChars?: number;
  minChars?: number;
  maxChars?: number;
}

export class SentenceSegmenter {
  private buffer = '';
  private emitted = 0;
  private readonly firstClauseMinChars: number;
  private readonly minChars: number;
  private readonly maxChars: number;

  constructor(opts: SegmenterOptions = {}) {
    this.firstClauseMinChars = opts.firstClauseMinChars ?? 28;
    this.minChars = opts.minChars ?? 18;
    this.maxChars = opts.maxChars ?? 240;
  }

  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (let seg = this.next(); seg !== null; seg = this.next()) out.push(seg);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }

  private next(): string | null {
    const text = this.buffer;
    // Sentence boundary: terminal punctuation followed by whitespace (so "$49.00" never splits).
    const sentenceRe = /[.!?]+["')\]]*(?=\s)|\n+/g;
    for (let m = sentenceRe.exec(text); m; m = sentenceRe.exec(text)) {
      const end = m.index + m[0].length;
      const candidate = text.slice(0, end);
      if (ABBREVIATIONS.test(candidate.trimEnd())) continue;
      if (candidate.trim().length < this.minChars) continue;
      return this.take(end);
    }
    if (this.emitted === 0) {
      const clauseRe = /[,;:—–](?=\s)/g;
      for (let m = clauseRe.exec(text); m; m = clauseRe.exec(text)) {
        const end = m.index + m[0].length;
        if (end >= this.firstClauseMinChars) return this.take(end);
      }
    }
    if (text.length > this.maxChars) {
      const cut = text.lastIndexOf(' ', this.maxChars);
      return this.take(cut > this.minChars ? cut : this.maxChars);
    }
    return null;
  }

  private take(end: number): string | null {
    const seg = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end);
    if (!seg) return null;
    this.emitted++;
    return seg;
  }
}
