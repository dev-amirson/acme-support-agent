/**
 * Orchestrator integration suite: the real object graph (Postgres + pgvector, repositories, tools,
 * guardrails, persistence) driven by a scripted model. Runs against a dedicated `acme_support_test`
 * database on the project's local Postgres (port 5433); skipped if that database is unreachable.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, AgentEventOf, AgentEventType, ConversationMode } from '@acme/contracts';
import { asc, eq } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { escalationAddendum, lowConfidenceEscalation } from '../src/agent/escalation-messages';
import { loadConfig } from '../src/config';
import { createContainer, type Container } from '../src/container';
import { migrate } from '../src/db/migrate';
import { createDatabase, type DatabaseHandle } from '../src/db/pool';
import { EMBEDDING_DIMENSIONS, kbChunks, messages, refunds, sessions, tickets, traces } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import type { Logger } from '../src/lib/logger';
import { HashEmbedder } from '../src/llm/embedders';
import { ScriptedChatModel, type ChatScript, type ScriptedResponse } from '../src/llm/fake-chat';
import type { ChatRequest } from '../src/llm/types';
import { ingestKnowledgeBase } from '../src/rag/ingest';
import type { RetrievalOutcome } from '../src/rag/knowledge-service';

// ---------------------------------------------------------------------------------------------
// Test database: a separate DB on the project's Postgres. Never port 5432, never `acme_support`.
// ---------------------------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://acme:acme@localhost:5433/acme_support_test';

async function ensureTestDatabase(): Promise<boolean> {
  const target = new URL(TEST_DB_URL);
  const dbName = target.pathname.slice(1);
  if (target.port === '5432' || dbName === 'acme_support' || !/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing to run integration tests against ${target.host}/${dbName}`);
  }
  const admin = new URL(TEST_DB_URL);
  admin.pathname = '/acme_support';
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!existing.rowCount) await client.query(`CREATE DATABASE "${dbName}"`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '42P04') return true; // created concurrently
    console.warn(`[orchestrator.int] test database unavailable — skipping: ${(err as Error).message}`);
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const dbAvailable = await ensureTestDatabase();

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRIMARY_MODEL = 'fake-chat';
const FALLBACK_MODEL = 'fake-chat-fallback';

const silentLogger: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/** The answerability judge shares the chat model; tests that don't care get a fixed verdict. */
const JUDGE_VERDICT = { in_domain: true, answerable: false, confidence: 0.1, supporting_sources: [] as number[], rationale: 'test verdict' };
const UNEXPECTED = 'UNEXPECTED EXTRA MODEL CALL';

type Step = ScriptedResponse | ((req: ChatRequest) => ScriptedResponse);

let script: ChatScript = () => ({ text: 'script not set' });
const chat = new ScriptedChatModel((req, i) => script(req, i));
const embedder = new HashEmbedder(EMBEDDING_DIMENSIONS);

/** Script the agent's reasoning calls in order (judge calls are answered separately). */
function scriptAgent(steps: Step[], judge = JUDGE_VERDICT): void {
  chat.calls = [];
  let i = 0;
  script = (req) => {
    if (req.responseFormat) return { text: JSON.stringify(judge) };
    const step = steps[i++];
    if (!step) return { text: UNEXPECTED };
    return typeof step === 'function' ? step(req) : step;
  };
}

const agentCalls = () => chat.calls.filter((c) => !c.responseFormat);

/** Tool results visible to the model in a request, joined to the tool name that produced them. */
function toolResults(req: ChatRequest): Array<{ name: string; payload: Record<string, any> }> {
  const names = new Map<string, string>();
  for (const m of req.messages) if (m.role === 'assistant') for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
  return req.messages.flatMap((m) => (m.role === 'tool' ? [{ name: names.get(m.toolCallId) ?? '?', payload: JSON.parse(m.content) }] : []));
}
const resultOf = (req: ChatRequest, name: string) => toolResults(req).findLast((r) => r.name === name)?.payload;

const ofType = <T extends AgentEventType>(events: AgentEvent[], type: T) =>
  events.filter((e): e is AgentEventOf<T> => e.type === type);
const one = <T extends AgentEventType>(events: AgentEvent[], type: T) => {
  const found = ofType(events, type);
  expect(found, `exactly one ${type} event`).toHaveLength(1);
  return found[0]!;
};

describe.skipIf(!dbAvailable)('AgentOrchestrator (integration, Postgres + scripted model)', () => {
  let database: DatabaseHandle;
  let container: Container;

  beforeAll(async () => {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DB_URL,
      DATABASE_SSL: 'disable',
      AI_PROVIDER: 'fake',
      OPENAI_FALLBACK_CHAT_MODEL: FALLBACK_MODEL,
      LLM_MAX_RETRIES: '1',
      LLM_FIRST_TOKEN_TIMEOUT_MS: '5000',
      TOOL_MAX_ATTEMPTS: '2',
      RAG_JUDGE_ENABLED: 'true',
      ENABLE_CHAOS: 'true',
      DAILY_BUDGET_USD: '0',
      LOG_LEVEL: 'error',
      KB_DIR: path.join(ROOT, 'knowledge-base'),
      MIGRATIONS_DIR: path.join(ROOT, 'apps/server/drizzle'),
    });
    database = createDatabase(config);
    await migrate(database.pool, config, silentLogger);
    // Isolated test DB: start every run from a clean conversation state.
    await database.pool.query('TRUNCATE sessions, usage_events CASCADE');
    container = createContainer(config, silentLogger, { database, providers: { openai: null, chat, embedder } });
    await ingestKnowledgeBase({ dir: config.env.KB_DIR, repo: container.kbRepo, embedder });
  }, 60_000);

  afterAll(async () => {
    await database?.pool.end();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    scriptAgent([]);
  });

  async function newSession() {
    return (await container.sessions.create()).id;
  }

  async function turn(
    sessionId: string,
    text: string,
    opts: { mode?: ConversationMode; signal?: AbortSignal; preempt?: boolean; clientTurnId?: string; onEvent?: (e: AgentEvent) => void } = {},
  ) {
    const events: AgentEvent[] = [];
    const result = await container.orchestrator.runTurn({
      sessionId,
      text,
      mode: opts.mode ?? 'text',
      signal: opts.signal,
      preempt: opts.preempt,
      clientTurnId: opts.clientTurnId,
      emit: (e) => {
        events.push(e);
        opts.onEvent?.(e);
      },
    });
    return { result, events };
  }

  const storedMessages = (sessionId: string) =>
    container.db.select().from(messages).where(eq(messages.sessionId, sessionId)).orderBy(asc(messages.seq));
  const storedSession = async (sessionId: string) => (await container.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0]!;
  const storedTickets = (sessionId: string) => container.db.select().from(tickets).where(eq(tickets.sessionId, sessionId));
  const storedRefunds = (sessionId: string) => container.db.select().from(refunds).where(eq(refunds.sessionId, sessionId));
  const storedTrace = async (turnId: string) => (await container.db.select().from(traces).where(eq(traces.turnId, turnId)))[0];

  /** Compact view of the persisted log: role, visibility and tool names. */
  const shape = (rows: Awaited<ReturnType<typeof storedMessages>>) =>
    rows.map((m) => [m.role, m.visible ? 'visible' : 'hidden', m.toolName ?? m.toolCalls?.map((c) => c.name).join('+') ?? null]);

  // -------------------------------------------------------------------------------------------

  it('ingested the knowledge base and re-ingestion is a no-op', async () => {
    const stats = await container.kbRepo.stats();
    expect(stats.documents).toBe(10);
    expect(stats.chunks).toBeGreaterThan(50);
    expect(stats.embeddingModels).toEqual([embedder.model]);
    const again = await ingestKnowledgeBase({ dir: container.config.env.KB_DIR, repo: container.kbRepo, embedder });
    expect(again).toMatchObject({ documents: 10, unchanged: 10, embedded: 0, removed: 0 });
  });

  it('hybrid search scopes chunks by the verified tier in SQL', async () => {
    const query = 'enterprise refund approval limit account manager';
    const [embedding] = (await embedder.embed([query])).vectors;
    const search = (tier: 'pro' | 'enterprise' | null) =>
      container.kbRepo.hybridSearch({ embedding: embedding!, queryText: query, tier, candidates: 40, limit: 40 });

    const unverified = await search(null);
    expect(unverified.length).toBeGreaterThan(0);
    expect(unverified.every((h) => h.tiers.length === 0)).toBe(true);

    const enterprise = await search('enterprise');
    expect(enterprise.some((h) => h.tiers.includes('enterprise'))).toBe(true);
    expect(enterprise.every((h) => h.tiers.length === 0 || h.tiers.includes('enterprise'))).toBe(true);

    const pro = await search('pro');
    expect(pro.every((h) => h.tiers.length === 0 || h.tiers.includes('pro'))).toBe(true);
  });

  it('verify → billing → refund chain: refund persisted, hidden tool messages stored, session verified', async () => {
    const sessionId = await newSession();
    const finalText = (r: Record<string, any>) =>
      `Done — I've refunded $${r.amount_usd.toFixed(2)} for the duplicate charge on ${r.invoice_id} (refund ${r.refund_id}). It will arrive in 5–10 business days.`;
    scriptAgent([
      {
        toolCalls: [
          { name: 'verify_customer_identity', args: { account_id: 'AC-1001', email: null, zip_code: '94107' } },
          { name: 'get_billing_history', args: { limit: null } },
        ],
      },
      (req) => {
        const dup = (resultOf(req, 'get_billing_history')?.invoices as Array<Record<string, any>> | undefined)?.find((i) => i.duplicate_of);
        if (!dup) return { text: 'NO DUPLICATE FOUND IN BILLING HISTORY' };
        return { toolCalls: [{ name: 'issue_refund', args: { invoice_id: dup.invoice_id, amount_usd: dup.amount_usd, reason: 'duplicate_charge' } }] };
      },
      (req) => ({ text: finalText(resultOf(req, 'issue_refund')!) }),
    ]);

    const { result, events } = await turn(sessionId, "Hi, I'm Alice — account AC-1001, ZIP 94107. I was charged twice this month, please refund the duplicate.");

    // Model saw the right data at each step.
    const calls = agentCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]!.messages[0]!.content).toContain('Customer identity: NOT verified yet.');
    expect(calls[1]!.messages[0]!.content).toContain('Verified customer: Alice Chen (AC-1001)');
    expect(resultOf(calls[1]!, 'verify_customer_identity')).toMatchObject({ verified: true, customer: { id: 'AC-1001', tier: 'pro' } });
    const refundResult = resultOf(calls[2]!, 'issue_refund')!;
    expect(refundResult).toMatchObject({ status: 'refunded', invoice_id: 'INV-1001-04', amount_usd: 49, reason: 'duplicate_charge', replayed: false });

    // Events.
    expect(result.status).toBe('ok');
    // (the root trace span is opened just before turn.started; every other event follows it)
    expect(events.filter((e) => e.type !== 'trace.span')[0]!.type).toBe('turn.started');
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'ok', metrics: { llmCalls: 3, toolCalls: 3 } });
    const toolSteps = ofType(events, 'step.started').filter((s) => s.kind === 'tool');
    expect(toolSteps.map((s) => s.name)).toEqual(['verify_customer_identity', 'get_billing_history', 'issue_refund']);
    const completedTools = ofType(events, 'step.completed').filter((c) => toolSteps.some((s) => s.stepId === c.stepId));
    expect(completedTools.map((c) => c.status)).toEqual(['ok', 'ok', 'ok']);
    expect(ofType(events, 'session.updated').at(-1)).toMatchObject({ customer: { id: 'AC-1001', tier: 'pro' }, status: 'active' });
    expect(ofType(events, 'escalation.created')).toEqual([]);

    const completed = one(events, 'message.completed');
    expect(completed.text).toBe(finalText(refundResult));
    expect(completed.interrupted).toBe(false);
    expect(completed.grounding).toMatchObject({ passed: true, unsupportedClaims: [] });
    expect(completed.grounding!.checkedClaims).toBeGreaterThanOrEqual(2); // $49.00, 5–10 business days
    expect(completed.confidence).toMatchObject({ band: 'high' }); // grounded in system-of-record data
    const deltas = ofType(events, 'message.delta').map((d) => d.delta).join('');
    expect(deltas).toBe(completed.text);

    // Persistence: refund row.
    const refundRows = await storedRefunds(sessionId);
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({ id: refundResult.refund_id, customerId: 'AC-1001', invoiceId: 'INV-1001-04', amountCents: 4900, reason: 'duplicate_charge' });
    expect(completed.text).toContain(refundRows[0]!.id);

    // Persistence: the conversation log (hidden tool messages are model memory, not transcript).
    const rows = await storedMessages(sessionId);
    expect(shape(rows)).toEqual([
      ['user', 'visible', null],
      ['assistant', 'hidden', 'verify_customer_identity+get_billing_history'],
      ['tool', 'hidden', 'verify_customer_identity'],
      ['tool', 'hidden', 'get_billing_history'],
      ['assistant', 'hidden', 'issue_refund'],
      ['tool', 'hidden', 'issue_refund'],
      ['assistant', 'visible', null],
    ]);
    expect(new Set(rows.map((r) => r.turnId))).toEqual(new Set([result.turnId]));
    const final = rows.at(-1)!;
    expect(final.content).toBe(completed.text);
    expect(final.meta).toMatchObject({ confidence: { band: 'high' }, grounding: { passed: true } });
    expect((final.meta.steps as Array<{ name: string }>).map((s) => s.name)).toContain('issue_refund');

    const transcript = await container.sessions.repo.transcript(sessionId);
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant']);

    // Persistence: session state + trace.
    const s = await storedSession(sessionId);
    expect(s).toMatchObject({ customerId: 'AC-1001', status: 'active', turnCount: 1, failedVerifications: 0 });
    expect(s.verifiedAt).toBeInstanceOf(Date);
    const trace = await storedTrace(result.turnId);
    expect(trace?.status).toBe('ok');
    expect(trace?.trace.spans.filter((sp) => sp.kind === 'tool').map((sp) => sp.name)).toEqual([
      'verify_customer_identity',
      'get_billing_history',
      'issue_refund',
    ]);
  });

  it('confidence gate: insufficient retrieval → no second model call, deterministic escalation', async () => {
    const sessionId = await newSession();
    const realSearch = container.knowledge.search.bind(container.knowledge);
    const search = vi.spyOn(container.knowledge, 'search').mockImplementation(async (params): Promise<RetrievalOutcome> => {
      const real = await realSearch(params); // exercise the real hybrid search, then force the verdict
      return {
        ...real,
        status: 'insufficient',
        inDomain: true,
        hits: [],
        confidence: { score: 0.18, band: 'low', signals: real.confidence.signals, rationale: 'Forced below threshold by the test.' },
      };
    });
    scriptAgent([{ toolCalls: [{ name: 'search_knowledge_base', args: { query: 'student discount program' } }] }]);

    const userText = 'Do you offer a discount for students?';
    const { result, events } = await turn(sessionId, userText);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]![0]).toMatchObject({ query: 'student discount program', userMessage: userText, tier: null });
    // The model never gets a chance to improvise an answer.
    expect(agentCalls()).toHaveLength(1);

    const escalation = one(events, 'escalation.created');
    const ticket = escalation.ticket;
    expect(ticket).toMatchObject({ reason: 'low_confidence', queue: 'Customer Support', priority: 'normal', slaHours: 72, customerId: null });

    const completed = one(events, 'message.completed');
    expect(completed.text).toBe(lowConfidenceEscalation(ticket, null, 'text'));
    expect(completed.confidence).toMatchObject({ band: 'low', score: 0.18 });
    expect(result.status).toBe('escalated');
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'escalated' });

    const gateStarted = ofType(events, 'step.started').find((s) => s.name === 'confidence_gate');
    expect(gateStarted?.kind).toBe('guardrail');
    expect(ofType(events, 'step.completed').find((c) => c.stepId === gateStarted?.stepId)?.summary).toMatch(
      /Low confidence \(0\.18\) — routing to a human specialist/,
    );
    expect(ofType(events, 'session.updated').at(-1)).toMatchObject({ status: 'escalated', escalation: { id: ticket.id } });

    const ticketRows = await storedTickets(sessionId);
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]).toMatchObject({ id: ticket.id, reason: 'low_confidence', queue: 'Customer Support', slaHours: 72 });
    expect(ticketRows[0]!.summary).toContain(userText);

    const s = await storedSession(sessionId);
    expect(s.status).toBe('escalated');
    expect(s.escalation?.id).toBe(ticket.id);

    // The orchestrator-created ticket is recorded in model memory as if the agent had called it.
    expect(shape(await storedMessages(sessionId))).toEqual([
      ['user', 'visible', null],
      ['assistant', 'hidden', 'search_knowledge_base'],
      ['tool', 'hidden', 'search_knowledge_base'],
      ['assistant', 'hidden', 'create_escalation_ticket'],
      ['tool', 'hidden', 'create_escalation_ticket'],
      ['assistant', 'visible', null],
    ]);
  });

  describe('grounded knowledge-base answers', () => {
    /** A verbatim query makes the offline hash embedder retrieve this chunk with high similarity. */
    async function duplicateChargesQuery(): Promise<string> {
      const chunks = await container.db.select().from(kbChunks).where(eq(kbChunks.docId, 'refund-policy'));
      return chunks.find((c) => c.headingPath.join('>') === 'Duplicate Charges')!.content;
    }

    it('answers from retrieved sources with valid citations and a passing grounding check', async () => {
      const sessionId = await newSession();
      const query = await duplicateChargesQuery();
      const answer = 'Duplicate charges are refundable in full within 90 days of the charge date [1].';
      scriptAgent([{ toolCalls: [{ name: 'search_knowledge_base', args: { query } }] }, { text: answer }], {
        ...JUDGE_VERDICT,
        answerable: true,
        confidence: 0.9,
        supporting_sources: [1],
      });

      const { result, events } = await turn(sessionId, 'How long do I have to get a duplicate charge refunded?');

      const searchResult = resultOf(agentCalls()[1]!, 'search_knowledge_base')!;
      expect(searchResult.status).toBe('grounded');
      expect(searchResult.tier_scope).toMatch(/general/);
      expect(searchResult.sources[0]).toMatchObject({ index: 1, document: 'Refund Policy', section: 'Duplicate Charges' });

      const completed = one(events, 'message.completed');
      expect(result.status).toBe('ok');
      expect(completed.text).toBe(answer);
      // Only the sources the answer actually cites are attached.
      expect(completed.citations).toEqual([expect.objectContaining({ index: 1, docId: 'refund-policy', section: 'Duplicate Charges' })]);
      expect(completed.grounding).toEqual({ passed: true, checkedClaims: 1, unsupportedClaims: [], invalidCitations: [] });
      expect(completed.confidence?.band).not.toBe('low');
      expect(completed.confidence?.signals.map((s) => s.name)).toContain('grounding_check');
      expect(ofType(events, 'escalation.created')).toEqual([]);
    });

    it('flags a hallucinated number and an invented citation, and lowers the confidence', async () => {
      const sessionId = await newSession();
      const query = await duplicateChargesQuery();
      const answer = 'Duplicate charges are refundable within 120 days [1][7].';
      scriptAgent([{ toolCalls: [{ name: 'search_knowledge_base', args: { query } }] }, { text: answer }], {
        ...JUDGE_VERDICT,
        answerable: true,
        confidence: 0.9,
        supporting_sources: [1],
      });

      const { result, events } = await turn(sessionId, 'How long do I have to get a duplicate charge refunded?');

      const completed = one(events, 'message.completed');
      expect(result.status).toBe('ok'); // delivered, but visibly flagged
      expect(completed.grounding).toEqual({ passed: false, checkedClaims: 1, unsupportedClaims: ['120 days'], invalidCitations: [7] });
      expect(completed.citations.map((c) => c.index)).toEqual([1]);

      const retrievalConfidence = (await storedTrace(result.turnId))!.trace.spans.find((sp) => sp.name === 'hybrid_search')!.attributes
        .confidence as { score: number };
      expect(completed.confidence!.score).toBeLessThan(retrievalConfidence.score);
      expect(completed.confidence!.signals.find((s) => s.name === 'grounding_check')).toMatchObject({ value: 0 });

      const groundingStep = ofType(events, 'step.started').find((s) => s.name === 'grounding_check')!;
      expect(ofType(events, 'step.completed').find((c) => c.stepId === groundingStep.stepId)).toMatchObject({
        status: 'error',
        summary: 'Flagged: 120 days, [7]',
      });
    });
  });

  it('specifics stated without consulting any source are flagged (prompt instructions are not evidence)', async () => {
    const sessionId = await newSession();
    // "7" and "120" appear in the system prompt's *instructions* (numbered steps, "under 120 words"),
    // but they are not facts the answer may rely on.
    scriptAgent([{ text: 'Refunds usually arrive in 7 business days, and credits within 120 days.' }]);

    const { events } = await turn(sessionId, 'How long do refunds take?');

    const completed = one(events, 'message.completed');
    expect(completed.grounding).toMatchObject({ passed: false, unsupportedClaims: ['7 business days', '120 days'] });
    expect(completed.confidence).toMatchObject({ band: 'low', score: 0.2 });
  });

  it('policy-mandated escalation the model "forgets" is created by the orchestrator', async () => {
    const sessionId = await newSession();
    const modelText = 'That refund is above what I can approve myself, so it needs sign-off from our billing team.';
    scriptAgent([
      {
        toolCalls: [
          { name: 'verify_customer_identity', args: { account_id: 'AC-1006', email: null, zip_code: '98101' } },
          { name: 'get_billing_history', args: { limit: null } },
        ],
      },
      { toolCalls: [{ name: 'issue_refund', args: { invoice_id: 'INV-1006-01', amount_usd: 490, reason: 'accidental_purchase' } }] },
      { text: modelText }, // …and no create_escalation_ticket
    ]);

    const { result, events } = await turn(sessionId, "This is Frank, AC-1006, ZIP 98101. I didn't mean to buy the annual plan — please refund the $490.");

    expect(agentCalls()).toHaveLength(3);
    expect(resultOf(agentCalls()[2]!, 'issue_refund')).toMatchObject({
      status: 'requires_approval',
      code: 'OVER_APPROVAL_LIMIT',
      route: { queue: 'Billing Team', priority: 'high' },
    });
    expect(await storedRefunds(sessionId)).toEqual([]);

    const ticket = one(events, 'escalation.created').ticket;
    expect(ticket).toMatchObject({ queue: 'Billing Team', priority: 'high', reason: 'policy_exception', category: 'billing', customerId: 'AC-1006', slaHours: 8 });

    const toolSteps = ofType(events, 'step.started').filter((s) => s.kind === 'tool').map((s) => s.name);
    expect(toolSteps).toEqual(['verify_customer_identity', 'get_billing_history', 'issue_refund', 'create_escalation_ticket']);

    const frank = container.crm.getCustomer('AC-1006')!;
    const completed = one(events, 'message.completed');
    expect(completed.text).toBe(`${modelText}\n\n${escalationAddendum(ticket, frank, 'text')}`);
    expect(completed.text).toContain(ticket.id);
    expect(result.status).toBe('escalated');

    const ticketRows = await storedTickets(sessionId);
    expect(ticketRows).toHaveLength(1);
    expect(ticketRows[0]).toMatchObject({ id: ticket.id, queue: 'Billing Team', priority: 'high', reason: 'policy_exception', slaHours: 8 });
    expect(ticketRows[0]!.summary).toContain('INV-1006-01');
    expect(ticketRows[0]!.payload).toMatchObject({ customer: { id: 'AC-1006', tier: 'pro' } });

    expect((await storedSession(sessionId)).status).toBe('escalated');
    const trace = await storedTrace(result.turnId);
    expect(trace?.trace.spans.some((sp) => sp.kind === 'guardrail' && sp.name === 'mandatory_escalation')).toBe(true);

    const rows = await storedMessages(sessionId);
    expect(shape(rows).slice(-3)).toEqual([
      ['assistant', 'hidden', 'create_escalation_ticket'],
      ['tool', 'hidden', 'create_escalation_ticket'],
      ['assistant', 'visible', null],
    ]);
    expect(rows.at(-1)!.content).toBe(completed.text);
  });

  it('precondition: get_billing_history before verification is skipped and the model gets PRECONDITION_FAILED', async () => {
    const sessionId = await newSession();
    const reply = 'I can help with that — first, what is your account ID and billing ZIP code?';
    scriptAgent([{ toolCalls: [{ name: 'get_billing_history', args: { limit: 3 } }] }, { text: reply }]);

    const { result, events } = await turn(sessionId, 'Can you show me my recent invoices?');

    const billingStep = ofType(events, 'step.started').find((s) => s.name === 'get_billing_history')!;
    const billingDone = ofType(events, 'step.completed').find((c) => c.stepId === billingStep.stepId)!;
    expect(billingDone.status).toBe('skipped');
    expect(billingDone.summary).toMatch(/identity not verified/);

    expect(agentCalls()).toHaveLength(2);
    expect(resultOf(agentCalls()[1]!, 'get_billing_history')).toMatchObject({ error: 'PRECONDITION_FAILED' });

    expect(result.status).toBe('ok');
    expect(one(events, 'message.completed').text).toBe(reply);
    expect((await storedSession(sessionId)).customerId).toBeNull();
    const final = (await storedMessages(sessionId)).at(-1)!;
    expect((final.meta.steps as Array<{ name: string; status: string }>).find((s) => s.name === 'get_billing_history')?.status).toBe('skipped');
  });

  it('upstream failure before output → retries, then the fallback model answers', async () => {
    const sessionId = await newSession();
    const reply = 'Hello! How can I help with your Acme Cloud account today?';
    chat.calls = [];
    script = (req) =>
      req.model === PRIMARY_MODEL ? { error: new AppError('UPSTREAM_UNAVAILABLE', 'simulated 503', { retryAfterMs: 5 }) } : { text: reply };

    const { result, events } = await turn(sessionId, 'Hello');

    // LLM_MAX_RETRIES=1 → primary twice, then the fallback.
    expect(chat.calls.map((c) => c.model)).toEqual([PRIMARY_MODEL, PRIMARY_MODEL, FALLBACK_MODEL]);
    expect(result.status).toBe('ok');
    expect(one(events, 'message.completed').text).toBe(reply);
    expect(ofType(events, 'error')).toEqual([]);
    expect(ofType(events, 'recovery').map((r) => [r.code, r.attempt, r.message])).toEqual([
      ['UPSTREAM_UNAVAILABLE', 1, 'Model provider unavailable — retrying in 0.0s'],
      ['UPSTREAM_UNAVAILABLE', 0, `Model provider unavailable — switching to fallback model ${FALLBACK_MODEL}`],
    ]);
    const llmSpan = (await storedTrace(result.turnId))?.trace.spans.find((sp) => sp.kind === 'llm');
    expect(llmSpan?.attributes.model).toBe(FALLBACK_MODEL);
    expect((llmSpan?.attributes.attempts as unknown[]).length).toBe(3);
  });

  it('chaos: a transient tool outage is retried transparently and the one-shot flag is persisted disarmed', async () => {
    const sessionId = await newSession();
    await container.sessions.setChaos(sessionId, { failTool: 'verify_customer_identity', failToolMode: 'transient', llmTimeout: false, rateLimit: false });
    scriptAgent([
      { toolCalls: [{ name: 'verify_customer_identity', args: { account_id: 'AC-1001', email: null, zip_code: '94107' } }] },
      { text: "Thanks Alice — you're verified." },
    ]);

    const { result, events } = await turn(sessionId, 'AC-1001, 94107');

    expect(result.status).toBe('ok');
    expect(ofType(events, 'recovery')).toEqual([expect.objectContaining({ code: 'TOOL_FAILED', attempt: 1 })]);
    expect(resultOf(agentCalls()[1]!, 'verify_customer_identity')).toMatchObject({ verified: true });
    const s = await storedSession(sessionId);
    expect(s.customerId).toBe('AC-1001');
    expect(s.chaos).toMatchObject({ failTool: null });
  });

  it('abort mid-stream → turn aborted, user message and the partial (interrupted) reply persisted', async () => {
    const sessionId = await newSession();
    const controller = new AbortController();
    scriptAgent([{ text: 'Our refund policy depends on your plan and on how long ago you were charged.' }]);

    const userText = 'Tell me about refunds';
    const { result, events } = await turn(sessionId, userText, {
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'message.delta') controller.abort(); // customer interrupts after the first word
      },
    });

    expect(result.status).toBe('aborted');
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed', status: 'aborted' });
    expect(ofType(events, 'error')).toEqual([]); // a user abort is not an error
    const completed = one(events, 'message.completed');
    expect(completed.interrupted).toBe(true);
    expect(completed.text).toBe('Our ');

    const rows = await storedMessages(sessionId);
    expect(rows.map((r) => [r.role, r.content, r.interrupted])).toEqual([
      ['user', userText, false],
      ['assistant', 'Our ', true],
    ]);
    expect((await storedTrace(result.turnId))?.status).toBe('aborted');
    expect((await storedSession(sessionId)).turnCount).toBe(1);

    // The next turn's memory tells the model what the customer did NOT hear.
    scriptAgent([{ text: 'Sorry — as I was saying…' }]);
    const next = await turn(sessionId, 'Sorry, go on');
    expect(next.result.status).toBe('ok');
    const history = agentCalls()[0]!.messages.slice(1);
    expect(history).toEqual([
      { role: 'user', content: userText },
      // (the partial is stored untrimmed, hence \s+)
      { role: 'assistant', content: expect.stringMatching(/^Our\s+\[customer interrupted — they did not hear the rest\]$/) },
      { role: 'user', content: 'Sorry, go on' },
    ]);
  });

  it('abortTurn() before any output → aborted, no assistant message, user message persisted', async () => {
    const sessionId = await newSession();
    scriptAgent([{ delayMs: 5_000, text: 'far too slow' }]);

    const started = performance.now();
    const { result, events } = await turn(sessionId, 'Are you there?', {
      onEvent: (e) => {
        if (e.type === 'turn.started') setTimeout(() => container.sessions.abortTurn(sessionId), 30);
      },
    });

    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result.status).toBe('aborted');
    expect(result.assistantMessageId).toBeNull();
    expect(ofType(events, 'message.completed')).toEqual([]);
    expect(ofType(events, 'error')).toEqual([]);
    expect(agentCalls()).toHaveLength(1); // no retry / fallback after an abort
    const rows = await storedMessages(sessionId);
    expect(rows.map((r) => [r.role, r.content])).toEqual([['user', 'Are you there?']]);
    expect(container.sessions.activeTurn(sessionId)).toBeUndefined();
  });

  it('step limit: a model stuck in a loop is escalated with deterministic copy', async () => {
    const sessionId = await newSession();
    const maxSteps = container.config.env.AGENT_MAX_STEPS;
    scriptAgent(Array.from({ length: maxSteps }, () => ({ toolCalls: [{ name: 'get_billing_history', args: { limit: null } }] })));

    const { result, events } = await turn(sessionId, 'Show my invoices');

    expect(agentCalls()).toHaveLength(maxSteps);
    const ticket = one(events, 'escalation.created').ticket;
    expect(ticket).toMatchObject({ reason: 'agent_limit', queue: 'Customer Support' });
    expect(one(events, 'message.completed').text).toBe(
      `I wasn't able to fully resolve this automatically, so I've escalated it to a specialist — ticket **${ticket.id}**. A specialist will follow up within ${ticket.slaHours} hours.`,
    );
    expect(result.status).toBe('escalated');
  });

  it('verification lockout: repeated failures lock verification and force a Trust & Safety ticket', async () => {
    const sessionId = await newSession();
    const wrong = { name: 'verify_customer_identity', args: { account_id: 'AC-1001', email: null, zip_code: '00000' } };
    scriptAgent([{ toolCalls: [wrong, wrong, wrong, wrong] }, { text: "I'm sorry, I couldn't verify those details." }]);

    const { result, events } = await turn(sessionId, 'AC-1001, zip 00000');

    const verifyResults = toolResults(agentCalls()[1]!).map((r) => r.payload);
    expect(verifyResults.map((r) => [r.verified, r.attempts_remaining, r.locked])).toEqual([
      [false, 2, undefined],
      [false, 1, undefined],
      [false, 0, undefined],
      [false, undefined, true],
    ]);
    // Enumeration defence: a failure never says whether the account exists.
    expect(JSON.stringify(verifyResults[0])).not.toMatch(/Alice|exists|not found/i);

    const ticket = one(events, 'escalation.created').ticket;
    expect(ticket).toMatchObject({ reason: 'verification_failed', queue: 'Trust & Safety', customerId: null });
    expect(result.status).toBe('escalated');
    expect(await storedSession(sessionId)).toMatchObject({ customerId: null, failedVerifications: 3, status: 'escalated' });
  });

  it('single-flight: a duplicate clientTurnId or a concurrent turn is rejected; a voice barge-in preempts', async () => {
    const sessionId = await newSession();
    scriptAgent([{ text: 'First answer.' }]);
    await turn(sessionId, 'first', { clientTurnId: 'client-turn-0001' });
    // A retried POST with the same client id must not run the turn twice.
    await expect(turn(sessionId, 'first', { clientTurnId: 'client-turn-0001' })).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });
    expect((await storedMessages(sessionId)).filter((m) => m.role === 'user')).toHaveLength(1);

    // A slow in-flight turn…
    scriptAgent([{ delayMs: 5_000, text: 'slow answer' }, { text: 'Fresh answer to the barge-in.' }]);
    let inFlight!: () => void;
    const claimed = new Promise<void>((resolve) => (inFlight = resolve));
    const slow = turn(sessionId, 'tell me everything', { onEvent: (e) => e.type === 'turn.started' && inFlight() });
    await claimed;

    // …rejects a concurrent text turn…
    await expect(turn(sessionId, 'hello?')).rejects.toMatchObject({ code: 'TURN_IN_PROGRESS' });

    // …but a voice barge-in aborts it and takes over.
    const bargeIn = await turn(sessionId, 'actually, stop — what is my plan?', { mode: 'voice', preempt: true });
    const preempted = await slow;
    expect(preempted.result.status).toBe('aborted');
    expect(bargeIn.result.status).toBe('ok');
    expect(bargeIn.result.text).toBe('Fresh answer to the barge-in.');

    const userTurns = (await storedMessages(sessionId)).filter((m) => m.role === 'user').map((m) => m.content);
    expect(userTurns).toEqual(['first', 'tell me everything', 'actually, stop — what is my plan?']);
  });

  it('multi-turn memory: the second turn sees the first turn, across text and voice', async () => {
    const sessionId = await newSession();
    const turn1User = 'Hi, my account is AC-1001 and my ZIP is 94107.';
    const turn1Reply = "Thanks Alice — you're verified on the Pro plan. How can I help?";
    scriptAgent([
      { toolCalls: [{ name: 'verify_customer_identity', args: { account_id: 'AC-1001', email: null, zip_code: '94107' } }] },
      { text: turn1Reply },
    ]);
    await turn(sessionId, turn1User);

    const turn2User = 'Which plan am I on again?';
    scriptAgent([{ text: "You're on Pro (monthly)." }]);
    const { result } = await turn(sessionId, turn2User, { mode: 'voice' });
    expect(result.status).toBe('ok');

    const [req] = agentCalls();
    const system = req!.messages[0]!;
    expect(system.role).toBe('system');
    // Identity is re-injected from session state, and the voice style applies to this turn.
    expect(system.content).toContain('Verified customer: Alice Chen (AC-1001)');
    expect(system.content).toContain('live voice call');

    const history = req!.messages.slice(1);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(history[0]).toEqual({ role: 'user', content: turn1User });
    expect(history[1]).toMatchObject({ role: 'assistant', toolCalls: [{ name: 'verify_customer_identity' }] });
    expect(JSON.parse(history[2]!.content as string)).toMatchObject({ verified: true, customer: { id: 'AC-1001' } });
    expect(history[3]).toEqual({ role: 'assistant', content: turn1Reply });
    expect(history[4]).toEqual({ role: 'user', content: turn2User });

    // The turn-2 model didn't have to re-verify; nothing new was persisted on the session.
    expect((await storedSession(sessionId))).toMatchObject({ customerId: 'AC-1001', turnCount: 2 });
  });
});
