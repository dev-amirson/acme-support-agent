import type { UsageLine } from '@acme/contracts';
import type { TokenUsage } from './types';

/**
 * Estimated list prices (USD). Verified against developers.openai.com/pricing on 2026-11-26.
 * Costs shown in the UI are estimates — the provider's invoice is the source of truth.
 */
interface TokenPrice {
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
}

const CHAT_PRICES: Record<string, TokenPrice> = {
  'gpt-5.4-mini': { inputPerM: 0.75, cachedInputPerM: 0.075, outputPerM: 4.5 },
  'gpt-4.1-mini': { inputPerM: 0.4, cachedInputPerM: 0.1, outputPerM: 1.6 },
  'gpt-4.1': { inputPerM: 2.0, cachedInputPerM: 0.5, outputPerM: 8.0 },
  'gpt-4o-mini': { inputPerM: 0.15, cachedInputPerM: 0.075, outputPerM: 0.6 },
  'fake-chat': { inputPerM: 0, cachedInputPerM: 0, outputPerM: 0 },
};

const EMBEDDING_PRICES_PER_M: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'fake-hash-embedding': 0,
};

/** Streaming / committed transcription is billed by audio duration. */
const TRANSCRIPTION_PER_MINUTE: Record<string, number> = {
  'gpt-live-transcribe': 0.017,
  'gpt-realtime-whisper': 0.017,
  'gpt-transcribe': 0.0045,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
};

/** gpt-4o-mini-tts is token-billed ($0.60/M text in, $12/M audio out) ≈ $0.015 per audio minute. */
const TTS_PER_AUDIO_MINUTE: Record<string, number> = {
  'gpt-4o-mini-tts': 0.015,
  'gpt-4o-mini-tts-2025-12-15': 0.015,
};

const warned = new Set<string>();
function lookup<T>(table: Record<string, T>, model: string): T | undefined {
  if (table[model]) return table[model];
  // Dated snapshots ("gpt-4.1-mini-2025-04-14") price like their alias.
  const alias = Object.keys(table)
    .filter((k) => model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (alias) return table[alias];
  if (!warned.has(model)) {
    warned.add(model);
    console.warn(`[pricing] no price configured for model "${model}" — cost reported as $0`);
  }
  return undefined;
}

const round = (usd: number) => Math.round(usd * 1e8) / 1e8;

export function chatUsageLine(model: string, usage: TokenUsage): UsageLine {
  const price = lookup(CHAT_PRICES, model);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost = price
    ? (uncached * price.inputPerM +
        usage.cachedInputTokens * price.cachedInputPerM +
        usage.outputTokens * price.outputPerM) /
      1e6
    : 0;
  return {
    kind: 'llm',
    model,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    costUsd: round(cost),
  };
}

export function embeddingUsageLine(model: string, tokens: number): UsageLine {
  const perM = lookup(EMBEDDING_PRICES_PER_M, model) ?? 0;
  return { kind: 'embedding', model, inputTokens: tokens, costUsd: round((tokens * perM) / 1e6) };
}

export function transcriptionUsageLine(model: string, audioSeconds: number): UsageLine {
  const perMin = lookup(TRANSCRIPTION_PER_MINUTE, model) ?? 0;
  return { kind: 'stt', model, audioSeconds, costUsd: round((audioSeconds / 60) * perMin) };
}

export function ttsUsageLine(model: string, audioSeconds: number, characters: number): UsageLine {
  const perMin = lookup(TTS_PER_AUDIO_MINUTE, model) ?? 0;
  return {
    kind: 'tts',
    model,
    audioSeconds,
    characters,
    costUsd: round((audioSeconds / 60) * perMin),
  };
}

export function sumCost(lines: readonly UsageLine[]): number {
  return round(lines.reduce((acc, l) => acc + l.costUsd, 0));
}
