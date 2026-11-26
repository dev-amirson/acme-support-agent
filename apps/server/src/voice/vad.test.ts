import { describe, expect, it } from 'vitest';
import { EnergyVad, frameRms, type VadEvent } from './vad';

const RATE = 24_000;
const samplesFor = (ms: number) => Math.round((RATE * ms) / 1000);

/** Deterministic PRNG so "noise" is reproducible. */
function lcg(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** PCM16 sine burst; `amplitude` is normalised 0..1 (RMS = amplitude / √2). */
function tone(ms: number, amplitude: number, freq = 220): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * freq * i) / RATE));
  return out;
}

/** Uniform noise; RMS ≈ amplitude / √3. amplitude 0 → digital silence. */
function noise(ms: number, amplitude: number, rand = lcg()): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  for (let i = 0; i < out.length; i++) out[i] = Math.round((rand() * 2 - 1) * amplitude * 32767);
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Feed audio in uneven chunks, the way WebSocket frames arrive. */
function feed(vad: EnergyVad, pcm: Int16Array, chunk = 1_234): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < pcm.length; i += chunk) events.push(...vad.push(pcm.subarray(i, i + chunk)).events);
  return events;
}

const newVad = () => new EnergyVad({ sampleRate: RATE }); // defaults: 20 ms frames, 4 start frames, 650 ms endpointing

describe('frameRms', () => {
  it('computes normalised RMS', () => {
    expect(frameRms(new Int16Array(480))).toBe(0);
    expect(frameRms(tone(20, 0.5, 1_200))).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(frameRms(new Int16Array(0))).toBe(0);
  });
});

describe('EnergyVad', () => {
  it('detects one utterance with accurate start/end timing', () => {
    const vad = newVad();
    const pcm = concat(noise(500, 0.003), tone(600, 0.3), noise(1_000, 0.003));
    const events = feed(vad, pcm);

    expect(events).toHaveLength(2);
    const [start, end] = events;
    // Speech is confirmed after 4 frames but the start is back-dated to the first voiced frame.
    expect(start).toEqual({ type: 'speech_start', atMs: 500 });
    expect(end).toMatchObject({ type: 'speech_end', valid: true, durationMs: 600 });
    // End fires once 650 ms of silence has elapsed after the last voiced frame (1100 ms) — 20 ms frame granularity.
    expect(end!.atMs).toBeGreaterThanOrEqual(1_100 + 650);
    expect(end!.atMs).toBeLessThanOrEqual(1_100 + 650 + 20);
    expect(vad.speaking).toBe(false);
  });

  it('is independent of how the PCM is chunked', () => {
    const pcm = concat(noise(300, 0.003), tone(400, 0.3), noise(900, 0.003));
    const a = feed(newVad(), pcm, 97);
    const b = feed(newVad(), pcm, 24_000);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it('keeps an utterance open through short pauses (shorter than the endpointing delay)', () => {
    const pcm = concat(noise(200, 0.002), tone(400, 0.3), noise(300, 0.002), tone(400, 0.3), noise(1_000, 0.002));
    const events = feed(newVad(), pcm);
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    expect(events[1]).toMatchObject({ durationMs: 1_100, valid: true });
  });

  it('reports a sub-minimum utterance (cough / door slam) as invalid', () => {
    const events = feed(newVad(), concat(noise(300, 0.002), tone(160, 0.4), noise(900, 0.002)));
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end']);
    expect(events[1]).toMatchObject({ valid: false, durationMs: 160 });
  });

  it('ignores clicks shorter than the start debounce', () => {
    const events = feed(newVad(), concat(noise(300, 0.002), tone(60, 0.5), noise(900, 0.002)));
    expect(events).toEqual([]);
  });

  it('marks frames as speech while an utterance is open', () => {
    const vad = newVad();
    const { frames } = vad.push(concat(noise(200, 0.002), tone(200, 0.3)));
    expect(frames).toHaveLength(20);
    expect(frames.slice(0, 10).every((f) => !f.speech)).toBe(true);
    expect(frames.at(-1)!.speech).toBe(true);
    expect(vad.currentSpeechMs()).toBe(200);
  });

  it('echoGuard raises the threshold so moderate residual echo does not trigger', () => {
    const moderate = concat(noise(200, 0.002), tone(600, 0.03), noise(900, 0.002)); // RMS ≈ 0.021

    const plain = newVad();
    expect(feed(plain, moderate).map((e) => e.type)).toEqual(['speech_start', 'speech_end']);

    const guarded = newVad();
    const baseline = guarded.threshold;
    guarded.echoGuard = true;
    expect(guarded.threshold).toBeCloseTo(baseline * 2.5, 6);
    expect(feed(guarded, moderate)).toEqual([]);

    // A customer genuinely talking over the agent (loud) still barges in.
    const loud = newVad();
    loud.echoGuard = true;
    expect(feed(loud, concat(noise(200, 0.002), tone(600, 0.3), noise(900, 0.002))).map((e) => e.type)).toEqual([
      'speech_start',
      'speech_end',
    ]);
  });

  it('adapts its threshold to steady background noise', () => {
    const moderate = tone(600, 0.03); // RMS ≈ 0.021

    const quietRoom = newVad();
    feed(quietRoom, noise(2_000, 0.002));
    expect(quietRoom.threshold).toBeCloseTo(0.012, 3); // clamped at minThreshold
    expect(feed(quietRoom, moderate).some((e) => e.type === 'speech_start')).toBe(true);

    const noisyRoom = newVad();
    feed(noisyRoom, noise(2_000, 0.016, lcg(7))); // RMS ≈ 0.009, just under the initial threshold
    expect(noisyRoom.threshold).toBeGreaterThan(0.024);
    expect(feed(noisyRoom, moderate).some((e) => e.type === 'speech_start')).toBe(false);
  });

  it('reset() abandons an open utterance', () => {
    const vad = newVad();
    feed(vad, concat(noise(200, 0.002), tone(300, 0.3)));
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    expect(vad.currentSpeechMs()).toBe(0);
    expect(feed(vad, noise(1_000, 0.002))).toEqual([]); // no dangling speech_end
  });

  it('honours custom timing options', () => {
    const vad = new EnergyVad({ sampleRate: RATE, frameMs: 10, startFrames: 2, endSilenceMs: 200, minUtteranceMs: 100 });
    const events = feed(vad, concat(noise(100, 0.002), tone(150, 0.3), noise(400, 0.002)));
    expect(events[0]).toEqual({ type: 'speech_start', atMs: 100 });
    expect(events[1]).toMatchObject({ type: 'speech_end', durationMs: 150, valid: true, atMs: 450 });
  });
});
