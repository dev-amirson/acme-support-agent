/* global sampleRate, registerProcessor, AudioWorkletProcessor */
/**
 * Microphone capture on the audio thread: device rate (44.1/48 kHz) → 24 kHz mono PCM16,
 * posted to the main thread in 40 ms frames (small frames = faster server-side VAD decisions).
 *
 * Resampling is linear interpolation with a 2-tap pre-filter; speech energy sits well below the
 * 12 kHz Nyquist of the target rate, and the browser's noise suppression has already run.
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const target = (options && options.processorOptions && options.processorOptions.targetRate) || 24000;
    this.ratio = sampleRate / target;
    this.frameSamples = Math.round(target * 0.04);
    this.out = new Int16Array(this.frameSamples);
    this.outIndex = 0;
    this.t = 0; // fractional read position; -1 ≤ t < 0 refers to `last`
    this.last = 0;
    this.prevRaw = 0;
  }

  push(sample) {
    const s = Math.max(-1, Math.min(1, sample));
    this.out[this.outIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this.outIndex === this.frameSamples) {
      this.port.postMessage(this.out.buffer, [this.out.buffer]);
      this.out = new Int16Array(this.frameSamples);
      this.outIndex = 0;
    }
  }

  process(inputs) {
    const raw = inputs[0] && inputs[0][0];
    if (!raw || raw.length === 0) return true;
    // 2-tap low-pass (moving average) to tame aliasing before decimation.
    const ch = new Float32Array(raw.length);
    let prev = this.prevRaw;
    for (let i = 0; i < raw.length; i++) {
      ch[i] = (raw[i] + prev) * 0.5;
      prev = raw[i];
    }
    this.prevRaw = prev;

    const n = ch.length;
    let t = this.t;
    while (t < n - 1) {
      const i = Math.floor(t);
      const f = t - i;
      const s0 = i < 0 ? this.last : ch[i];
      const s1 = ch[i + 1];
      this.push(s0 + (s1 - s0) * f);
      t += this.ratio;
    }
    this.t = t - n;
    this.last = ch[n - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
