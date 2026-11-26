import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '../session/session-repository';
import { buildHistory } from './memory';

let n = 0;
const base = (over: Partial<StoredMessage>): StoredMessage => ({
  id: `msg_${++n}`,
  turnId: 'turn_1',
  role: 'user',
  mode: 'text',
  content: '',
  toolCalls: null,
  toolCallId: null,
  toolName: null,
  visible: true,
  interrupted: false,
  meta: {},
  createdAt: new Date(),
  ...over,
});
const user = (content: string, over: Partial<StoredMessage> = {}) => base({ role: 'user', content, ...over });
const assistant = (content: string, over: Partial<StoredMessage> = {}) => base({ role: 'assistant', content, ...over });
const call = (id: string, name = 'get_billing_history') => ({ id, name, arguments: '{}' });
const toolCalls = (...calls: ReturnType<typeof call>[]) => assistant('', { toolCalls: calls, visible: false });
const tool = (toolCallId: string, content = '{"ok":true}') => base({ role: 'tool', toolCallId, toolName: 'x', content, visible: false });

describe('buildHistory', () => {
  it('returns an empty history when there is no user message', () => {
    expect(buildHistory([])).toEqual([]);
    expect(buildHistory([assistant('Hello!'), tool('c1')])).toEqual([]);
  });

  it('starts the window at the first user message (drops a truncated turn tail)', () => {
    const history = buildHistory([
      tool('c0'), // its assistant call fell outside the window
      assistant('…and that is the refund policy.'),
      user('Thanks. What about invoices?'),
      assistant('Sure.'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'Thanks. What about invoices?' },
      { role: 'assistant', content: 'Sure.' },
    ]);
  });

  it('keeps complete tool-call / tool-result pairs in order', () => {
    const history = buildHistory([
      user('Refund my duplicate charge'),
      toolCalls(call('c1', 'verify_customer_identity'), call('c2')),
      tool('c1', '{"verified":true}'),
      tool('c2', '{"invoices":[]}'),
      assistant('Done.'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'Refund my duplicate charge' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [call('c1', 'verify_customer_identity'), call('c2')],
      },
      { role: 'tool', toolCallId: 'c1', content: '{"verified":true}' },
      { role: 'tool', toolCallId: 'c2', content: '{"invoices":[]}' },
      { role: 'assistant', content: 'Done.' },
    ]);
  });

  it('drops tool calls whose results are missing (aborted turn)', () => {
    const history = buildHistory([
      user('Show my invoices'),
      toolCalls(call('c1')), // aborted before the tool returned
      user('Hello?'),
    ]);
    expect(history).toEqual([
      { role: 'user', content: 'Show my invoices' },
      { role: 'user', content: 'Hello?' },
    ]);
  });

  it('keeps the answered subset of a partially answered tool-call batch', () => {
    const history = buildHistory([
      user('Verify me and show invoices'),
      assistant('Let me check.', { toolCalls: [call('c1', 'verify_customer_identity'), call('c2')] }),
      tool('c1'),
      user('Still there?'),
    ]);
    expect(history[1]).toEqual({ role: 'assistant', content: 'Let me check.', toolCalls: [call('c1', 'verify_customer_identity')] });
    expect(history.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('keeps assistant text when all of its calls are dropped', () => {
    const history = buildHistory([user('Hi'), assistant('Checking now…', { toolCalls: [call('c9')] }), user('ok')]);
    expect(history[1]).toEqual({ role: 'assistant', content: 'Checking now…' });
  });

  it('drops orphaned tool results whose call is not in the window', () => {
    const history = buildHistory([user('Hi'), tool('ghost'), assistant('Hello!')]);
    expect(history).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('labels interrupted replies so the model knows the customer did not hear the rest', () => {
    const history = buildHistory([
      user('What is the refund window?', { mode: 'voice' }),
      assistant('Pro charges can be refunded within', { mode: 'voice', interrupted: true }),
      user('Sorry, go on', { mode: 'voice' }),
    ]);
    expect(history[1]).toEqual({
      role: 'assistant',
      content: 'Pro charges can be refunded within [customer interrupted — they did not hear the rest]',
    });
  });

  it('an interrupted reply with no audible text still leaves a marker', () => {
    const history = buildHistory([user('Hi'), assistant('', { interrupted: true })]);
    expect(history[1]).toEqual({ role: 'assistant', content: '[customer interrupted — they did not hear the rest]' });
  });

  it('skips empty assistant messages', () => {
    expect(buildHistory([user('Hi'), assistant(''), user('Hello?')])).toHaveLength(2);
  });

  it('bounds very large tool results', () => {
    const big = JSON.stringify({ data: 'x'.repeat(10_000) });
    const history = buildHistory([user('Hi'), toolCalls(call('c1')), tool('c1', big)]);
    const toolMsg = history.find((m) => m.role === 'tool')!;
    expect(toolMsg.content.length).toBe(3_000);
    expect(toolMsg.content.endsWith('…')).toBe(true);
  });
});
