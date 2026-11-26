import type OpenAI from 'openai';
import type { ResponseCreateParamsStreaming, ResponseInputItem, ResponseStreamEvent } from 'openai/resources/responses/responses';
import { AppError } from '../lib/errors';
import type { ChatMessage, ChatModel, ChatRequest, ChatStreamEvent, TokenUsage } from './types';

type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** GPT-5.x / GPT-6 / o-series reject `temperature` and accept `reasoning.effort`. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-5|gpt-6|o\d)/.test(model);
}

/**
 * Provider-neutral messages → Responses API input items.
 * Assistant text that preceded tool calls is replayed as `commentary`, answers as `final_answer`
 * (OpenAI: dropping `phase` on follow-ups degrades GPT-5.x quality). Opaque reasoning items from
 * earlier steps of the same turn are passed back so the model keeps its chain of thought across
 * tool calls in stateless (`store: false`) mode.
 */
function toInput(messages: ChatMessage[]): { instructions: string | undefined; input: ResponseInputItem[] } {
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') || undefined;
  const input: ResponseInputItem[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        break;
      case 'user':
        input.push({ role: 'user', content: m.content });
        break;
      case 'tool':
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        break;
      case 'assistant': {
        for (const item of m.opaque ?? []) input.push(item as ResponseInputItem);
        if (m.content) input.push({ role: 'assistant', content: m.content, phase: m.toolCalls?.length ? 'commentary' : 'final_answer' });
        for (const c of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.arguments });
        break;
      }
    }
  }
  return { instructions, input };
}

export class OpenAIChatModel implements ChatModel {
  readonly provider = 'openai';

  constructor(
    private readonly client: OpenAI,
    readonly defaultModel: string,
    private readonly reasoningEffort: Effort | null,
  ) {}

  async *stream(request: ChatRequest): AsyncGenerator<ChatStreamEvent> {
    const model = request.model ?? this.defaultModel;
    const reasoning = isReasoningModel(model);
    const effort = request.reasoningEffort ?? this.reasoningEffort;
    const { instructions, input } = toInput(request.messages);

    const params: ResponseCreateParamsStreaming = {
      model,
      instructions,
      input,
      stream: true,
      // Stateless: nothing about the conversation is retained by the provider.
      store: false,
      ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
      ...(reasoning
        ? { ...(effort ? { reasoning: { effort } } : {}), include: ['reasoning.encrypted_content'] }
        : { temperature: 0.2 }),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({ type: 'function' as const, name: t.name, description: t.description, parameters: t.parameters, strict: false })),
            tool_choice: request.toolChoice ?? 'auto',
            parallel_tool_calls: true,
          }
        : {}),
      ...(request.responseFormat
        ? { text: { format: { type: 'json_schema' as const, name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true } } }
        : {}),
    };

    const stream = (await this.client.responses.create(params, { signal: request.signal })) as AsyncIterable<ResponseStreamEvent>;

    /*
     * Phase-aware streaming. GPT-5.x may emit a `commentary` message and then a `final_answer`
     * that repeats it; flattening both (what Chat Completions does) shows the text twice.
     * Commentary is held back: flushed as a preamble if a tool call follows, dropped if a final
     * answer supersedes it. Final-answer text streams immediately.
     */
    const phases = new Map<string, string | null | undefined>();
    let heldCommentary = '';
    const calls = new Map<string, { callId: string; name: string; arguments: string }>();
    const opaque: unknown[] = [];
    let usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let finishReason = 'stop';
    let resolvedModel = model;

    for await (const ev of stream) {
      switch (ev.type) {
        case 'response.output_item.added': {
          const item = ev.item;
          if (item.type === 'message') phases.set(item.id, item.phase);
          if (item.type === 'function_call') {
            if (heldCommentary) {
              yield { type: 'text', delta: heldCommentary };
              heldCommentary = '';
            }
            calls.set(item.id ?? item.call_id, { callId: item.call_id, name: item.name, arguments: '' });
          }
          break;
        }
        case 'response.output_text.delta': {
          if (phases.get(ev.item_id) === 'commentary') heldCommentary += ev.delta;
          else {
            heldCommentary = ''; // superseded by the final answer
            yield { type: 'text', delta: ev.delta };
          }
          break;
        }
        case 'response.function_call_arguments.done': {
          const call = calls.get(ev.item_id);
          if (call) call.arguments = ev.arguments;
          break;
        }
        case 'response.output_item.done': {
          const item = ev.item;
          if (item.type === 'function_call') {
            const call = calls.get(item.id ?? item.call_id);
            if (call) call.arguments = item.arguments || call.arguments;
          } else if (item.type === 'reasoning') {
            opaque.push(item);
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const r = ev.response;
          resolvedModel = r.model ?? model;
          if (ev.type === 'response.incomplete') finishReason = r.incomplete_details?.reason ?? 'incomplete';
          if (r.usage) {
            usage = {
              inputTokens: r.usage.input_tokens,
              cachedInputTokens: r.usage.input_tokens_details?.cached_tokens ?? 0,
              outputTokens: r.usage.output_tokens,
              reasoningTokens: r.usage.output_tokens_details?.reasoning_tokens ?? 0,
            };
          }
          break;
        }
        case 'response.failed': {
          const err = ev.response.error;
          throw new AppError('UPSTREAM_UNAVAILABLE', `Model response failed: ${err?.message ?? 'unknown error'}`, { retryable: true });
        }
        case 'error':
          throw new AppError('UPSTREAM_UNAVAILABLE', `Model stream error: ${ev.message}`, { retryable: true });
        default:
          break;
      }
    }

    if (heldCommentary) yield { type: 'text', delta: heldCommentary };
    for (const call of calls.values()) {
      yield { type: 'tool_call', call: { id: call.callId, name: call.name, arguments: call.arguments || '{}' } };
    }
    if (calls.size) finishReason = 'tool_calls';
    yield { type: 'done', finishReason, usage, model: resolvedModel, ...(opaque.length ? { opaque } : {}) };
  }
}
