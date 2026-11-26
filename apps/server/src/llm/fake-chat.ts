import { sleep } from '../lib/async';
import type { ChatModel, ChatRequest, ChatStreamEvent } from './types';

export interface ScriptedResponse {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  /** Delay before the first event (to exercise timeouts). */
  delayMs?: number;
  /** Throw this instead of responding. */
  error?: Error;
}

export type ChatScript = (request: ChatRequest, callIndex: number) => ScriptedResponse;

/**
 * Deterministic model driven by a script function. Used by the orchestrator test-suite and by
 * the offline mode (AI_PROVIDER=fake) so CI and reviewers can run the whole stack without a key.
 */
export class ScriptedChatModel implements ChatModel {
  readonly provider = 'fake';
  readonly defaultModel = 'fake-chat';
  calls: ChatRequest[] = [];

  constructor(private readonly script: ChatScript) {}

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const index = this.calls.length;
    this.calls.push(request);
    const res = this.script(request, index);
    if (res.delayMs) await sleep(res.delayMs, request.signal);
    if (res.error) throw res.error;
    let outputChars = 0;
    if (res.text) {
      // Stream word-by-word to exercise delta handling downstream.
      for (const piece of res.text.match(/\S+\s*|\s+/g) ?? []) {
        if (request.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        outputChars += piece.length;
        yield { type: 'text', delta: piece };
      }
    }
    for (const [i, call] of (res.toolCalls ?? []).entries()) {
      const args = JSON.stringify(call.args);
      outputChars += args.length;
      yield { type: 'tool_call', call: { id: `call_${index}_${i}`, name: call.name, arguments: args } };
    }
    const inputChars = request.messages.reduce((n, m) => n + (m.content?.length ?? 0), 0);
    yield {
      type: 'done',
      finishReason: res.toolCalls?.length ? 'tool_calls' : 'stop',
      model: request.model ?? this.defaultModel,
      usage: {
        inputTokens: Math.ceil(inputChars / 4),
        cachedInputTokens: 0,
        outputTokens: Math.ceil(outputChars / 4),
        reasoningTokens: 0,
      },
    };
  }
}

/**
 * A tiny rule-based "agent" for offline mode. It is intentionally simple: it proves the plumbing
 * (tool chain → guardrails → streaming → persistence) end-to-end, not the reasoning quality.
 */
export const offlineScript: ChatScript = (request) => {
  const last = request.messages.at(-1);
  if (request.responseFormat) {
    return {
      text: JSON.stringify({
        in_domain: true,
        answerable: true,
        confidence: 0.72,
        supporting_sources: [1],
        rationale: 'Offline mode: heuristic judgement.',
      }),
    };
  }
  if (!last) return { text: 'Hello! How can I help with your Acme Cloud account today?' };

  if (last.role === 'tool') {
    try {
      const payload = JSON.parse(last.content) as Record<string, unknown>;
      const sources = payload.sources as Array<{ index: number; content: string }> | undefined;
      if (sources?.length) {
        const first = sources[0]!;
        const sentence = first.content.split(/(?<=[.!?])\s/)[0] ?? first.content;
        return { text: `Here's what our policy says: ${sentence} [${first.index}]` };
      }
      const customer = payload.customer as { name?: string; tier?: string } | undefined;
      if (customer?.name) {
        return { text: `Thanks ${customer.name} — you're verified on the ${customer.tier} plan. How can I help?` };
      }
      if (typeof payload.message === 'string') return { text: payload.message };
    } catch {
      /* fall through */
    }
    return { text: 'Done — is there anything else I can help with?' };
  }

  const text = last.content ?? '';
  const account = text.match(/\bAC-?\s?(\d{4})\b/i);
  const zip = text.match(/\b(\d{5})\b/);
  if (account && zip) {
    return {
      toolCalls: [
        {
          name: 'verify_customer_identity',
          args: { account_id: `AC-${account[1]}`, email: null, zip_code: zip[1] },
        },
      ],
    };
  }
  return { toolCalls: [{ name: 'search_knowledge_base', args: { query: text } }] };
};
