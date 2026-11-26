/**
 * Core domain vocabulary shared by the server and the web client.
 * Everything here is plain data (JSON-serialisable) so it can cross SSE / WebSocket boundaries.
 */

export const TIERS = ['free', 'pro', 'enterprise'] as const;
export type Tier = (typeof TIERS)[number];

export const CONTRACT_STATUSES = ['active', 'past_due', 'cancelled', 'expired'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export type ConversationMode = 'text' | 'voice';

export interface CustomerSummary {
  id: string;
  name: string;
  email: string;
  tier: Tier;
  plan: string;
  contractStatus: ContractStatus;
  contractEndsAt: string | null;
}

// ---------------------------------------------------------------------------
// Confidence & grounding
// ---------------------------------------------------------------------------

export type ConfidenceBand = 'high' | 'medium' | 'low';

/** One input to a confidence score — surfaced verbatim in the observability drawer. */
export interface ConfidenceSignal {
  name: string;
  value: number;
  detail?: string;
}

export interface Confidence {
  score: number;
  band: ConfidenceBand;
  signals: ConfidenceSignal[];
  /** Human-readable explanation of how the band was decided. */
  rationale: string;
}

export interface Citation {
  /** 1-based index the model uses in its answer, e.g. "[2]". */
  index: number;
  chunkId: string;
  docId: string;
  docTitle: string;
  section: string;
  snippet: string;
  similarity: number;
}

export interface GroundingReport {
  passed: boolean;
  /** Numeric / monetary / duration claims that were checked against evidence. */
  checkedClaims: number;
  unsupportedClaims: string[];
  invalidCitations: number[];
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const ESCALATION_REASONS = [
  'low_confidence',
  'customer_request',
  'policy_exception',
  'tool_failure',
  'verification_failed',
  'agent_limit',
  'other',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface EscalationTicket {
  id: string;
  priority: TicketPriority;
  category: string;
  reason: EscalationReason;
  summary: string;
  queue: string;
  slaHours: number;
  customerId: string | null;
  createdAt: string;
  status: 'open';
}

export type SessionStatus = 'active' | 'escalated';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  'verify_customer_identity',
  'search_knowledge_base',
  'get_billing_history',
  'issue_refund',
  'update_account_settings',
  'create_escalation_ticket',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// ---------------------------------------------------------------------------
// Usage, cost and tracing
// ---------------------------------------------------------------------------

export type UsageKind = 'llm' | 'embedding' | 'stt' | 'tts';

export interface UsageLine {
  kind: UsageKind;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  characters?: number;
  costUsd: number;
}

export type SpanKind =
  | 'turn'
  | 'llm'
  | 'tool'
  | 'retrieval'
  | 'embedding'
  | 'guardrail'
  | 'stt'
  | 'tts';

export type SpanStatus = 'running' | 'ok' | 'error';

export interface TraceSpan {
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: SpanStatus;
  attributes: Record<string, unknown>;
  usage?: UsageLine;
  error?: string;
}

export interface TurnMetrics {
  e2eLatencyMs: number;
  /** Time from turn start to the first streamed assistant token. */
  ttftMs: number | null;
  /** Voice only: time from end-of-user-speech to first audio byte sent. */
  timeToFirstAudioMs: number | null;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export type TurnStatus = 'ok' | 'error' | 'aborted' | 'escalated';

export interface TurnTrace {
  turnId: string;
  sessionId: string;
  mode: ConversationMode;
  userText: string;
  status: TurnStatus;
  startedAt: number;
  spans: TraceSpan[];
  usage: UsageLine[];
  metrics: TurnMetrics;
}
