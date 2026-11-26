import type { ChaosConfig, EscalationTicket, TurnTrace, UsageLine } from '@acme/contracts';
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type { ChatToolCall } from '../llm/types';

/**
 * Single Postgres database (with pgvector) for vectors, conversation memory, the mock CRM's
 * mutable state and traces: fewer moving parts on a free tier, and transactional consistency
 * between e.g. a refund row and the message that announced it.
 *
 * Migrations are generated from this file with `npm run db:generate` (drizzle-kit) and applied
 * on boot.
 */

/** text-embedding-3-small native size. A vector column's dimension is part of the schema. */
export const EMBEDDING_DIMENSIONS = 1536;

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------- knowledge base

export const kbDocuments = pgTable('kb_documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  category: text('category').notNull(),
  tiers: text('tiers').array().notNull().default(sql`'{}'::text[]`),
  contentHash: text('content_hash').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
});

export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: text('id').primaryKey(),
    docId: text('doc_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    headingPath: text('heading_path').array().notNull(),
    headingText: text('heading_text').notNull(),
    content: text('content').notNull(),
    embeddingInput: text('embedding_input').notNull(),
    /** Empty = applies to every tier; otherwise only to the listed tiers. */
    tiers: text('tiers').array().notNull().default(sql`'{}'::text[]`),
    tokenCount: integer('token_count').notNull(),
    contentHash: text('content_hash').notNull(),
    embeddingModel: text('embedding_model').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', heading_text || ' ' || content)`),
  },
  (t) => [
    index('kb_chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('kb_chunks_tsv_gin').using('gin', t.tsv),
    index('kb_chunks_doc').on(t.docId, t.ordinal),
    index('kb_chunks_hash').on(t.contentHash),
  ],
);

// ---------------------------------------------------------------------------- sessions & memory

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey(),
  status: text('status', { enum: ['active', 'escalated'] }).notNull().default('active'),
  customerId: text('customer_id'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  failedVerifications: integer('failed_verifications').notNull().default(0),
  escalation: jsonb('escalation').$type<EscalationTicket | null>(),
  chaos: jsonb('chaos').$type<Partial<ChaosConfig>>().notNull().default({}),
  /** Sandboxed account-setting changes, keyed by customer id (fixtures are read-only). */
  accountOverrides: jsonb('account_overrides').$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  turnCount: integer('turn_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable(
  'messages',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    turnId: text('turn_id').notNull(),
    clientTurnId: text('client_turn_id'),
    role: text('role', { enum: ['user', 'assistant', 'tool'] }).notNull(),
    mode: text('mode', { enum: ['text', 'voice'] }).notNull(),
    content: text('content').notNull().default(''),
    toolCalls: jsonb('tool_calls').$type<ChatToolCall[] | null>(),
    toolCallId: text('tool_call_id'),
    toolName: text('tool_name'),
    /** Intermediate tool-call / tool-result messages are model memory, not transcript. */
    visible: boolean('visible').notNull().default(true),
    interrupted: boolean('interrupted').notNull().default(false),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index('messages_session_seq').on(t.sessionId, t.seq),
    unique('messages_client_turn').on(t.sessionId, t.clientTurnId),
    check('messages_role_check', sql`${t.role} in ('user', 'assistant', 'tool')`),
  ],
);

// ---------------------------------------------------------------------------- mock CRM state

export const refunds = pgTable(
  'refunds',
  {
    id: text('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    customerId: text('customer_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [unique('refunds_session_invoice').on(t.sessionId, t.invoiceId), check('refunds_amount_positive', sql`${t.amountCents} > 0`)],
);

export const tickets = pgTable('tickets', {
  id: text('id').primaryKey(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  customerId: text('customer_id'),
  priority: text('priority').notNull(),
  category: text('category').notNull(),
  reason: text('reason').notNull(),
  queue: text('queue').notNull(),
  summary: text('summary').notNull(),
  slaHours: integer('sla_hours').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------- observability

export const traces = pgTable(
  'traces',
  {
    turnId: text('turn_id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    trace: jsonb('trace').$type<TurnTrace>().notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('traces_session').on(t.sessionId, t.createdAt)],
);

/** Every billable call, turn-bound or not (e.g. voice audio that never became a turn). */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: uuid('session_id'),
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }).notNull(),
    detail: jsonb('detail').$type<UsageLine>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('usage_events_created').on(t.createdAt)],
);

export const schema = { kbDocuments, kbChunks, sessions, messages, refunds, tickets, traces, usageEvents };
