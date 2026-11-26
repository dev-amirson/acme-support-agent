import type OpenAI from 'openai';
import type { Logger } from '../lib/logger';

/**
 * Streaming text-to-speech. Output is raw PCM16 mono @ 24 kHz.
 *
 * Note: OpenAI has announced the /v1/audio/speech models' shutdown for 2027-01-06 and its named
 * successor runs only on the Realtime API. This interface is the seam for that migration (or for
 * a different vendor) — nothing above it knows which engine is speaking.
 */
export interface TextToSpeech {
  readonly model: string;
  stream(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

const VOICE_INSTRUCTIONS =
  'You are a warm, calm and efficient customer support agent on a phone call. Speak naturally at a brisk, friendly pace with clear diction. Read identifiers letter by letter.';

export class OpenAITextToSpeech implements TextToSpeech {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly voice: string,
  ) {}

  async *stream(text: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const res = await this.client.audio.speech.create(
      { model: this.model, voice: this.voice, input: text, response_format: 'pcm', instructions: VOICE_INSTRUCTIONS },
      { signal },
    );
    if (!res.body) return;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) yield chunk;
  }
}

/**
 * Pre-synthesised holding phrases ("One moment…") played when a turn starts calling tools before
 * any answer text exists. Synthesised once per process and replayed from memory: zero latency,
 * zero marginal cost.
 */
export class FillerCache {
  static readonly PHRASES = ['One moment while I check that.', 'Let me look into that for you.', 'Just a second while I pull that up.'];
  private readonly audio = new Map<string, Uint8Array>();
  private warming: Promise<void> | null = null;
  private next = 0;

  constructor(
    private readonly tts: TextToSpeech,
    private readonly log: Logger,
  ) {}

  warm(): Promise<void> {
    this.warming ??= Promise.all(
      FillerCache.PHRASES.map(async (phrase) => {
        const parts: Uint8Array[] = [];
        for await (const chunk of this.tts.stream(phrase, AbortSignal.timeout(15_000))) parts.push(chunk);
        this.audio.set(phrase, Buffer.concat(parts));
      }),
    )
      .then(() => undefined)
      .catch((err) => {
        this.log.warn({ err: (err as Error).message }, 'filler warm-up failed');
        this.warming = null;
      });
    return this.warming;
  }

  /** A cached phrase, or null if not warmed yet (then we simply skip the filler). */
  take(): { phrase: string; pcm: Uint8Array } | null {
    if (!this.audio.size) return null;
    const phrase = FillerCache.PHRASES[this.next++ % FillerCache.PHRASES.length]!;
    const pcm = this.audio.get(phrase);
    return pcm ? { phrase, pcm } : null;
  }
}
