import type {
  AgentEvent,
  ApiErrorBody,
  ChaosConfig,
  CreateSessionResponse,
  PublicConfig,
  SessionSnapshot,
} from '@acme/contracts';
import { readSse } from './sse';

/** Empty = same origin (production). In dev the UI runs on :3000 and the API on :8080. */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

export function wsUrl(path: string): string {
  const base = API_BASE || window.location.origin;
  return `${base.replace(/^http/, 'ws')}${path}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'UPSTREAM_UNAVAILABLE', "Can't reach the support service. Check your connection.", true);
  }
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiError(res.status, body.error.code, body.error.message, body.error.retryable);
  } catch {
    return new ApiError(res.status, 'INTERNAL', `Request failed (${res.status})`, res.status >= 500);
  }
}

export const api = {
  config: () => request<PublicConfig>('/api/config'),
  createSession: () => request<CreateSessionResponse>('/api/sessions', { method: 'POST' }),
  snapshot: (id: string) => request<SessionSnapshot>(`/api/sessions/${id}`),
  setChaos: (id: string, chaos: ChaosConfig) =>
    request<{ chaos: ChaosConfig }>(`/api/sessions/${id}/chaos`, { method: 'PUT', body: JSON.stringify(chaos) }),

  /** One chat turn. Resolves when the stream ends; events are delivered as they arrive. */
  async sendMessage(
    sessionId: string,
    message: string,
    opts: { clientTurnId: string; signal: AbortSignal; onEvent: (e: AgentEvent) => void },
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ message, clientTurnId: opts.clientTurnId }),
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal.aborted) return;
      throw new ApiError(0, 'UPSTREAM_UNAVAILABLE', "Can't reach the support service. Check your connection and retry.", true);
    }
    if (!res.ok || !res.body) throw await toApiError(res);
    await readSse(res.body, opts.signal, (data) => opts.onEvent(JSON.parse(data) as AgentEvent));
  },
};
