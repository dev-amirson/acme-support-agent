import type { ConversationMode, EscalationTicket, ToolName } from '@acme/contracts';
import type { z } from 'zod';
import type { TurnState } from '../agent/turn-state';
import type { CustomerRecord } from '../domain/crm-fixtures';
import type { CrmRepository } from '../domain/crm-repository';
import type { SpanHandle, SpanRecorder } from '../observability/tracer';
import type { KnowledgeService } from '../rag/knowledge-service';
import type { SessionRow } from '../session/session-repository';

/** Session mutations a tool may perform. Implemented by the orchestrator, persisted immediately. */
export interface SessionEffects {
  markVerified(customer: CustomerRecord): Promise<void>;
  /** Returns the updated failure count. */
  recordFailedVerification(): Promise<number>;
  escalate(ticket: EscalationTicket): Promise<void>;
}

export interface ToolContext {
  sessionId: string;
  turnId: string;
  mode: ConversationMode;
  /** The customer's message that started this turn (used for dual-query retrieval). */
  userMessage: string;
  session: SessionRow;
  turn: TurnState;
  signal: AbortSignal;
  span: SpanHandle;
  recorder: SpanRecorder;
  progress(label: string): void;
  effects: SessionEffects;
  now(): Date;
}

export interface ToolDeps {
  crm: CrmRepository;
  knowledge: KnowledgeService;
}

export interface ToolOutcome {
  /** JSON returned to the model. Keep it compact and factual — it is also grounding evidence. */
  result: Record<string, unknown>;
  /** One-line, customer-safe summary for the step indicator. */
  summary: string;
}

export interface ToolDefinition<TArgs = unknown> {
  name: ToolName;
  description: string;
  schema: z.ZodType<TArgs>;
  /** Status label while running, e.g. "Verifying account identity…". */
  label: string;
  requiresVerifiedCustomer: boolean;
  /** Has side effects: never served from the per-turn call cache; must be idempotent. */
  mutating: boolean;
  execute(args: TArgs, ctx: ToolContext): Promise<ToolOutcome>;
}

/** Helper that preserves the args type while erasing it for the registry. */
export function defineTool<TArgs>(def: ToolDefinition<TArgs>): ToolDefinition<unknown> {
  return def as unknown as ToolDefinition<unknown>;
}
