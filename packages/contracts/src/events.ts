import type {
  Citation,
  Confidence,
  ConversationMode,
  CustomerSummary,
  EscalationTicket,
  GroundingReport,
  SessionStatus,
  TraceSpan,
  TurnMetrics,
  TurnStatus,
} from './domain';

/**
 * The agent event protocol.
 *
 * The orchestrator emits exactly one stream of these per turn. Transports are dumb pipes:
 * chat writes them as SSE frames, voice writes them as WebSocket JSON frames. The web client
 * folds both into the same store with one reducer, which is what keeps text and voice
 * behaviourally identical.
 */

export const ERROR_CODES = [
  'LLM_TIMEOUT',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  'TOOL_FAILED',
  'BUDGET_EXCEEDED',
  'VALIDATION',
  'SESSION_NOT_FOUND',
  'TURN_IN_PROGRESS',
  'ABORTED',
  'VOICE_UNAVAILABLE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type StepKind = 'llm' | 'tool' | 'guardrail' | 'system';
export type StepStatus = 'running' | 'ok' | 'error' | 'skipped';

/** Persisted shape of a step, so reloaded transcripts can render their timelines. */
export interface StepRecord {
  stepId: string;
  kind: StepKind;
  name: string;
  label: string;
  status: StepStatus;
  summary?: string;
  durationMs?: number;
  progress?: string[];
}

export type AgentEvent =
  | {
      type: 'turn.started';
      turnId: string;
      mode: ConversationMode;
      userMessageId: string;
      userText: string;
      at: number;
    }
  | {
      type: 'step.started';
      turnId: string;
      stepId: string;
      kind: StepKind;
      name: string;
      label: string;
    }
  | { type: 'step.progress'; turnId: string; stepId: string; label: string }
  | {
      type: 'step.completed';
      turnId: string;
      stepId: string;
      status: Exclude<StepStatus, 'running'>;
      label: string;
      summary?: string;
      durationMs: number;
    }
  | { type: 'message.started'; turnId: string; messageId: string }
  | { type: 'message.delta'; turnId: string; messageId: string; delta: string }
  | {
      type: 'message.completed';
      turnId: string;
      messageId: string;
      text: string;
      confidence: Confidence | null;
      citations: Citation[];
      grounding: GroundingReport | null;
      interrupted: boolean;
    }
  | {
      type: 'session.updated';
      customer: CustomerSummary | null;
      status: SessionStatus;
      escalation: EscalationTicket | null;
    }
  | { type: 'escalation.created'; turnId: string; ticket: EscalationTicket }
  | {
      /** Transparent recovery in progress, e.g. "rate limited — retrying in 1.2s". */
      type: 'recovery';
      turnId: string;
      code: ErrorCode;
      attempt: number;
      delayMs: number;
      message: string;
    }
  | {
      type: 'error';
      turnId?: string;
      code: ErrorCode;
      message: string;
      retryable: boolean;
    }
  | { type: 'trace.span'; turnId: string; span: TraceSpan }
  | {
      type: 'turn.completed';
      turnId: string;
      status: TurnStatus;
      metrics: TurnMetrics;
    };

export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
