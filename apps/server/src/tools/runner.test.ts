import { DEFAULT_CHAOS, type ChaosConfig, type ToolName } from '@acme/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ChaosController } from '../agent/chaos';
import { TurnState } from '../agent/turn-state';
import { buildFixtures } from '../domain/crm-fixtures';
import { sleep } from '../lib/async';
import { AppError } from '../lib/errors';
import type { ChatToolCall } from '../llm/types';
import { TurnTracer } from '../observability/tracer';
import type { SessionRow } from '../session/session-repository';
import type { ToolRegistry } from './registry';
import { ToolRunner, type ChaosHook, type StepSink } from './runner';
import { defineTool, type ToolDefinition, type ToolOutcome } from './types';

// -- a minimal fake registry: no DB, no CRM, just behaviour we control --------------------------

type Exec = (args: Record<string, unknown>, ctx: { signal: AbortSignal; progress(l: string): void }) => Promise<ToolOutcome>;

function fakeTool(name: ToolName, opts: { requiresVerifiedCustomer?: boolean; mutating?: boolean; execute?: Exec } = {}) {
  const execute = vi.fn<Exec>(opts.execute ?? (async (args) => ({ summary: `${name} ok`, result: { echo: args } })));
  const def = defineTool({
    name,
    description: `fake ${name}`,
    schema: z.object({ query: z.string() }),
    label: `Running ${name}…`,
    requiresVerifiedCustomer: opts.requiresVerifiedCustomer ?? false,
    mutating: opts.mutating ?? false,
    execute: (args, ctx) => execute(args as Record<string, unknown>, ctx),
  });
  return { def, execute };
}

function registryOf(...defs: ToolDefinition[]): ToolRegistry {
  return new Map(defs.map((d) => [d.name, d]));
}

const alice = buildFixtures(new Date()).customers.find((c) => c.id === 'AC-1001')!;

function context(opts: { verified?: boolean; abort?: AbortController; deadline?: AbortController } = {}) {
  const turn = new TurnState(opts.verified ? alice : null);
  const session: SessionRow = {
    id: '00000000-0000-4000-8000-000000000000',
    status: 'active',
    customerId: opts.verified ? alice.id : null,
    verifiedAt: null,
    failedVerifications: 0,
    escalation: null,
    chaos: DEFAULT_CHAOS,
    turnCount: 0,
    createdAt: new Date(),
  };
  const tracer = new TurnTracer();
  const base = {
    sessionId: session.id,
    turnId: 'turn_test',
    mode: 'text' as const,
    userMessage: 'hello',
    session,
    turn,
    recorder: tracer,
    effects: {
      markVerified: vi.fn(async () => undefined),
      recordFailedVerification: vi.fn(async () => 1),
      escalate: vi.fn(async () => undefined),
    },
    now: () => new Date(),
    abortSignal: (opts.abort ?? new AbortController()).signal,
    deadlineSignal: (opts.deadline ?? new AbortController()).signal,
  };
  const steps = {
    started: [] as Parameters<StepSink['started']>[0][],
    progress: [] as string[],
    completed: [] as Parameters<StepSink['completed']>[0][],
    recovery: [] as Parameters<StepSink['recovery']>[0][],
  };
  const sink: StepSink = {
    started: (s) => steps.started.push(s),
    progress: (_id, l) => steps.progress.push(l),
    completed: (s) => steps.completed.push(s),
    recovery: (r) => steps.recovery.push(r),
  };
  return { base, turn, tracer, steps, sink };
}

const noChaos: ChaosHook = { shouldFailTool: () => false };
const chaos = (failTool: ToolName, mode: ChaosConfig['failToolMode']) =>
  new ChaosController({ ...DEFAULT_CHAOS, failTool, failToolMode: mode }, true);

let callSeq = 0;
const call = (name: string, args: unknown): ChatToolCall => ({
  id: `call_${++callSeq}`,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
});
const payload = (content: string) => JSON.parse(content) as Record<string, unknown>;

describe('ToolRunner', () => {
  it('runs a valid call and records evidence, steps and a span', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink, steps, turn, tracer } = context();

    const r = await runner.run(call('search_knowledge_base', { query: 'refunds' }), base, sink, noChaos);

    expect(r.status).toBe('ok');
    expect(r.summary).toBe('search_knowledge_base ok');
    expect(payload(r.content)).toEqual({ echo: { query: 'refunds' } });
    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(turn.toolCalls).toBe(1);
    expect(turn.toolEvidence).toEqual([r.content]);
    expect(steps.started).toMatchObject([{ kind: 'tool', name: 'search_knowledge_base', label: 'Running search_knowledge_base…' }]);
    expect(steps.completed).toMatchObject([{ status: 'ok', summary: 'search_knowledge_base ok' }]);
    expect(tracer.spans).toMatchObject([{ kind: 'tool', name: 'search_knowledge_base', status: 'ok' }]);
  });

  it('invalid JSON arguments come back as an INVALID_ARGUMENTS result, not a throw', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink, steps } = context();

    const r = await runner.run(call('search_knowledge_base', '{"query": "refu'), base, sink, noChaos);

    expect(r.status).toBe('error');
    expect(payload(r.content)).toMatchObject({ error: 'INVALID_ARGUMENTS', message: expect.stringMatching(/not valid JSON/) });
    expect(search.execute).not.toHaveBeenCalled();
    expect(steps.completed).toMatchObject([{ status: 'error', summary: 'Invalid arguments' }]);
  });

  it('schema violations come back as INVALID_ARGUMENTS with the offending paths', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink } = context();

    const r = await runner.run(call('search_knowledge_base', { query: 42 }), base, sink, noChaos);

    expect(r.status).toBe('error');
    const body = payload(r.content);
    expect(body.error).toBe('INVALID_ARGUMENTS');
    expect(body.issues).toEqual([expect.objectContaining({ path: 'query' })]);
    expect(search.execute).not.toHaveBeenCalled();
  });

  it('empty arguments are treated as {} and validated', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const r = await runner.run(call('search_knowledge_base', ''), context().base, context().sink, noChaos);
    expect(payload(r.content).error).toBe('INVALID_ARGUMENTS');
  });

  it('an unknown tool name is reported back to the model', async () => {
    const runner = new ToolRunner(registryOf(), { timeoutMs: 1_000, maxAttempts: 2 });
    const r = await runner.run(call('delete_everything', {}), context().base, context().sink, noChaos);
    expect(r.status).toBe('error');
    expect(payload(r.content).error).toBe('UNKNOWN_TOOL');
  });

  it('requiresVerifiedCustomer without a customer → skipped + PRECONDITION_FAILED, tool never runs', async () => {
    const billing = fakeTool('get_billing_history', { requiresVerifiedCustomer: true });
    const runner = new ToolRunner(registryOf(billing.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink, steps, turn } = context({ verified: false });

    const r = await runner.run(call('get_billing_history', { query: 'x' }), base, sink, noChaos);

    expect(r.status).toBe('skipped');
    expect(payload(r.content)).toMatchObject({ error: 'PRECONDITION_FAILED', message: expect.stringMatching(/verify_customer_identity/) });
    expect(billing.execute).not.toHaveBeenCalled();
    expect(steps.completed).toMatchObject([{ status: 'skipped' }]);
    expect(turn.toolEvidence).toEqual([]);
  });

  it('requiresVerifiedCustomer with a verified customer runs normally', async () => {
    const billing = fakeTool('get_billing_history', { requiresVerifiedCustomer: true });
    const runner = new ToolRunner(registryOf(billing.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const r = await runner.run(call('get_billing_history', { query: 'x' }), context({ verified: true }).base, context().sink, noChaos);
    expect(r.status).toBe('ok');
    expect(billing.execute).toHaveBeenCalledTimes(1);
  });

  it('chaos transient: the first attempt fails, the retry succeeds', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 2_000, maxAttempts: 2 });
    const { base, sink, steps, turn } = context();
    const ctl = chaos('search_knowledge_base', 'transient');

    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), base, sink, ctl);

    expect(r.status).toBe('ok');
    expect(search.execute).toHaveBeenCalledTimes(1); // the failed attempt never reached the backend
    expect(steps.recovery).toEqual([expect.objectContaining({ code: 'TOOL_FAILED', attempt: 1 })]);
    expect(steps.progress.some((p) => /Simulated outage.*retrying/.test(p))).toBe(true);
    expect(turn.failedTools.size).toBe(0);
    // One-shot: the flag disarms after the tool ran.
    ctl.afterTool();
    expect(ctl.current.failTool).toBeNull();
    expect(ctl.changed).toBe(true);
  });

  it('chaos persistent: every attempt fails → TOOL_UNAVAILABLE result (never a throw)', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 2_000, maxAttempts: 2 });
    const { base, sink, steps, turn } = context();

    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), base, sink, chaos('search_knowledge_base', 'persistent'));

    expect(r.status).toBe('error');
    expect(payload(r.content)).toMatchObject({ error: 'TOOL_UNAVAILABLE', message: expect.stringMatching(/Do not guess/) });
    expect(r.summary).toMatch(/^Unavailable — Simulated outage/);
    expect(search.execute).not.toHaveBeenCalled();
    expect(steps.recovery).toHaveLength(1); // one retry between two attempts
    expect([...turn.failedTools]).toEqual(['search_knowledge_base']);
  });

  it('chaos aimed at a different tool has no effect', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), context().base, context().sink, chaos('issue_refund', 'persistent'));
    expect(r.status).toBe('ok');
  });

  it('a backend that throws is retried, then reported as unavailable', async () => {
    const search = fakeTool('search_knowledge_base', {
      execute: async () => {
        throw new Error('ECONNREFUSED crm.internal');
      },
    });
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink, turn } = context();
    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), base, sink, noChaos);
    expect(search.execute).toHaveBeenCalledTimes(2);
    expect(payload(r.content).error).toBe('TOOL_UNAVAILABLE');
    expect(turn.failedTools.has('search_knowledge_base')).toBe(true);
  });

  it('a non-retryable AppError is not retried', async () => {
    const search = fakeTool('search_knowledge_base', {
      execute: async () => {
        throw new AppError('VALIDATION', 'bad request to backend');
      },
    });
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 3 });
    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), context().base, context().sink, noChaos);
    expect(search.execute).toHaveBeenCalledTimes(1);
    expect(payload(r.content).error).toBe('TOOL_UNAVAILABLE');
  });

  it('a hung backend times out and the tool signal is aborted', async () => {
    const seen: AbortSignal[] = [];
    const search = fakeTool('search_knowledge_base', {
      execute: async (_args, ctx) => {
        seen.push(ctx.signal);
        await sleep(10_000, ctx.signal);
        return { summary: 'never', result: {} };
      },
    });
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 40, maxAttempts: 1 });
    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), context().base, context().sink, noChaos);
    expect(r.summary).toMatch(/timed out after 40ms/);
    expect(seen[0]!.aborted).toBe(true);
  });

  it('identical read-only calls in one turn are served from the per-turn cache', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink, turn } = context();

    const first = await runner.run(call('search_knowledge_base', { query: 'refunds' }), base, sink, noChaos);
    const second = await runner.run(call('search_knowledge_base', { query: 'refunds' }), base, sink, noChaos);
    const different = await runner.run(call('search_knowledge_base', { query: 'invoices' }), base, sink, noChaos);

    expect(search.execute).toHaveBeenCalledTimes(2); // 'refunds' once, 'invoices' once
    expect(second.status).toBe('ok');
    expect(second.summary).toBe('Reused result from earlier in this turn');
    expect(payload(second.content)).toEqual({ ...payload(first.content), note: expect.stringMatching(/Identical call already made/) });
    expect(payload(different.content)).toEqual({ echo: { query: 'invoices' } });
    expect(turn.toolCalls).toBe(3);
  });

  it('the cache is per turn: a new TurnState executes again', async () => {
    const search = fakeTool('search_knowledge_base');
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 2 });
    await runner.run(call('search_knowledge_base', { query: 'refunds' }), context().base, context().sink, noChaos);
    await runner.run(call('search_knowledge_base', { query: 'refunds' }), context().base, context().sink, noChaos);
    expect(search.execute).toHaveBeenCalledTimes(2);
  });

  it('mutating tools are never served from the cache', async () => {
    const refund = fakeTool('issue_refund', { mutating: true });
    const runner = new ToolRunner(registryOf(refund.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const { base, sink } = context();
    await runner.run(call('issue_refund', { query: 'INV-1' }), base, sink, noChaos);
    await runner.run(call('issue_refund', { query: 'INV-1' }), base, sink, noChaos);
    expect(refund.execute).toHaveBeenCalledTimes(2);
  });

  it('a user abort cancels a read-only tool and propagates', async () => {
    const abort = new AbortController();
    const search = fakeTool('search_knowledge_base', {
      execute: async (_args, ctx) => {
        await sleep(10_000, ctx.signal);
        return { summary: 'never', result: {} };
      },
    });
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 20_000, maxAttempts: 2 });
    const { base, sink, steps } = context({ abort });
    setTimeout(() => abort.abort(), 20);

    await expect(runner.run(call('search_knowledge_base', { query: 'x' }), base, sink, noChaos)).rejects.toMatchObject({ code: 'ABORTED' });
    expect(search.execute).toHaveBeenCalledTimes(1); // not retried
    expect(steps.completed).toMatchObject([{ status: 'error', summary: 'Cancelled' }]);
  });

  it('a user abort does not interrupt a mutating tool (side effects complete atomically)', async () => {
    const abort = new AbortController();
    const refund = fakeTool('issue_refund', {
      mutating: true,
      execute: async (_args, ctx) => {
        abort.abort(); // customer barges in mid-refund
        await sleep(30, ctx.signal);
        return { summary: 'Refund issued', result: { status: 'refunded' } };
      },
    });
    const runner = new ToolRunner(registryOf(refund.def), { timeoutMs: 1_000, maxAttempts: 2 });
    const r = await runner.run(call('issue_refund', { query: 'INV-1' }), context({ abort }).base, context().sink, noChaos);
    expect(r.status).toBe('ok');
    expect(payload(r.content)).toEqual({ status: 'refunded' });
  });

  it('bounds very large results handed back to the model', async () => {
    const search = fakeTool('search_knowledge_base', { execute: async () => ({ summary: 'big', result: { blob: 'x'.repeat(20_000) } }) });
    const runner = new ToolRunner(registryOf(search.def), { timeoutMs: 1_000, maxAttempts: 1 });
    const r = await runner.run(call('search_knowledge_base', { query: 'x' }), context().base, context().sink, noChaos);
    expect(r.content.length).toBe(6_000);
  });
});
