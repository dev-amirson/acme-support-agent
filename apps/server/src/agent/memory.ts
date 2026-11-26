import type { ChatMessage } from '../llm/types';
import { truncate } from '../lib/redact';
import type { StoredMessage } from '../session/session-repository';

export const HISTORY_MESSAGE_LIMIT = 48;
const TOOL_RESULT_CHARS_IN_HISTORY = 3_000;

/**
 * Turn persisted messages into the model's working memory.
 *
 * - Text and voice turns share one log, so memory is identical across modes by construction.
 * - The window starts on a user message, so we never hand the model an orphaned tool result
 *   (the API rejects tool messages whose tool_call isn't present).
 * - Assistant tool-call messages whose results are missing (e.g. an aborted turn) are dropped.
 * - Interrupted voice replies are truncated to what the customer actually heard, and labelled.
 * - Identity/tier facts don't depend on this window: they're re-injected into the system prompt
 *   every turn from session state, so trimming old messages can't make the agent "forget" them.
 */
export function buildHistory(messages: StoredMessage[]): ChatMessage[] {
  const firstUser = messages.findIndex((m) => m.role === 'user');
  const window = firstUser === -1 ? [] : messages.slice(firstUser);
  const answered = new Set(window.filter((m) => m.role === 'tool').map((m) => m.toolCallId));

  const out: ChatMessage[] = [];
  for (const m of window) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.mode === 'voice' ? `${m.content}` : m.content });
    } else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).filter((c) => answered.has(c.id));
      const heard = m.content.trimEnd();
      const content = m.interrupted ? `${heard}${heard ? ' ' : ''}[customer interrupted — they did not hear the rest]` : m.content;
      if (!content && !calls.length) continue;
      out.push({ role: 'assistant', content: content || null, ...(calls.length ? { toolCalls: calls } : {}) });
    } else if (m.role === 'tool' && m.toolCallId) {
      out.push({ role: 'tool', toolCallId: m.toolCallId, content: truncate(m.content, TOOL_RESULT_CHARS_IN_HISTORY) });
    }
  }
  // Drop tool messages whose assistant call was filtered out above.
  const offered = new Set(out.flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.id) : [])));
  return out.filter((m) => m.role !== 'tool' || offered.has(m.toolCallId));
}
