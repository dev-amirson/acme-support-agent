import { encodeAudioFrame, VOICE_SAMPLE_RATE } from '@acme/contracts';
import { AsyncQueue } from '../lib/async';
import { isAbortError } from '../lib/errors';
import type { Logger } from '../lib/logger';
import type { TextToSpeech } from './tts';

export interface SpokenSegment {
  index: number;
  /** Text as shown in the transcript ('' for holding phrases). */
  display: string;
  spoken: string;
  filler: boolean;
  bytes: number;
}

interface Job extends SpokenSegment {
  chunks: AsyncQueue<Uint8Array>;
  cached?: Uint8Array;
  started: boolean;
}

const BYTES_PER_MS = (VOICE_SAMPLE_RATE * 2) / 1000;
/** 100 ms of audio per WebSocket frame: small enough for snappy barge-in, large enough to be cheap. */
const FRAME_BYTES = 4_800;

/**
 * Ordered, prefetching TTS for one assistant response.
 *
 * Segment n+1 is synthesised while segment n is streaming, so sentence boundaries don't become
 * audible gaps; output is strictly in order. Every frame is tagged with the response id so the
 * client can drop audio that was already in flight when the customer interrupted.
 */
export class SpeechPipeline {
  readonly segments: SpokenSegment[] = [];
  private readonly jobs: Job[] = [];
  private ended = false;
  private active = 0;
  private wake: (() => void) | null = null;
  synthesizedBytes = 0;
  readonly done: Promise<void>;

  constructor(
    private readonly opts: {
      responseId: number;
      tts: TextToSpeech;
      signal: AbortSignal;
      send: (frame: Uint8Array) => void;
      onSegmentStart: (segment: SpokenSegment) => void;
      log: Logger;
      concurrency?: number;
    },
  ) {
    this.done = this.pump();
  }

  get sentMs(): number {
    return this.segments.reduce((ms, s) => ms + s.bytes / BYTES_PER_MS, 0);
  }

  get synthesizedSeconds(): number {
    return this.synthesizedBytes / (BYTES_PER_MS * 1000);
  }

  enqueue(segment: { display: string; spoken: string; filler?: boolean; cachedPcm?: Uint8Array }): void {
    if (this.ended || this.opts.signal.aborted) return;
    const job: Job = {
      index: this.jobs.length,
      display: segment.display,
      spoken: segment.spoken,
      filler: Boolean(segment.filler),
      bytes: 0,
      chunks: new AsyncQueue<Uint8Array>(),
      cached: segment.cachedPcm,
      started: false,
    };
    this.jobs.push(job);
    this.kick();
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  private kick(): void {
    const limit = this.opts.concurrency ?? 2;
    for (const job of this.jobs) {
      if (this.active >= limit) break;
      if (job.started) continue;
      job.started = true;
      if (job.cached) {
        job.chunks.push(job.cached);
        job.chunks.close();
        continue;
      }
      this.active++;
      void this.synthesize(job).finally(() => {
        this.active--;
        this.kick();
      });
    }
  }

  private async synthesize(job: Job): Promise<void> {
    try {
      for await (const chunk of this.opts.tts.stream(job.spoken, this.opts.signal)) {
        this.synthesizedBytes += chunk.byteLength;
        job.chunks.push(chunk);
      }
    } catch (err) {
      if (!isAbortError(err) && !this.opts.signal.aborted) {
        this.opts.log.warn({ err: (err as Error).message, segment: job.index }, 'tts segment failed — skipping');
      }
    } finally {
      job.chunks.close();
    }
  }

  private async nextJob(index: number): Promise<Job | null> {
    while (!this.jobs[index]) {
      if (this.ended || this.opts.signal.aborted) return null;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
    return this.jobs[index]!;
  }

  private async pump(): Promise<void> {
    for (let i = 0; ; i++) {
      const job = await this.nextJob(i);
      if (!job || this.opts.signal.aborted) return;
      this.segments.push(job);
      this.opts.onSegmentStart(job);
      let carry: Uint8Array = new Uint8Array(0);
      for await (const chunk of job.chunks) {
        if (this.opts.signal.aborted) return;
        let buf = carry.byteLength ? concat(carry, chunk) : chunk;
        while (buf.byteLength >= FRAME_BYTES) {
          this.emit(job, buf.subarray(0, FRAME_BYTES));
          buf = buf.subarray(FRAME_BYTES);
        }
        carry = buf;
      }
      // Flush the tail, keeping PCM16 sample alignment.
      const even = carry.byteLength - (carry.byteLength % 2);
      if (even > 0 && !this.opts.signal.aborted) this.emit(job, carry.subarray(0, even));
    }
  }

  private emit(job: Job, pcm: Uint8Array): void {
    job.bytes += pcm.byteLength;
    this.opts.send(encodeAudioFrame(this.opts.responseId, job.index, pcm));
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}
