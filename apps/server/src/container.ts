import type { AppConfig } from './config';
import { AgentOrchestrator } from './agent/orchestrator';
import { createDatabase, type Database, type DatabaseHandle } from './db/pool';
import type pg from 'pg';
import { CrmRepository } from './domain/crm-repository';
import type { Logger } from './lib/logger';
import { createProviders, type ModelProviders } from './llm/providers';
import { BudgetGuard } from './observability/budget';
import { KnowledgeBaseRepository } from './rag/kb-repository';
import { KnowledgeService } from './rag/knowledge-service';
import { SessionRepository } from './session/session-repository';
import { SessionService } from './session/session-service';
import { createToolRegistry, type ToolRegistry } from './tools/registry';
import { ToolRunner } from './tools/runner';

/**
 * Composition root. Every dependency is constructed here and passed explicitly — no service
 * locator, no module-level singletons — so tests can assemble the same graph with fakes.
 */
export interface Container {
  config: AppConfig;
  log: Logger;
  db: Database;
  pool: pg.Pool;
  providers: ModelProviders;
  kbRepo: KnowledgeBaseRepository;
  knowledge: KnowledgeService;
  crm: CrmRepository;
  sessions: SessionService;
  registry: ToolRegistry;
  budget: BudgetGuard;
  orchestrator: AgentOrchestrator;
  /** Knowledge-base ingestion state, surfaced by the readiness probe. */
  ingestion: { status: 'pending' | 'ready' | 'failed'; error?: string };
}

export function createContainer(config: AppConfig, log: Logger, overrides: { database?: DatabaseHandle; providers?: ModelProviders } = {}): Container {
  const { env } = config;
  const { db, pool } = overrides.database ?? createDatabase(config);
  const providers = overrides.providers ?? createProviders(config);
  const kbRepo = new KnowledgeBaseRepository(db);
  const knowledge = new KnowledgeService({
    repo: kbRepo,
    embedder: providers.embedder,
    judgeModel: providers.chat,
    judgeModelName: env.AI_PROVIDER === 'fake' ? providers.chat.defaultModel : env.OPENAI_JUDGE_MODEL,
    judgeEnabled: env.RAG_JUDGE_ENABLED,
    judgeReasoningEffort: env.OPENAI_JUDGE_REASONING_EFFORT,
    topK: env.RAG_TOP_K,
    thresholds: {
      minSimilarity: env.RAG_MIN_SIMILARITY,
      similarityCeiling: env.RAG_SIMILARITY_CEILING,
      high: env.RAG_HIGH_CONFIDENCE,
      low: env.RAG_LOW_CONFIDENCE,
    },
  });
  const crm = new CrmRepository(db);
  const sessionRepo = new SessionRepository(db);
  const sessions = new SessionService(sessionRepo, crm);
  const registry = createToolRegistry({ crm, knowledge });
  const runner = new ToolRunner(registry, { timeoutMs: env.TOOL_TIMEOUT_MS, maxAttempts: env.TOOL_MAX_ATTEMPTS });
  const budget = new BudgetGuard(sessionRepo, env.DAILY_BUDGET_USD);
  const orchestrator = new AgentOrchestrator({
    config,
    db,
    chat: providers.chat,
    registry,
    runner,
    sessions,
    knowledge,
    budget,
    log,
  });
  return { config, log, db, pool, providers, kbRepo, knowledge, crm, sessions, registry, budget, orchestrator, ingestion: { status: config.env.AUTO_INGEST ? 'pending' : 'ready' } };
}
