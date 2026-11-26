import type { Confidence, Tier } from '@acme/contracts';
import type { ChatModel, Embedder } from '../llm/types';
import { embeddingUsageLine } from '../llm/pricing';
import type { SpanRecorder } from '../observability/tracer';
import { judgeAnswerability, type JudgeVerdict } from './answerability-judge';
import { applyJudgement, scoreRetrieval, type ConfidenceThresholds } from './confidence';
import type { KnowledgeBaseRepository, SearchHit } from './kb-repository';

export interface RetrievalOutcome {
  /** grounded → the model may answer from `hits`; insufficient → it must not answer. */
  status: 'grounded' | 'insufficient';
  inDomain: boolean | null;
  confidence: Confidence;
  /** Passages handed to the model (pruned to the verifier's supporting set when available). */
  hits: SearchHit[];
  /** Everything retrieved, for the observability drawer. */
  candidates: SearchHit[];
  judge: JudgeVerdict | null;
}

export interface KnowledgeServiceOptions {
  repo: KnowledgeBaseRepository;
  embedder: Embedder;
  judgeModel: ChatModel;
  judgeModelName: string;
  judgeEnabled: boolean;
  judgeReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  thresholds: ConfidenceThresholds;
  topK: number;
}

export class KnowledgeService {
  constructor(private readonly opts: KnowledgeServiceOptions) {}

  get thresholds(): ConfidenceThresholds {
    return this.opts.thresholds;
  }

  /**
   * Dual-query retrieval: the model's rewritten query AND the customer's own words are both
   * searched, and the best evidence per chunk wins. This makes the guardrail robust to a poor
   * query rewrite — a classic cause of false "I don't know" escalations.
   */
  async search(params: {
    query: string;
    userMessage: string | null;
    tier: Tier | null;
    signal: AbortSignal;
    recorder: SpanRecorder;
    parentSpanId: string | null;
  }): Promise<RetrievalOutcome> {
    const { recorder } = params;
    const queries = [params.query, params.userMessage]
      .map((q) => q?.trim())
      .filter((q, i, arr): q is string => Boolean(q) && arr.indexOf(q) === i)
      .slice(0, 2);

    const embedSpan = recorder.start('embedding', 'embed_query', { model: this.opts.embedder.model, queries }, params.parentSpanId);
    const { vectors, tokens } = await this.opts.embedder.embed(queries, params.signal);
    embedSpan.end({ usage: embeddingUsageLine(this.opts.embedder.model, tokens) });

    const searchSpan = recorder.start(
      'retrieval',
      'hybrid_search',
      { tier: params.tier ?? 'unverified (general docs only)', topK: this.opts.topK },
      params.parentSpanId,
    );
    const resultSets = await Promise.all(
      queries.map((q, i) =>
        this.opts.repo.hybridSearch({
          embedding: vectors[i]!,
          queryText: q,
          tier: params.tier,
          candidates: 12,
          limit: this.opts.topK + 2,
        }),
      ),
    );
    const candidates = mergeHits(resultSets).slice(0, this.opts.topK + 2);
    let confidence = scoreRetrieval(candidates, this.opts.thresholds);
    searchSpan.end({
      attributes: {
        confidence,
        candidates: candidates.map((h) => ({
          chunk: h.chunkId,
          section: h.headingPath.join(' › '),
          similarity: Number(h.similarity.toFixed(3)),
          vectorRank: h.vectorRank,
          lexicalRank: h.lexicalRank,
        })),
      },
    });

    let hits = candidates.slice(0, this.opts.topK);
    let judge: JudgeVerdict | null = null;
    const needsJudge = this.opts.judgeEnabled && confidence.band !== 'high' && candidates.length > 0;

    if (needsJudge) {
      const judgeSpan = recorder.start(
        'guardrail',
        'answerability_judge',
        { reason: confidence.band === 'medium' ? 'medium confidence — verify sources answer the question' : 'low confidence — classify domain' },
        params.parentSpanId,
      );
      try {
        judge = await judgeAnswerability({
          model: this.opts.judgeModel,
          modelName: this.opts.judgeModelName,
          question: params.userMessage ? `${params.userMessage}\n(search query: ${params.query})` : params.query,
          hits,
          signal: params.signal,
          span: judgeSpan,
          reasoningEffort: this.opts.judgeReasoningEffort,
        });
      } catch (err) {
        judgeSpan.fail(err);
        // Verifier unavailable: fail closed for medium band, keep low as low.
        judge = { inDomain: true, answerable: false, confidence: 0, supportingSources: [], rationale: 'Verifier unavailable.' };
      }
      if (confidence.band === 'medium') {
        confidence = applyJudgement(confidence, judge, this.opts.thresholds);
        if (judge.answerable && judge.supportingSources.length) {
          // Context pruning: hand the model only what the verifier says supports the answer.
          hits = judge.supportingSources.map((i) => hits[i - 1]!).filter(Boolean);
        }
      }
    }

    const grounded = confidence.band !== 'low';
    return {
      status: grounded ? 'grounded' : 'insufficient',
      inDomain: judge ? judge.inDomain : grounded ? true : null,
      confidence,
      hits: grounded ? hits : [],
      candidates,
      judge,
    };
  }
}

/** Union result sets, keeping each chunk's best similarity and summed fused score. */
function mergeHits(sets: SearchHit[][]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const set of sets) {
    for (const hit of set) {
      const prev = byId.get(hit.chunkId);
      if (!prev) byId.set(hit.chunkId, { ...hit });
      else {
        prev.similarity = Math.max(prev.similarity, hit.similarity);
        prev.rrf += hit.rrf;
        prev.vectorRank = minRank(prev.vectorRank, hit.vectorRank);
        prev.lexicalRank = minRank(prev.lexicalRank, hit.lexicalRank);
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.rrf - a.rrf || b.similarity - a.similarity);
}

const minRank = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);
