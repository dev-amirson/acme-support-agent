import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors';
import { ScriptedChatModel, type ChatScript } from './fake-chat';
import { resilientStream, type AttemptRecord, type RecoveryInfo, type ResilientStreamOptions } from './resilient-chat';
import type { ChatModel, ChatRequest, ChatStreamEvent } from './types';

const PRIMARY = 'primary-model';
const FALLBACK = 'fallback-model';

const request = (signal = new AbortController().signal): ChatRequest => ({
  model: PRIMARY,
  messages: [{ role: 'user', content: 'Hello' }],
  signal,
});

function harness(overrides: Partial<ResilientStreamOptions> = {}) {
  const recoveries: RecoveryInfo[] = [];
  const attempts: AttemptRecord[] = [];
  const opts: ResilientStreamOptions = {
    firstEventTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxRetries: 2,
    fallbackModel: FALLBACK,
    onRecovery: (r) => recoveries.push(r),
    onAttempt: (a) => attempts.push(a),
    ...overrides,
  };
  return { opts, recoveries, attempts };
}

async function collect(stream: AsyncIterable<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');
  return { events, text, done: events.find((e) => e.type === 'done') };
}

/** Collect until the stream throws; returns what was received and the error. */
async function collectUntilError(stream: AsyncIterable<ChatStreamEvent>) {
  const events: ChatStreamEvent[] = [];
  try {
    for await (const ev of stream) events.push(ev);
  } catch (err) {
    return { events, error: err as AppError };
  }
  throw new Error('expected the stream to fail');
}

const unavailable = (retryAfterMs = 5) => new AppError('UPSTREAM_UNAVAILABLE', 'simulated 503', { retryAfterMs });

describe('resilientStream', () => {
  it('passes a healthy stream straight through', async () => {
    const model = new ScriptedChatModel(() => ({ text: 'Hi there, how can I help?', toolCalls: [{ name: 'search_knowledge_base', args: { query: 'x' } }] }));
    const { opts, recoveries, attempts } = harness();
    const { events, text, done } = await collect(resilientStream(model, request(), opts));
    expect(text).toBe('Hi there, how can I help?');
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(done).toMatchObject({ type: 'done', model: PRIMARY, finishReason: 'tool_calls' });
    expect(model.calls).toHaveLength(1);
    expect(recoveries).toEqual([]);
    expect(attempts).toMatchObject([{ model: PRIMARY, attempt: 0, ok: true }]);
  });

  it('retries a retryable AppError raised before any output, honouring retryAfterMs', async () => {
    const script: ChatScript = (_req, i) => (i === 0 ? { error: unavailable(7) } : { text: 'Recovered answer' });
    const model = new ScriptedChatModel(script);
    const { opts, recoveries, attempts } = harness();
    const { text } = await collect(resilientStream(model, request(), opts));

    expect(text).toBe('Recovered answer');
    expect(model.calls.map((c) => c.model)).toEqual([PRIMARY, PRIMARY]);
    expect(recoveries).toEqual([
      { code: 'UPSTREAM_UNAVAILABLE', attempt: 1, delayMs: 7, model: PRIMARY, message: 'Model provider unavailable — retrying in 0.0s' },
    ]);
    expect(attempts.map((a) => [a.attempt, a.ok, a.error?.code])).toEqual([
      [0, false, 'UPSTREAM_UNAVAILABLE'],
      [1, true, undefined],
    ]);
  });

  it('never retries after text has been emitted (no duplicated output)', async () => {
    // ScriptedChatModel can only fail before output, so this model streams a token and then dies.
    let calls = 0;
    const flaky: ChatModel = {
      provider: 'test',
      defaultModel: PRIMARY,
      async *stream() {
        calls++;
        yield { type: 'text', delta: 'Your refund ' };
        throw new AppError('UPSTREAM_UNAVAILABLE', 'connection reset mid-stream');
      },
    };
    const { opts, recoveries, attempts } = harness();
    const { events, error } = await collectUntilError(resilientStream(flaky, request(), opts));

    expect(events).toEqual([{ type: 'text', delta: 'Your refund ' }]);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(calls).toBe(1); // no retry, no fallback
    expect(recoveries).toEqual([]);
    expect(attempts).toHaveLength(1);
  });

  it('a tool call counts as output too', async () => {
    let calls = 0;
    const flaky: ChatModel = {
      provider: 'test',
      defaultModel: PRIMARY,
      async *stream() {
        calls++;
        yield { type: 'tool_call', call: { id: 'c1', name: 'issue_refund', arguments: '{}' } };
        throw new AppError('LLM_TIMEOUT', 'stalled');
      },
    };
    const { error } = await collectUntilError(resilientStream(flaky, request(), harness().opts));
    expect(error.code).toBe('LLM_TIMEOUT');
    expect(calls).toBe(1);
  });

  it('falls back to the fallback model once the primary is exhausted', async () => {
    const model = new ScriptedChatModel((req) => (req.model === PRIMARY ? { error: unavailable() } : { text: 'From the fallback' }));
    const { opts, recoveries } = harness({ maxRetries: 1 });
    const { text, done } = await collect(resilientStream(model, request(), opts));

    expect(text).toBe('From the fallback');
    expect(done).toMatchObject({ model: FALLBACK });
    expect(model.calls.map((c) => c.model)).toEqual([PRIMARY, PRIMARY, FALLBACK]);
    expect(recoveries.map((r) => r.message)).toEqual([
      'Model provider unavailable — retrying in 0.0s',
      `Model provider unavailable — switching to fallback model ${FALLBACK}`,
    ]);
    expect(recoveries[1]).toMatchObject({ attempt: 0, delayMs: 0, model: FALLBACK });
  });

  it('a non-retryable error skips the remaining retries and goes straight to the fallback', async () => {
    const model = new ScriptedChatModel((req) =>
      req.model === PRIMARY ? { error: new AppError('INTERNAL', 'rejected the request (400)', { retryable: false }) } : { text: 'ok' },
    );
    const { opts } = harness({ maxRetries: 3 });
    const { text } = await collect(resilientStream(model, request(), opts));
    expect(text).toBe('ok');
    expect(model.calls.map((c) => c.model)).toEqual([PRIMARY, FALLBACK]);
  });

  it('uses the model default when the request names none, and skips a fallback equal to the primary', async () => {
    const model = new ScriptedChatModel(() => ({ error: unavailable() }));
    const { opts } = harness({ maxRetries: 0, fallbackModel: 'fake-chat' });
    const { error } = await collectUntilError(resilientStream(model, { ...request(), model: undefined }, opts));
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(model.calls.map((c) => c.model)).toEqual(['fake-chat']);
  });

  it('throws the last error when every model and retry fails', async () => {
    const model = new ScriptedChatModel((req) => ({
      error: req.model === PRIMARY ? unavailable() : new AppError('RATE_LIMITED', 'fallback rate limited', { retryAfterMs: 5 }),
    }));
    const { opts } = harness({ maxRetries: 1 });
    const { error } = await collectUntilError(resilientStream(model, request(), opts));
    expect(error.code).toBe('RATE_LIMITED');
    expect(model.calls.map((c) => c.model)).toEqual([PRIMARY, PRIMARY, FALLBACK, FALLBACK]);
  });

  it('classifies unknown errors (non-retryable INTERNAL) instead of leaking them raw', async () => {
    const model = new ScriptedChatModel(() => ({ error: new TypeError('boom') }));
    const { error } = await collectUntilError(resilientStream(model, request(), harness({ fallbackModel: null }).opts));
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('INTERNAL');
    expect(model.calls).toHaveLength(1);
  });

  it('enforces the first-event timeout and retries (the stalled attempt is cancelled)', async () => {
    const model = new ScriptedChatModel((_req, i) => (i === 0 ? { delayMs: 5_000, text: 'too late' } : { text: 'on time' }));
    const { opts, recoveries } = harness({ firstEventTimeoutMs: 50 });
    const started = performance.now();
    const { text } = await collect(resilientStream(model, request(), opts));

    expect(text).toBe('on time');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(recoveries[0]).toMatchObject({ code: 'LLM_TIMEOUT', attempt: 1 });
    expect(model.calls).toHaveLength(2);
    // The watchdog aborts the stalled request rather than leaving it running.
    expect(model.calls[0]!.signal.aborted).toBe(true);
    expect(model.calls[1]!.signal.aborted).toBe(false);
  });

  it('beforeAttempt failures (chaos injection) are handled like real upstream failures', async () => {
    const model = new ScriptedChatModel(() => ({ text: 'fine' }));
    let injected = false;
    const { opts, recoveries } = harness({
      beforeAttempt: async () => {
        if (!injected) {
          injected = true;
          throw new AppError('RATE_LIMITED', 'Simulated 429', { retryAfterMs: 5 });
        }
      },
    });
    const { text } = await collect(resilientStream(model, request(), opts));
    expect(text).toBe('fine');
    expect(recoveries[0]).toMatchObject({ code: 'RATE_LIMITED', delayMs: 5 });
    expect(model.calls).toHaveLength(1); // the injected failure happened before the model was called
  });

  it('propagates an abort mid-request as ABORTED without retrying or falling back', async () => {
    const model = new ScriptedChatModel(() => ({ delayMs: 5_000, text: 'never' }));
    const controller = new AbortController();
    const { opts, recoveries } = harness();
    setTimeout(() => controller.abort(), 30);
    const { error } = await collectUntilError(resilientStream(model, request(controller.signal), opts));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('ABORTED');
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.signal.aborted).toBe(true);
    expect(recoveries).toEqual([]);
  });

  it('an abort during retry backoff stops further attempts', async () => {
    const model = new ScriptedChatModel(() => ({ error: unavailable(5_000) }));
    const controller = new AbortController();
    const { opts } = harness();
    setTimeout(() => controller.abort(), 30);
    const { error } = await collectUntilError(resilientStream(model, request(controller.signal), opts));
    expect(error.code).toBe('ABORTED');
    expect(model.calls).toHaveLength(1);
  });

  it('an already-aborted request never calls the model', async () => {
    const model = new ScriptedChatModel(() => ({ text: 'never' }));
    const controller = new AbortController();
    controller.abort();
    const { error } = await collectUntilError(resilientStream(model, request(controller.signal), harness().opts));
    expect(error.code).toBe('ABORTED');
    expect(model.calls).toHaveLength(0);
  });
});
