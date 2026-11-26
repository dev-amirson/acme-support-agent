import type { ErrorCode } from '@acme/contracts';
import { anySignal, backoffDelay, sleep } from '../lib/async';
import { AppError, classifyUpstreamError } from '../lib/errors';
import type { ChatModel, ChatRequest, ChatStreamEvent } from './types';

export interface RecoveryInfo {
  code: ErrorCode;
  attempt: number;
  delayMs: number;
  message: string;
  model: string;
}

export interface AttemptRecord {
  model: string;
  attempt: number;
  ok: boolean;
  durationMs: number;
  error?: { code: ErrorCode; message: string };
}

export interface ResilientStreamOptions {
  /** Max wait for the first event (covers queueing + reasoning time). */
  firstEventTimeoutMs: number;
  /** Max gap between consecutive events once streaming. */
  idleTimeoutMs: number;
  /** Retries per model, on retryable errors, before falling back. */
  maxRetries: number;
  fallbackModel?: string | null;
  onRecovery?: (info: RecoveryInfo) => void;
  onAttempt?: (record: AttemptRecord) => void;
  /** Hook to inject simulated failures (chaos testing). Throwing here counts as a real failure. */
  beforeAttempt?: (ctx: { model: string; attempt: number; signal: AbortSignal }) => Promise<void>;
}

/**
 * Wraps a streaming model call with the production failure policy:
 *
 *  - watchdog timeouts for first event and for mid-stream stalls (the SDK's own timeout only
 *    covers the whole request, which is useless for detecting a stalled stream);
 *  - bounded retries with full-jitter backoff that honour Retry-After;
 *  - a different fallback model once the primary is exhausted;
 *  - **never** retrying after output has been emitted — that would duplicate text the user
 *    already saw. Such failures propagate and the UI offers a manual retry instead.
 */
export async function* resilientStream(
  model: ChatModel,
  request: ChatRequest,
  opts: ResilientStreamOptions,
): AsyncGenerator<ChatStreamEvent> {
  const primary = request.model ?? model.defaultModel;
  const candidates = [primary, opts.fallbackModel].filter(
    (m, i, arr): m is string => Boolean(m) && arr.indexOf(m) === i,
  );
  let lastError: AppError | undefined;

  for (const [modelIndex, modelName] of candidates.entries()) {
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      if (request.signal.aborted) throw new AppError('ABORTED', 'Aborted');
      const startedAt = performance.now();
      const local = new AbortController();
      const signal = anySignal(request.signal, local.signal);
      let emitted = false;
      try {
        await opts.beforeAttempt?.({ model: modelName, attempt, signal });
        const source = model.stream({ ...request, model: modelName, signal });
        for await (const ev of watchdog(source, opts, () => local.abort())) {
          if (ev.type !== 'done') emitted = true;
          yield ev;
        }
        opts.onAttempt?.({ model: modelName, attempt, ok: true, durationMs: performance.now() - startedAt });
        return;
      } catch (raw) {
        const err = request.signal.aborted
          ? new AppError('ABORTED', 'Aborted', { cause: raw })
          : classifyUpstreamError(raw);
        opts.onAttempt?.({
          model: modelName,
          attempt,
          ok: false,
          durationMs: performance.now() - startedAt,
          error: { code: err.code, message: err.message },
        });
        if (err.code === 'ABORTED' || emitted) throw err;
        lastError = err;
        if (!err.retryable) break; // e.g. 400 — a different model may still accept the request
        if (attempt < opts.maxRetries) {
          const delayMs = Math.min(8_000, err.retryAfterMs ?? backoffDelay(attempt));
          opts.onRecovery?.({
            code: err.code,
            attempt: attempt + 1,
            delayMs,
            model: modelName,
            message: `${describe(err.code)} — retrying in ${(delayMs / 1000).toFixed(1)}s`,
          });
          await sleep(delayMs, request.signal);
        }
      }
    }
    const next = candidates[modelIndex + 1];
    if (next && lastError) {
      opts.onRecovery?.({
        code: lastError.code,
        attempt: 0,
        delayMs: 0,
        model: next,
        message: `${describe(lastError.code)} — switching to fallback model ${next}`,
      });
    }
  }
  throw lastError ?? new AppError('INTERNAL', 'Model call failed');
}

function describe(code: ErrorCode): string {
  switch (code) {
    case 'RATE_LIMITED':
      return 'Model provider is rate limiting';
    case 'LLM_TIMEOUT':
      return 'Model provider timed out';
    case 'UPSTREAM_UNAVAILABLE':
      return 'Model provider unavailable';
    default:
      return 'Model call failed';
  }
}

async function* watchdog(
  source: AsyncIterable<ChatStreamEvent>,
  opts: Pick<ResilientStreamOptions, 'firstEventTimeoutMs' | 'idleTimeoutMs'>,
  abort: () => void,
): AsyncGenerator<ChatStreamEvent> {
  const it = source[Symbol.asyncIterator]();
  let first = true;
  try {
    while (true) {
      const ms = first ? opts.firstEventTimeoutMs : opts.idleTimeoutMs;
      const next = it.next();
      next.catch(() => undefined); // the losing side of the race must not become unhandled
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(
            new AppError(
              'LLM_TIMEOUT',
              first ? `No response from model within ${ms}ms` : `Model stream stalled for ${ms}ms`,
            ),
          );
        }, ms);
      });
      let result: IteratorResult<ChatStreamEvent>;
      try {
        result = await Promise.race([next, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) return;
      first = false;
      yield result.value;
    }
  } finally {
    void Promise.resolve(it.return?.()).catch(() => undefined);
  }
}
