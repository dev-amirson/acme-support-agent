import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ErrorCode } from '@acme/contracts';

/**
 * Every failure that crosses a module boundary is normalised into an AppError so that the
 * orchestrator and transports can make decisions (retry? fall back? tell the user?) from a
 * small, closed set of codes rather than from vendor-specific exception types.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus: number;
  /** Server-suggested wait before retrying (e.g. from a Retry-After header). */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; httpStatus?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable ?? DEFAULT_RETRYABLE[code];
    this.httpStatus = opts.httpStatus ?? DEFAULT_STATUS[code];
    this.retryAfterMs = opts.retryAfterMs;
  }
}

const DEFAULT_RETRYABLE: Record<ErrorCode, boolean> = {
  LLM_TIMEOUT: true,
  RATE_LIMITED: true,
  UPSTREAM_UNAVAILABLE: true,
  TOOL_FAILED: true,
  BUDGET_EXCEEDED: false,
  VALIDATION: false,
  SESSION_NOT_FOUND: false,
  TURN_IN_PROGRESS: true,
  ABORTED: false,
  VOICE_UNAVAILABLE: false,
  INTERNAL: false,
};

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  LLM_TIMEOUT: 504,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  TOOL_FAILED: 502,
  BUDGET_EXCEEDED: 503,
  VALIDATION: 400,
  SESSION_NOT_FOUND: 404,
  TURN_IN_PROGRESS: 409,
  ABORTED: 499,
  VOICE_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export function isAbortError(err: unknown): boolean {
  if (err instanceof APIUserAbortError) return true;
  if (err instanceof AppError) return err.code === 'ABORTED';
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function parseRetryAfter(headers: Headers | undefined): number | undefined {
  const raw = headers?.get('retry-after-ms') ?? null;
  if (raw && Number.isFinite(Number(raw))) return Number(raw);
  const secs = headers?.get('retry-after');
  if (secs && Number.isFinite(Number(secs))) return Number(secs) * 1000;
  return undefined;
}

/** Map anything thrown by an upstream model call into an AppError. */
export function classifyUpstreamError(err: unknown, what = 'Model provider'): AppError {
  if (err instanceof AppError) return err;
  if (isAbortError(err)) return new AppError('ABORTED', 'Request was cancelled', { cause: err });
  if (err instanceof APIConnectionTimeoutError) {
    return new AppError('LLM_TIMEOUT', `${what} timed out`, { cause: err });
  }
  if (err instanceof APIError) {
    const status = err.status ?? 0;
    const retryAfterMs = parseRetryAfter(err.headers as Headers | undefined);
    if (status === 429) {
      // insufficient_quota is a 429 that will never succeed on retry.
      const quota = (err as APIError & { code?: string }).code === 'insufficient_quota';
      return new AppError('RATE_LIMITED', quota ? `${what} quota exhausted` : `${what} rate limited`, {
        retryable: !quota,
        retryAfterMs,
        cause: err,
      });
    }
    if (status === 408) return new AppError('LLM_TIMEOUT', `${what} timed out`, { cause: err });
    if (status >= 500 || status === 0) {
      return new AppError('UPSTREAM_UNAVAILABLE', `${what} unavailable (${status || 'network'})`, {
        retryAfterMs,
        cause: err,
      });
    }
    return new AppError('INTERNAL', `${what} rejected the request (${status}): ${err.message}`, {
      retryable: false,
      cause: err,
    });
  }
  if (err instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(err.message)) {
    return new AppError('UPSTREAM_UNAVAILABLE', `${what} connection failed`, { cause: err });
  }
  return new AppError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
}

/** Message safe to show an end user for a given code. */
export function userFacingMessage(code: ErrorCode): string {
  switch (code) {
    case 'LLM_TIMEOUT':
      return 'Our assistant took too long to respond. Your conversation is saved — please try again.';
    case 'RATE_LIMITED':
      return 'We are handling a lot of requests right now. Please wait a moment and try again.';
    case 'UPSTREAM_UNAVAILABLE':
      return 'Our AI provider is temporarily unavailable. Your conversation is saved — please retry shortly.';
    case 'TOOL_FAILED':
      return 'One of our internal systems is not responding. A human specialist can help if it persists.';
    case 'BUDGET_EXCEEDED':
      return 'The demo has reached its usage budget for today. Please try again tomorrow.';
    case 'VALIDATION':
      return 'That request was not valid.';
    case 'SESSION_NOT_FOUND':
      return 'This conversation could not be found. Start a new one to continue.';
    case 'TURN_IN_PROGRESS':
      return 'Still working on your previous message — one moment.';
    case 'ABORTED':
      return 'Response stopped.';
    case 'VOICE_UNAVAILABLE':
      return 'Voice mode is unavailable right now. You can keep chatting by text.';
    case 'INTERNAL':
    default:
      return 'Something went wrong on our side. Your conversation is saved — please try again.';
  }
}
