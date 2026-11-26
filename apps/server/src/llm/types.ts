/**
 * Provider-agnostic model contracts. The orchestrator only ever sees these types, so swapping
 * OpenAI for another provider (or a scripted fake in tests) touches nothing above this layer.
 */

export interface ChatToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as produced by the model — validated by the tool runner. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ChatToolCall[];
      /** Provider-specific items (e.g. encrypted reasoning) replayed within a turn; never persisted. */
      opaque?: unknown[];
    }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

export interface ChatRequest {
  messages: ChatMessage[];
  /** Overrides the model's default. */
  model?: string;
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxOutputTokens?: number;
  /** Per-call override of the model's configured reasoning effort (reasoning models only). */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** Strict JSON-schema structured output. */
  responseFormat?: { name: string; schema: Record<string, unknown> };
  signal: AbortSignal;
}

export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  /** Emitted once per tool call, only after its arguments have fully streamed. */
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'done'; finishReason: string; usage: TokenUsage; model: string; opaque?: unknown[] };

export interface ChatModel {
  readonly provider: string;
  readonly defaultModel: string;
  stream(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

/** Collect a full non-streaming completion (used for judge / classifier calls). */
export async function completeText(
  model: ChatModel,
  request: ChatRequest,
): Promise<{ text: string; usage: TokenUsage; model: string }> {
  let text = '';
  let usage = EMPTY_USAGE;
  let resolvedModel = request.model ?? model.defaultModel;
  for await (const ev of model.stream(request)) {
    if (ev.type === 'text') text += ev.delta;
    if (ev.type === 'done') {
      usage = ev.usage;
      resolvedModel = ev.model;
    }
  }
  return { text, usage, model: resolvedModel };
}
