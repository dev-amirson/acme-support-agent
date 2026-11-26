import { Router } from 'express';
import { chatRequestSchema, chaosConfigSchema, TOOL_NAMES, type CreateSessionResponse, type PublicConfig } from '@acme/contracts';
import type { Container } from '../container';
import { DEMO_SCENARIOS } from '../domain/crm-fixtures';
import { AppError, userFacingMessage } from '../lib/errors';
import { limiter } from './rate-limit';
import { SseStream } from './sse';

export function createApiRouter(c: Container): Router {
  const { env } = c.config;
  const router = Router();

  router.get('/ready', async (_req, res) => {
    try {
      await c.pool.query('SELECT 1');
      const kb = await c.kbRepo.stats();
      const ready = c.ingestion.status === 'ready' && kb.chunks > 0;
      res.status(ready ? 200 : 503).json({ ok: ready, db: true, ingestion: c.ingestion, knowledgeBase: kb, budget: await c.budget.status() });
    } catch (err) {
      res.status(503).json({ ok: false, db: false, error: (err as Error).message });
    }
  });

  router.get('/config', (_req, res) => {
    const body: PublicConfig = {
      voiceEnabled: env.AI_PROVIDER === 'openai',
      chaosEnabled: env.ENABLE_CHAOS,
      offlineMode: env.AI_PROVIDER === 'fake',
      models: {
        chat: env.AI_PROVIDER === 'fake' ? 'fake-chat' : env.OPENAI_CHAT_MODEL,
        embedding: c.providers.embedder.model,
        transcription: env.OPENAI_TRANSCRIBE_MODEL,
        tts: env.OPENAI_TTS_MODEL,
      },
      guardrails: { highConfidence: env.RAG_HIGH_CONFIDENCE, lowConfidence: env.RAG_LOW_CONFIDENCE, minSimilarity: env.RAG_MIN_SIMILARITY },
      demoAccounts: DEMO_SCENARIOS,
      tools: [...TOOL_NAMES],
    };
    res.json(body);
  });

  router.post('/sessions', limiter({ windowMs: 3_600_000, limit: env.RATE_LIMIT_SESSIONS_PER_HOUR }), async (_req, res) => {
    const s = await c.sessions.create();
    const body: CreateSessionResponse = { sessionId: s.id, createdAt: s.createdAt.toISOString() };
    res.status(201).json(body);
  });

  router.get('/sessions/:id', async (req, res) => {
    res.json(await c.sessions.snapshot(req.params.id));
  });

  router.put('/sessions/:id/chaos', async (req, res) => {
    if (!env.ENABLE_CHAOS) throw new AppError('VALIDATION', 'Failure injection is disabled on this deployment');
    const chaos = chaosConfigSchema.parse(req.body);
    res.json({ chaos: await c.sessions.setChaos(req.params.id, chaos) });
  });

  router.post('/sessions/:id/abort', (req, res) => {
    res.json({ aborted: c.sessions.abortTurn(req.params.id) });
  });

  /**
   * Chat turn over SSE. Validation, session lookup and rate limiting happen before the stream
   * opens (real HTTP status codes); anything after that is reported in-band as an `error` event.
   * Closing the tab aborts the turn, so an abandoned request stops spending tokens.
   */
  router.post('/sessions/:id/messages', limiter({ windowMs: 60_000, limit: env.RATE_LIMIT_CHAT_PER_MIN }), async (req, res) => {
    const body = chatRequestSchema.parse(req.body);
    const sessionId = String(req.params.id);
    await c.sessions.require(sessionId);

    const sse = new SseStream(res);
    const controller = new AbortController();
    sse.onClientGone(() => controller.abort());
    try {
      await c.orchestrator.runTurn({
        sessionId,
        text: body.message,
        mode: 'text',
        clientTurnId: body.clientTurnId,
        signal: controller.signal,
        emit: (e) => sse.send(e),
      });
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('INTERNAL', (err as Error).message, { cause: err });
      if (e.code === 'INTERNAL') req.log.error({ err }, 'chat turn crashed');
      sse.send({ type: 'error', code: e.code, message: e.code === 'VALIDATION' ? e.message : userFacingMessage(e.code), retryable: e.retryable });
    } finally {
      sse.end();
    }
  });

  return router;
}
