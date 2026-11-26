import type { Tier } from '@acme/contracts';
import { count, countDistinct, inArray, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/pool';
import { kbChunks, kbDocuments } from '../db/schema';
import type { Chunk, ParsedDocument } from './chunker';

export interface SearchHit {
  chunkId: string;
  docId: string;
  docTitle: string;
  headingPath: string[];
  content: string;
  tiers: Tier[];
  /** Cosine similarity in [−1, 1] (text-embedding-3 is effectively [0, 1]). */
  similarity: number;
  vectorRank: number | null;
  lexicalRank: number | null;
  rrf: number;
}

const RRF_K = 60;
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from has have how i if in is it me my of on or our so that the this to was we what when where which who why will with you your'.split(
    ' ',
  ),
);

/** OR-of-terms tsquery: natural-language questions rarely match every term (AND semantics). */
export function toLexicalQuery(text: string): string {
  const terms = [...new Set(text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])].filter((t) => !STOPWORDS.has(t));
  return terms.slice(0, 24).join(' | ');
}

const vectorLiteral = (v: readonly number[]) => `[${v.join(',')}]`;

export class KnowledgeBaseRepository {
  constructor(private readonly db: Database) {}

  async documentHashes(): Promise<Map<string, string>> {
    const rows = await this.db.select({ id: kbDocuments.id, hash: kbDocuments.contentHash }).from(kbDocuments);
    return new Map(rows.map((r) => [r.id, r.hash]));
  }

  /** Existing embeddings by content hash, so unchanged chunks are never re-embedded. */
  async embeddingsByHash(hashes: string[]): Promise<Map<string, number[]>> {
    if (!hashes.length) return new Map();
    const rows = await this.db
      .selectDistinctOn([kbChunks.contentHash], { hash: kbChunks.contentHash, embedding: kbChunks.embedding })
      .from(kbChunks)
      .where(inArray(kbChunks.contentHash, hashes));
    return new Map(rows.map((r) => [r.hash, r.embedding]));
  }

  async replaceDocument(doc: ParsedDocument, chunks: Array<Chunk & { embedding: number[] }>, embeddingModel: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(kbDocuments)
        .values({ id: doc.id, title: doc.title, category: doc.category, tiers: doc.tiers, contentHash: doc.contentHash })
        .onConflictDoUpdate({
          target: kbDocuments.id,
          set: {
            title: doc.title,
            category: doc.category,
            tiers: doc.tiers,
            contentHash: doc.contentHash,
            ingestedAt: sql`now()`,
          },
        });
      await tx.delete(kbChunks).where(sql`${kbChunks.docId} = ${doc.id}`);
      if (!chunks.length) return;
      await tx.insert(kbChunks).values(
        chunks.map((c) => ({
          id: c.id,
          docId: c.docId,
          ordinal: c.ordinal,
          headingPath: c.headingPath,
          headingText: [doc.title, ...c.headingPath].join(' '),
          content: c.content,
          embeddingInput: c.embeddingInput,
          tiers: c.tiers,
          tokenCount: c.tokenCount,
          contentHash: c.contentHash,
          embeddingModel,
          embedding: c.embedding,
        })),
      );
    });
  }

  async deleteDocumentsNotIn(ids: string[]): Promise<number> {
    const deleted = await this.db
      .delete(kbDocuments)
      .where(ids.length ? notInArray(kbDocuments.id, ids) : undefined)
      .returning({ id: kbDocuments.id });
    return deleted.length;
  }

  async stats(): Promise<{ documents: number; chunks: number; embeddingModels: string[] }> {
    const [docs] = await this.db.select({ n: count() }).from(kbDocuments);
    const [chunks] = await this.db.select({ n: count(), models: countDistinct(kbChunks.embeddingModel) }).from(kbChunks);
    const models = await this.db.selectDistinct({ model: kbChunks.embeddingModel }).from(kbChunks);
    return { documents: docs?.n ?? 0, chunks: chunks?.n ?? 0, embeddingModels: models.map((m) => m.model) };
  }

  /**
   * Hybrid retrieval: dense (pgvector cosine, HNSW) ∪ sparse (Postgres FTS), fused with
   * Reciprocal Rank Fusion. Tier scoping happens *in SQL*, using the server-side verified tier —
   * never a value supplied by the model. Unverified sessions (tier = null) only see chunks that
   * apply to every tier.
   */
  async hybridSearch(params: {
    embedding: number[];
    queryText: string;
    tier: Tier | null;
    candidates: number;
    limit: number;
  }): Promise<SearchHit[]> {
    const lexical = toLexicalQuery(params.queryText);
    const qv = sql`${vectorLiteral(params.embedding)}::vector`;
    const tierScope = sql`(cardinality(${kbChunks.tiers}) = 0 OR ${params.tier}::text = ANY(${kbChunks.tiers}))`;
    const tq = sql`to_tsquery('english', ${lexical})`;
    const rrfK = sql.raw(String(RRF_K));

    const lexCte = lexical
      ? sql`SELECT ${kbChunks.id} AS id, row_number() OVER (ORDER BY ts_rank_cd(${kbChunks.tsv}, ${tq}) DESC) AS rnk
              FROM ${kbChunks}
             WHERE ${kbChunks.tsv} @@ ${tq} AND ${tierScope}
             ORDER BY ts_rank_cd(${kbChunks.tsv}, ${tq}) DESC
             LIMIT ${params.candidates}`
      : sql`SELECT NULL::text AS id, NULL::bigint AS rnk WHERE false`;

    const result = await this.db.execute<{
      id: string;
      doc_id: string;
      doc_title: string;
      heading_path: string[];
      content: string;
      tiers: Tier[];
      similarity: number;
      vec_rank: string | null;
      lex_rank: string | null;
      rrf: number;
    }>(sql`
      WITH vec AS (
        SELECT ${kbChunks.id} AS id, row_number() OVER (ORDER BY ${kbChunks.embedding} <=> ${qv}) AS rnk
          FROM ${kbChunks}
         WHERE ${tierScope}
         ORDER BY ${kbChunks.embedding} <=> ${qv}
         LIMIT ${params.candidates}
      ),
      lex AS (${lexCte})
      SELECT c.id, c.doc_id, d.title AS doc_title, c.heading_path, c.content, c.tiers,
             (1 - (c.embedding <=> ${qv}))::float8 AS similarity,
             vec.rnk AS vec_rank, lex.rnk AS lex_rank,
             (COALESCE(1.0 / (${rrfK} + vec.rnk), 0) + COALESCE(1.0 / (${rrfK} + lex.rnk), 0))::float8 AS rrf
        FROM (SELECT id FROM vec UNION SELECT id FROM lex) ids
        JOIN kb_chunks c ON c.id = ids.id
        JOIN kb_documents d ON d.id = c.doc_id
        LEFT JOIN vec ON vec.id = c.id
        LEFT JOIN lex ON lex.id = c.id
       ORDER BY rrf DESC, similarity DESC
       LIMIT ${params.limit}`);

    return result.rows.map((r) => ({
      chunkId: r.id,
      docId: r.doc_id,
      docTitle: r.doc_title,
      headingPath: r.heading_path,
      content: r.content,
      tiers: r.tiers,
      similarity: Number(r.similarity),
      vectorRank: r.vec_rank === null ? null : Number(r.vec_rank),
      lexicalRank: r.lex_rank === null ? null : Number(r.lex_rank),
      rrf: Number(r.rrf),
    }));
  }
}
