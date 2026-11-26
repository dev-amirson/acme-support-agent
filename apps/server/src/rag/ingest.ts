import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Embedder } from '../llm/types';
import { chunkDocument, parseDocument } from './chunker';
import type { KnowledgeBaseRepository } from './kb-repository';

export interface IngestReport {
  documents: number;
  unchanged: number;
  chunks: number;
  embedded: number;
  reusedEmbeddings: number;
  removed: number;
  embeddingTokens: number;
  durationMs: number;
}

/**
 * Idempotent, incremental ingestion:
 *  - documents whose file hash is unchanged are skipped entirely;
 *  - within changed documents, chunks whose content hash already exists reuse their embedding;
 *  - documents deleted from disk are removed from the index.
 * Safe to run on every boot (which the free hosting tier requires — there is no release job).
 */
export async function ingestKnowledgeBase(opts: {
  dir: string;
  repo: KnowledgeBaseRepository;
  embedder: Embedder;
  force?: boolean;
  log?: (msg: string) => void;
}): Promise<IngestReport> {
  const started = performance.now();
  const log = opts.log ?? (() => undefined);
  const files = (await readdir(opts.dir)).filter((f) => f.endsWith('.md')).sort();
  // Vectors from different models live in different spaces — a model change forces a rebuild.
  const { embeddingModels } = await opts.repo.stats();
  const modelChanged = embeddingModels.some((m) => m !== opts.embedder.model);
  if (modelChanged) log(`embedding model changed (${embeddingModels.join(', ')} → ${opts.embedder.model}); re-embedding`);
  const known = opts.force || modelChanged ? new Map<string, string>() : await opts.repo.documentHashes();
  const report: IngestReport = {
    documents: files.length,
    unchanged: 0,
    chunks: 0,
    embedded: 0,
    reusedEmbeddings: 0,
    removed: 0,
    embeddingTokens: 0,
    durationMs: 0,
  };
  const ids: string[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(opts.dir, file), 'utf8');
    const doc = parseDocument(raw, file.replace(/\.md$/, ''));
    ids.push(doc.id);
    if (known.get(doc.id) === doc.contentHash) {
      report.unchanged++;
      continue;
    }
    const chunks = chunkDocument(doc, opts.embedder.model);
    const existing = await opts.repo.embeddingsByHash(chunks.map((c) => c.contentHash));
    const missing = chunks.filter((c) => !existing.has(c.contentHash));
    const fresh = missing.length
      ? await opts.embedder.embed(missing.map((c) => c.embeddingInput))
      : { vectors: [], tokens: 0 };
    const freshByHash = new Map(missing.map((c, i) => [c.contentHash, fresh.vectors[i]!]));

    await opts.repo.replaceDocument(
      doc,
      chunks.map((c) => ({ ...c, embedding: existing.get(c.contentHash) ?? freshByHash.get(c.contentHash)! })),
      opts.embedder.model,
    );
    report.chunks += chunks.length;
    report.embedded += missing.length;
    report.reusedEmbeddings += chunks.length - missing.length;
    report.embeddingTokens += fresh.tokens;
    log(`ingested ${doc.id}: ${chunks.length} chunks (${missing.length} embedded)`);
  }
  report.removed = await opts.repo.deleteDocumentsNotIn(ids);
  report.durationMs = Math.round(performance.now() - started);
  return report;
}
