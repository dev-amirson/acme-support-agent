import { AppError, isAbortError } from './errors';

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('ABORTED', 'Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError('ABORTED', 'Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Full-jitter exponential backoff (AWS architecture blog), capped. */
export function backoffDelay(attempt: number, baseMs = 400, capMs = 8_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

export interface RetryOptions {
  /** Total attempts including the first. */
  attempts: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (info: { err: unknown; attempt: number; delayMs: number }) => void;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (isAbortError(err)) throw err;
      const retryable = opts.shouldRetry
        ? opts.shouldRetry(err, attempt)
        : err instanceof AppError && err.retryable;
      if (!retryable || attempt === opts.attempts - 1) throw err;
      const hinted = err instanceof AppError ? err.retryAfterMs : undefined;
      const delayMs = Math.min(10_000, hinted ?? backoffDelay(attempt, opts.baseDelayMs));
      opts.onRetry?.({ err, attempt: attempt + 1, delayMs });
      await sleep(delayMs, opts.signal);
    }
  }
  throw lastErr;
}

/** Combine signals; the result aborts when any input aborts (Node ≥ 20 has AbortSignal.any). */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  return AbortSignal.any(signals.filter((s): s is AbortSignal => Boolean(s)));
}

/** Run `fn` with a hard deadline; the inner signal aborts on timeout so work is actually cancelled. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
  opts: { signal?: AbortSignal; onTimeout: () => AppError },
): Promise<T> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), ms);
  const signal = anySignal(opts.signal, timeoutController.signal);
  try {
    return await fn(signal);
  } catch (err) {
    if (timeoutController.signal.aborted && !opts.signal?.aborted) throw opts.onTimeout();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unbounded single-consumer async queue. Producers push synchronously; the consumer iterates.
 * Used to turn callback-style event emission into an async iterable for transports.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

/** Serialises async work per key (e.g. one in-flight turn per session). */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => current);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
