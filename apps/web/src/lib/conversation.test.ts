import { describe, expect, it } from 'vitest';
import type { AgentEvent, TurnMetrics } from '@acme/contracts';
import { addOptimisticUserMessage, EMPTY_CONVERSATION, reduce, type ConversationEvent, type ConversationState } from './conversation';

const metrics: TurnMetrics = {
  e2eLatencyMs: 1200,
  ttftMs: 800,
  timeToFirstAudioMs: null,
  llmCalls: 2,
  toolCalls: 1,
  inputTokens: 900,
  cachedInputTokens: 0,
  outputTokens: 40,
  costUsd: 0.001,
};

const run = (state: ConversationState, events: ConversationEvent[]) => events.reduce(reduce, state);

describe('conversation reducer', () => {
  it('adopts the optimistic chat bubble and streams an assistant reply', () => {
    let s = addOptimisticUserMessage(EMPTY_CONVERSATION, 'c1', 'refund please', 'text');
    s = run(s, [
      { type: 'turn.started', turnId: 't1', mode: 'text', userMessageId: 'm_user', userText: 'refund please', at: 1 },
      { type: 'step.started', turnId: 't1', stepId: 's1', kind: 'tool', name: 'verify_customer_identity', label: 'Verifying…' },
      { type: 'step.progress', turnId: 't1', stepId: 's1', label: 'Checking tier…' },
      { type: 'step.completed', turnId: 't1', stepId: 's1', status: 'ok', label: 'Verifying…', summary: 'Verified', durationMs: 5 },
      { type: 'message.started', turnId: 't1', messageId: 'm_ai' },
      { type: 'message.delta', turnId: 't1', messageId: 'm_ai', delta: 'Hello ' },
      { type: 'message.delta', turnId: 't1', messageId: 'm_ai', delta: 'there' },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]).toMatchObject({ key: 'c1', id: 'm_user', pending: false, turnId: 't1' });
    expect(s.messages[1]).toMatchObject({ id: 'm_ai', text: 'Hello there', streaming: true });
    expect(s.messages[1]!.steps[0]).toMatchObject({ status: 'ok', summary: 'Verified', progress: ['Checking tier…'] });
    expect(s.activeTurnId).toBe('t1');

    s = run(s, [
      { type: 'message.completed', turnId: 't1', messageId: 'm_ai', text: 'Hello there.', confidence: null, citations: [], grounding: null, interrupted: false },
      { type: 'turn.completed', turnId: 't1', status: 'ok', metrics },
    ]);
    expect(s.messages[1]).toMatchObject({ text: 'Hello there.', streaming: false });
    expect(s.turns.t1!.metrics).toEqual(metrics);
    expect(s.activeTurnId).toBeNull();
  });

  it('creates the user bubble for voice turns (no optimistic message)', () => {
    const s = reduce(EMPTY_CONVERSATION, { type: 'turn.started', turnId: 't1', mode: 'voice', userMessageId: 'u1', userText: 'hi', at: 1 });
    expect(s.messages.map((m) => [m.role, m.mode, m.text])).toEqual([
      ['user', 'voice', 'hi'],
      ['assistant', 'voice', ''],
    ]);
  });

  it('applies barge-in truncation to the stored reply', () => {
    let s = run(EMPTY_CONVERSATION, [
      { type: 'turn.started', turnId: 't1', mode: 'voice', userMessageId: 'u1', userText: 'hi', at: 1 },
      { type: 'message.completed', turnId: 't1', messageId: 'a1', text: 'A long answer that was cut off', confidence: null, citations: [], grounding: null, interrupted: false },
    ]);
    s = reduce(s, { type: 'message.truncated', messageId: 'a1', text: 'A long answer…' });
    expect(s.messages[1]).toMatchObject({ text: 'A long answer…', interrupted: true });
  });

  it('attaches turn errors with a retry payload, and pre-turn errors to the pending bubble', () => {
    let s = run(EMPTY_CONVERSATION, [
      { type: 'turn.started', turnId: 't1', mode: 'text', userMessageId: 'u1', userText: 'list invoices', at: 1 },
      { type: 'error', turnId: 't1', code: 'LLM_TIMEOUT', message: 'took too long', retryable: true },
    ]);
    expect(s.messages[1]).toMatchObject({ streaming: false, retryText: 'list invoices', error: { code: 'LLM_TIMEOUT' } });

    s = addOptimisticUserMessage(EMPTY_CONVERSATION, 'c2', 'hello', 'text');
    s = reduce(s, { type: 'error', code: 'RATE_LIMITED', message: 'slow down', retryable: true } as AgentEvent);
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', retryText: 'hello', error: { code: 'RATE_LIMITED' } });
  });

  it('upserts trace spans and tracks session state', () => {
    const span = { id: 'sp1', parentId: null, kind: 'llm' as const, name: 'reason #1', startedAt: 1, endedAt: null, durationMs: null, status: 'running' as const, attributes: {} };
    let s = run(EMPTY_CONVERSATION, [
      { type: 'turn.started', turnId: 't1', mode: 'text', userMessageId: 'u1', userText: 'x', at: 1 },
      { type: 'trace.span', turnId: 't1', span },
      { type: 'trace.span', turnId: 't1', span: { ...span, status: 'ok', endedAt: 5, durationMs: 4 } },
    ]);
    expect(s.turns.t1!.spans).toHaveLength(1);
    expect(s.turns.t1!.spans[0]!.status).toBe('ok');

    const ticket = { id: 'ESC-1', priority: 'high' as const, category: 'billing', reason: 'policy_exception' as const, summary: '', queue: 'Billing Team', slaHours: 8, customerId: null, createdAt: '', status: 'open' as const };
    s = reduce(s, { type: 'escalation.created', turnId: 't1', ticket });
    expect(s).toMatchObject({ status: 'escalated', escalation: { id: 'ESC-1' } });
  });
});
