import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { classifyUpstreamError } from '../lib/errors';
import { retry } from '../lib/async';
import type { Embedder, EmbeddingResult } from './types';

const BATCH_SIZE = 96;

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const res = await retry(
        async () => {
          try {
            return await this.client.embeddings.create(
              { model: this.model, input: batch, dimensions: this.dimensions },
              { signal },
            );
          } catch (err) {
            throw classifyUpstreamError(err, 'Embedding service');
          }
        },
        { attempts: 3, signal },
      );
      // The API returns items with an index; never assume order.
      const ordered = [...res.data].sort((a, b) => a.index - b.index);
      vectors.push(...ordered.map((d) => d.embedding));
      tokens += res.usage.total_tokens;
    }
    return { vectors, tokens };
  }
}

/**
 * Offline embedder: signed feature hashing over word unigrams + bigrams, L2-normalised.
 * Captures lexical overlap (good enough for tests / CI / offline demos), not semantics.
 */
export class HashEmbedder implements Embedder {
  readonly model = 'fake-hash-embedding';
  constructor(readonly dimensions: number) {}

  embed(texts: string[]): Promise<EmbeddingResult> {
    return Promise.resolve({
      vectors: texts.map((t) => this.vectorFor(t)),
      tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
    });
  }

  private vectorFor(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const features = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
    for (const f of features) {
      const h = createHash('md5').update(f).digest();
      const idx = h.readUInt32LE(0) % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + ((h[4] ?? 0) & 1 ? 1 : -1);
    }
    const norm = Math.hypot(...vec) || 1;
    return Array.from(vec, (v) => v / norm);
  }
}
