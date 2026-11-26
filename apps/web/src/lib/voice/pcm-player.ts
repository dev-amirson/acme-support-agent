import { VOICE_SAMPLE_RATE } from '@acme/contracts';

interface Scheduled {
  source: AudioBufferSourceNode;
  start: number;
  duration: number;
  segmentIndex: number;
}

/**
 * Gapless streaming playback of 24 kHz PCM16 chunks for one response at a time.
 *
 * Chunks are scheduled back-to-back on the AudioContext clock (a small initial jitter buffer
 * absorbs network variance). Because every chunk's start time is known, `stop()` can report
 * exactly how many milliseconds were *actually heard* — which the server uses to truncate the
 * stored reply after a barge-in.
 */
export class PcmPlayer {
  private readonly gain: GainNode;
  private scheduled: Scheduled[] = [];
  private nextTime = 0;
  private responseId: number | null = null;
  private drainCallback: (() => void) | null = null;
  private segmentTimers: number[] = [];
  /** Seconds of the current response whose chunks already finished playing. */
  private completedSec = 0;
  onSegmentStart: (responseId: number, segmentIndex: number) => void = () => undefined;

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
    private readonly jitterBufferMs = 90,
  ) {
    this.gain = ctx.createGain();
    this.gain.connect(destination);
  }

  get playing(): boolean {
    return this.scheduled.some((s) => s.start + s.duration > this.ctx.currentTime);
  }

  begin(responseId: number): void {
    this.stop();
    this.responseId = responseId;
    this.setVolume(1, true);
  }

  enqueue(responseId: number, segmentIndex: number, pcm: Int16Array): void {
    if (responseId !== this.responseId || pcm.length === 0) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, VOICE_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = (pcm[i] ?? 0) / 32768;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.ctx.currentTime;
    // Underrun (or first chunk): restart the timeline slightly ahead to rebuild the jitter buffer.
    const start = this.nextTime > now ? this.nextTime : now + this.jitterBufferMs / 1000;
    source.start(start);
    this.nextTime = start + buffer.duration;

    const firstOfSegment = !this.scheduled.some((s) => s.segmentIndex === segmentIndex);
    const entry: Scheduled = { source, start, duration: buffer.duration, segmentIndex };
    this.scheduled.push(entry);
    if (firstOfSegment) {
      const delay = Math.max(0, (start - now) * 1000);
      this.segmentTimers.push(window.setTimeout(() => this.onSegmentStart(responseId, segmentIndex), delay));
    }
    source.onended = () => {
      this.completedSec += entry.duration;
      this.scheduled = this.scheduled.filter((s) => s !== entry);
      if (!this.scheduled.length && this.drainCallback) {
        const cb = this.drainCallback;
        this.drainCallback = null;
        cb();
      }
    };
  }

  /** Call `cb` once everything queued so far has finished playing. */
  onDrained(cb: () => void): void {
    if (!this.scheduled.length) cb();
    else this.drainCallback = cb;
  }

  setVolume(volume: number, immediate = false): void {
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    if (immediate) this.gain.gain.setValueAtTime(volume, t);
    else this.gain.gain.setTargetAtTime(volume, t, 0.04);
  }

  /** Stop immediately; returns milliseconds of this response that were actually played. */
  stop(): number {
    const now = this.ctx.currentTime;
    let playedSec = 0;
    for (const s of this.scheduled) {
      playedSec += Math.max(0, Math.min(s.duration, now - s.start));
      s.source.onended = null;
      try {
        s.source.stop();
      } catch {
        /* already stopped */
      }
    }
    playedSec += this.completedSec;
    this.scheduled = [];
    this.segmentTimers.forEach((t) => window.clearTimeout(t));
    this.segmentTimers = [];
    this.nextTime = 0;
    this.drainCallback = null;
    this.responseId = null;
    this.completedSec = 0;
    return Math.round(playedSec * 1000);
  }

}
