/**
 * Server-side voice activity detection.
 *
 * The live transcription models (gpt-live-transcribe / gpt-realtime-whisper) require
 * `turn_detection: null`, so endpointing and barge-in detection are ours. An energy VAD with an
 * adaptive noise floor is deliberately simple, deterministic and unit-testable; the browser's own
 * echo cancellation / noise suppression does the heavy DSP lifting before audio reaches us.
 *
 *  - speech starts after `startFrames` consecutive frames above threshold (debounce clicks/taps);
 *  - speech ends after `endSilenceMs` below threshold (the endpointing delay);
 *  - utterances shorter than `minUtteranceMs` are reported invalid (coughs, door slams);
 *  - while the assistant is speaking, `echoGuard` raises the threshold so residual echo of our
 *    own TTS doesn't register as the customer interrupting.
 */

export interface VadOptions {
  sampleRate: number;
  frameMs?: number;
  startFrames?: number;
  endSilenceMs?: number;
  minUtteranceMs?: number;
  /** Absolute floor on the RMS threshold (normalised 0..1). */
  minThreshold?: number;
  /** Threshold = max(minThreshold, noiseFloor × snr). */
  snr?: number;
  echoGuardMultiplier?: number;
}

export type VadEvent =
  | { type: 'speech_start'; atMs: number }
  | { type: 'speech_end'; atMs: number; durationMs: number; valid: boolean };

export interface VadFrame {
  samples: Int16Array;
  rms: number;
  speech: boolean;
}

export class EnergyVad {
  private readonly frameSamples: number;
  private readonly frameMs: number;
  private readonly startFrames: number;
  private readonly endSilenceMs: number;
  private readonly minUtteranceMs: number;
  private readonly minThreshold: number;
  private readonly snr: number;
  private readonly echoGuardMultiplier: number;

  private remainder = new Int16Array(0);
  private noiseFloor = 0.004;
  private clockMs = 0;
  private aboveCount = 0;
  private silenceMs = 0;
  private speechStartMs = 0;
  private lastVoicedMs = 0;
  private _speaking = false;
  echoGuard = false;

  constructor(opts: VadOptions) {
    this.frameMs = opts.frameMs ?? 20;
    this.frameSamples = Math.round((opts.sampleRate * this.frameMs) / 1000);
    this.startFrames = opts.startFrames ?? 4;
    this.endSilenceMs = opts.endSilenceMs ?? 650;
    this.minUtteranceMs = opts.minUtteranceMs ?? 250;
    this.minThreshold = opts.minThreshold ?? 0.012;
    this.snr = opts.snr ?? 3;
    this.echoGuardMultiplier = opts.echoGuardMultiplier ?? 2.5;
  }

  get speaking(): boolean {
    return this._speaking;
  }

  get threshold(): number {
    const base = Math.max(this.minThreshold, this.noiseFloor * this.snr);
    return this.echoGuard ? base * this.echoGuardMultiplier : base;
  }

  /** Feed arbitrary-length PCM; returns per-frame classification and any state transitions. */
  push(pcm: Int16Array): { frames: VadFrame[]; events: VadEvent[] } {
    const joined = new Int16Array(this.remainder.length + pcm.length);
    joined.set(this.remainder);
    joined.set(pcm, this.remainder.length);

    const frames: VadFrame[] = [];
    const events: VadEvent[] = [];
    let offset = 0;
    for (; offset + this.frameSamples <= joined.length; offset += this.frameSamples) {
      const samples = joined.slice(offset, offset + this.frameSamples);
      const rms = frameRms(samples);
      const voiced = rms > this.threshold;
      this.clockMs += this.frameMs;

      if (!this._speaking) {
        this.aboveCount = voiced ? this.aboveCount + 1 : 0;
        // Track the noise floor only from clearly unvoiced frames.
        if (!voiced) this.noiseFloor = Math.max(0.001, this.noiseFloor * 0.95 + rms * 0.05);
        if (this.aboveCount >= this.startFrames) {
          this._speaking = true;
          this.silenceMs = 0;
          this.speechStartMs = this.clockMs - this.aboveCount * this.frameMs;
          this.lastVoicedMs = this.clockMs;
          events.push({ type: 'speech_start', atMs: this.speechStartMs });
        }
      } else if (voiced) {
        this.silenceMs = 0;
        this.lastVoicedMs = this.clockMs;
      } else {
        this.silenceMs += this.frameMs;
        if (this.silenceMs >= this.endSilenceMs) {
          const durationMs = this.lastVoicedMs - this.speechStartMs;
          this._speaking = false;
          this.aboveCount = 0;
          events.push({ type: 'speech_end', atMs: this.clockMs, durationMs, valid: durationMs >= this.minUtteranceMs });
        }
      }
      frames.push({ samples, rms, speech: this._speaking });
    }
    this.remainder = joined.slice(offset);
    return { frames, events };
  }

  /** Milliseconds of continuous speech so far in the current utterance. */
  currentSpeechMs(): number {
    return this._speaking ? this.lastVoicedMs - this.speechStartMs : 0;
  }

  reset(): void {
    this._speaking = false;
    this.aboveCount = 0;
    this.silenceMs = 0;
    this.remainder = new Int16Array(0);
  }
}

export function frameRms(samples: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = (samples[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}
