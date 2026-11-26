import type {
  AgentEvent,
  Citation,
  Confidence,
  ConversationMode,
  CustomerSummary,
  ErrorCode,
  EscalationTicket,
  GroundingReport,
  SessionSnapshot,
  SessionStatus,
  StepRecord,
  TraceSpan,
  TurnMetrics,
  TurnStatus,
} from '@acme/contracts';

/**
 * Conversation state + a pure reducer over the agent event protocol.
 *
 * Chat (SSE) and voice (WebSocket) feed the *same* events into this reducer, so both modes render
 * identically — the step timeline, confidence chips, citations and traces don't know or care which
 * transport delivered them.
 */

export interface UiMessage {
  /** Stable React key — survives the optimistic → server id swap. */
  key: string;
  id: string;
  turnId: string | null;
  role: 'user' | 'assistant';
  mode: ConversationMode;
  text: string;
  streaming: boolean;
  pending: boolean;
  interrupted: boolean;
  confidence: Confidence | null;
  citations: Citation[];
  grounding: GroundingReport | null;
  steps: StepRecord[];
  recoveries: string[];
  error: { code: ErrorCode; message: string; retryable: boolean } | null;
  /** For a failed turn: what to resend on "Retry". */
  retryText?: string;
  createdAt: number;
}

export interface TurnView {
  turnId: string;
  mode: ConversationMode;
  userText: string;
  status: TurnStatus | 'running';
  startedAt: number;
  spans: TraceSpan[];
  metrics: TurnMetrics | null;
}

export interface ConversationState {
  messages: UiMessage[];
  turns: Record<string, TurnView>;
  turnOrder: string[];
  customer: CustomerSummary | null;
  status: SessionStatus;
  escalation: EscalationTicket | null;
  activeTurnId: string | null;
}

export const EMPTY_CONVERSATION: ConversationState = {
  messages: [],
  turns: {},
  turnOrder: [],
  customer: null,
  status: 'active',
  escalation: null,
  activeTurnId: null,
};

/** Voice-only event that edits history; kept here so all transcript mutation lives in one place. */
export type TruncationEvent = { type: 'message.truncated'; messageId: string; text: string };
export type ConversationEvent = AgentEvent | TruncationEvent;

const blank = (partial: Partial<UiMessage> & Pick<UiMessage, 'key' | 'id' | 'role' | 'mode'>): UiMessage => ({
  turnId: null,
  text: '',
  streaming: false,
  pending: false,
  interrupted: false,
  confidence: null,
  citations: [],
  grounding: null,
  steps: [],
  recoveries: [],
  error: null,
  createdAt: Date.now(),
  ...partial,
});

export function addOptimisticUserMessage(state: ConversationState, key: string, text: string, mode: ConversationMode): ConversationState {
  return { ...state, messages: [...state.messages, blank({ key, id: key, role: 'user', mode, text, pending: true })] };
}

/** A request that failed before any turn started (network, rate limit, budget). */
export function failPending(state: ConversationState, key: string, error: UiMessage['error'], retryText: string): ConversationState {
  const idx = state.messages.findIndex((m) => m.key === key);
  const messages = state.messages.map((m) => (m.key === key ? { ...m, pending: false } : m));
  const errorMsg = blank({ key: `${key}_error`, id: `${key}_error`, role: 'assistant', mode: 'text', error, retryText });
  if (idx === -1) messages.push(errorMsg);
  else messages.splice(idx + 1, 0, errorMsg);
  return { ...state, messages, activeTurnId: null };
}

function updateAssistant(state: ConversationState, turnId: string, fn: (m: UiMessage) => UiMessage): ConversationState {
  let found = false;
  const messages = state.messages.map((m) => {
    if (m.role === 'assistant' && m.turnId === turnId) {
      found = true;
      return fn(m);
    }
    return m;
  });
  return found ? { ...state, messages } : state;
}

function updateTurn(state: ConversationState, turnId: string, fn: (t: TurnView) => TurnView): ConversationState {
  const turn = state.turns[turnId];
  return turn ? { ...state, turns: { ...state.turns, [turnId]: fn(turn) } } : state;
}

export function reduce(state: ConversationState, ev: ConversationEvent): ConversationState {
  switch (ev.type) {
    case 'turn.started': {
      // Adopt the optimistic chat bubble if there is one; voice turns arrive with no bubble yet.
      const pendingIdx = state.messages.findLastIndex((m) => m.role === 'user' && m.pending && m.text === ev.userText);
      const messages = [...state.messages];
      if (pendingIdx >= 0) {
        messages[pendingIdx] = { ...messages[pendingIdx]!, id: ev.userMessageId, turnId: ev.turnId, pending: false, mode: ev.mode };
      } else {
        messages.push(blank({ key: ev.userMessageId, id: ev.userMessageId, turnId: ev.turnId, role: 'user', mode: ev.mode, text: ev.userText, createdAt: ev.at }));
      }
      messages.push(blank({ key: `a_${ev.turnId}`, id: `pending_${ev.turnId}`, turnId: ev.turnId, role: 'assistant', mode: ev.mode, streaming: true }));
      return {
        ...state,
        messages,
        activeTurnId: ev.turnId,
        turns: { ...state.turns, [ev.turnId]: { turnId: ev.turnId, mode: ev.mode, userText: ev.userText, status: 'running', startedAt: ev.at, spans: [], metrics: null } },
        turnOrder: [...state.turnOrder, ev.turnId],
      };
    }
    case 'step.started':
      return updateAssistant(state, ev.turnId, (m) => ({
        ...m,
        steps: [...m.steps, { stepId: ev.stepId, kind: ev.kind, name: ev.name, label: ev.label, status: 'running', progress: [] }],
      }));
    case 'step.progress':
      return updateAssistant(state, ev.turnId, (m) => ({
        ...m,
        steps: m.steps.map((s) => (s.stepId === ev.stepId ? { ...s, progress: [...(s.progress ?? []), ev.label] } : s)),
      }));
    case 'step.completed':
      return updateAssistant(state, ev.turnId, (m) => ({
        ...m,
        steps: m.steps.map((s) => (s.stepId === ev.stepId ? { ...s, status: ev.status, summary: ev.summary, durationMs: ev.durationMs } : s)),
      }));
    case 'message.started':
      return updateAssistant(state, ev.turnId, (m) => ({ ...m, id: ev.messageId }));
    case 'message.delta':
      return updateAssistant(state, ev.turnId, (m) => ({ ...m, text: m.text + ev.delta }));
    case 'message.completed':
      return updateAssistant(state, ev.turnId, (m) => ({
        ...m,
        id: ev.messageId,
        text: ev.text,
        confidence: ev.confidence,
        citations: ev.citations,
        grounding: ev.grounding,
        interrupted: ev.interrupted,
        streaming: false,
      }));
    case 'message.truncated':
      return {
        ...state,
        messages: state.messages.map((m) => (m.id === ev.messageId ? { ...m, text: ev.text, interrupted: true, streaming: false } : m)),
      };
    case 'recovery':
      return updateAssistant(state, ev.turnId, (m) => ({ ...m, recoveries: [...m.recoveries, ev.message] }));
    case 'error': {
      const error = { code: ev.code, message: ev.message, retryable: ev.retryable };
      if (ev.turnId) {
        const turn = state.turns[ev.turnId];
        return updateAssistant(state, ev.turnId, (m) => ({ ...m, error, streaming: false, retryText: turn?.userText }));
      }
      // Rejected before a turn began: attach to the newest optimistic bubble.
      const pending = state.messages.findLast((m) => m.role === 'user' && m.pending);
      return pending ? failPending(state, pending.key, error, pending.text) : state;
    }
    case 'session.updated':
      return { ...state, customer: ev.customer, status: ev.status, escalation: ev.escalation };
    case 'escalation.created':
      return { ...state, escalation: ev.ticket, status: 'escalated' };
    case 'trace.span':
      return updateTurn(state, ev.turnId, (t) => {
        const i = t.spans.findIndex((s) => s.id === ev.span.id);
        const spans = i === -1 ? [...t.spans, ev.span] : t.spans.map((s, j) => (j === i ? ev.span : s));
        return { ...t, spans };
      });
    case 'turn.completed': {
      const next = updateTurn(state, ev.turnId, (t) => ({ ...t, status: ev.status, metrics: ev.metrics }));
      return {
        ...updateAssistant(next, ev.turnId, (m) => ({ ...m, streaming: false, interrupted: m.interrupted || ev.status === 'aborted' })),
        activeTurnId: state.activeTurnId === ev.turnId ? null : state.activeTurnId,
      };
    }
    default:
      return state;
  }
}

export function fromSnapshot(s: SessionSnapshot): ConversationState {
  const turns: Record<string, TurnView> = {};
  for (const t of s.traces) {
    turns[t.turnId] = { turnId: t.turnId, mode: t.mode, userText: t.userText, status: t.status, startedAt: t.startedAt, spans: t.spans, metrics: t.metrics };
  }
  return {
    ...EMPTY_CONVERSATION,
    customer: s.customer,
    status: s.status,
    escalation: s.escalation,
    turns,
    turnOrder: s.traces.map((t) => t.turnId),
    messages: s.messages.map((m) =>
      blank({
        key: m.id,
        id: m.id,
        turnId: m.turnId,
        role: m.role,
        mode: m.mode,
        text: m.text,
        interrupted: m.interrupted,
        confidence: m.confidence,
        citations: m.citations,
        grounding: m.grounding,
        steps: m.steps,
        createdAt: Date.parse(m.createdAt),
      }),
    ),
  };
}
