'use client';

import { useEffect, useRef } from 'react';
import type { VoiceAnalysers } from '@/lib/voice/voice-client';

const BARS = 48;

/**
 * Dual waveform: the customer's mic (info blue) and the agent's voice (brand lime) are drawn on the same
 * baseline, so talking over the agent — and the agent ducking — is visible at a glance.
 */
export function Waveform({ analysers, active }: { analysers: VoiceAnalysers | null; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const micColor = css.getPropertyValue('--color-info').trim() || '#0288d1';
    const outColor = css.getPropertyValue('--color-brand-hover').trim() || '#98af24';
    const idleColor = css.getPropertyValue('--color-border-subtle').trim() || '#e3e3de';
    const micBins = new Uint8Array(analysers?.mic.frequencyBinCount ?? 512);
    const outBins = new Uint8Array(analysers?.output.frequencyBinCount ?? 512);
    const micLevels = new Float32Array(BARS);
    const outLevels = new Float32Array(BARS);
    let frame = 0;
    let t = 0;

    const levels = (bins: Uint8Array, into: Float32Array) => {
      // Speech energy lives in the low bins; use the bottom ~40% of the spectrum.
      const usable = Math.floor(bins.length * 0.4);
      const per = Math.max(1, Math.floor(usable / BARS));
      for (let b = 0; b < BARS; b++) {
        let sum = 0;
        for (let i = 0; i < per; i++) sum += bins[b * per + i] ?? 0;
        const v = sum / per / 255;
        into[b] = (into[b] ?? 0) * 0.7 + v * 0.3; // temporal smoothing
      }
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== w * dpr) {
        el.width = w * dpr;
        el.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      t += 0.04;
      if (analysers) {
        analysers.mic.getByteFrequencyData(micBins);
        analysers.output.getByteFrequencyData(outBins);
        levels(micBins, micLevels);
        levels(outBins, outLevels);
      }
      const gap = 3;
      const bw = (w - gap * (BARS - 1)) / BARS;
      const mid = h / 2;
      for (let b = 0; b < BARS; b++) {
        // Mirror around the centre so it reads as a voice "shape", not a spectrum analyser.
        const idx = Math.abs(b - (BARS - 1) / 2) / ((BARS - 1) / 2);
        const src = Math.floor(idx * (BARS - 1));
        const breathe = active ? 0.04 + 0.03 * Math.sin(t + b * 0.35) : 0.02;
        const out = Math.max(breathe, (outLevels[src] ?? 0) * 1.4);
        const mic = (micLevels[src] ?? 0) * 1.4;
        const x = b * (bw + gap);
        const outH = Math.min(h, out * h);
        ctx.fillStyle = out > 0.08 ? outColor : idleColor;
        ctx.globalAlpha = 0.9;
        roundRect(ctx, x, mid - outH / 2, bw, Math.max(2, outH), bw / 2);
        if (mic > 0.05) {
          const micH = Math.min(h, mic * h);
          ctx.fillStyle = micColor;
          ctx.globalAlpha = 0.75;
          roundRect(ctx, x + bw * 0.2, mid - micH / 2, bw * 0.6, micH, bw / 3);
        }
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analysers, active]);

  return <canvas ref={canvas} className="h-16 w-full" aria-hidden />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, h / 2));
  ctx.fill();
}
