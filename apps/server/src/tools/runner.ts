import type { ErrorCode, StepStatus, ToolName } from '@acme/contracts';
import { anySignal, backoffDelay, sleep, withTimeout } from '../lib/async';
import { AppError, isAbortError } from '../lib/errors';
import { newId } from '../lib/ids';
import { truncate } from '../lib/redact';
import type { ChatToolCall } from '../llm/types';
import type { ToolRegistry } from './registry';
import type { ToolContext } from './types';

export interface StepSink {
  started(step: { stepId: string; kind: 'tool'; name: string; label: string }): void;
  progress(stepId: string, label: string): void;
  completed(step: { stepId: string; status: Exclude<StepStatus, 'running'>; label: string; summary: string; durationMs: number }): void;
  recovery(info: { code: ErrorCode; attempt: number; delayMs: number; message: string }): void;
}

export interface ChaosHook {
  /** True → this attempt of this tool must fail (simulated upstream outage). */
  shouldFailTool(tool: ToolName, attempt: number): boolean;
}

export interface ToolRunResult {
  /** JSON handed back to the model as the tool message. */
  content: string;
  status: Exclude<StepStatus, 'running'>;
  summary: string;
}

type BaseContext = Omit<ToolContext, 'span' | 'progress' | 'signal'> & {
  /** Aborts on user cancel / barge-in. */
  abortSignal: AbortSignal;
  /** Aborts only at the hard turn deadline. Mutating tools use this so side effects complete atomically. */
  deadlineSignal: AbortSignal;
};

const MAX_RESULT_CHARS = 6_000;

/**
 * Executes model-requested tool calls under a reliability contract. Failures never throw into
 * the reasoning loop: they come back to the model as structured results it can reason about
 * (correct its arguments, verify identity first, apologise and escalate…).
 */
export class ToolRunner {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly opts: { timeoutMs: number; maxAttempts: number },
  ) {}

  async run(call: ChatToolCall, base: BaseContext, steps: StepSink, chaos: ChaosHook): Promise<ToolRunResult> {
    const def = this.registry.get(call.name as ToolName);
    const stepId = newId('step');
    const label = def?.label ?? `Running ${call.name}…`;
    const started = performance.now();
    steps.started({ stepId, kind: 'tool', name: call.name, label });
    const span = base.recorder.start('tool', call.name, { arguments: safeParse(call.arguments) });
    base.turn.toolCalls++;

    const finish = (status: ToolRunResult['status'], summary: string, payload: Record<string, unknown>): ToolRunResult => {
      const content = truncate(JSON.stringify(payload), MAX_RESULT_CHARS);
      const durationMs = Math.round(performance.now() - started);
      steps.completed({ stepId, status, label, summary, durationMs });
      if (status === 'error') span.fail(new Error(summary), { result: payload });
      else span.end({ attributes: { status, summary, result: payload } });
      return { content, status, summary };
    };

    if (!def) {
      return finish('error', 'Unknown tool', { error: 'UNKNOWN_TOOL', message: `There is no tool named "${call.name}".` });
    }

    const json = safeParse(call.arguments);
    if (json === INVALID) {
      return finish('error', 'Invalid arguments', {
        error: 'INVALID_ARGUMENTS',
        message: 'Arguments were not valid JSON. Call the tool again with valid JSON arguments.',
      });
    }
    const parsed = def.schema.safeParse(json);
    if (!parsed.success) {
      return finish('error', 'Invalid arguments — asking model to correct', {
        error: 'INVALID_ARGUMENTS',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        message: 'Fix the arguments and call the tool again.',
      });
    }

    // Precondition gate: the dependency graph between tools is enforced here, not hoped for.
    if (def.requiresVerifiedCustomer && !base.turn.customer) {
      return finish('skipped', 'Blocked — identity not verified yet', {
        error: 'PRECONDITION_FAILED',
        message: `Identity is not verified. Ask the customer for their account ID (or account email) and billing ZIP code, call verify_customer_identity, then retry ${def.name}.`,
      });
    }

    const cacheKey = `${def.name}:${JSON.stringify(parsed.data)}`;
    if (!def.mutating) {
      const cached = base.turn.callCache.get(cacheKey);
      if (cached) {
        return finish('ok', 'Reused result from earlier in this turn', {
          ...(JSON.parse(cached) as Record<string, unknown>),
          note: 'Identical call already made this turn; result reused. Do not repeat it.',
        });
      }
    }

    const signalFor = def.mutating ? base.deadlineSignal : anySignal(base.abortSignal, base.deadlineSignal);
    let lastError: AppError | null = null;

    for (let attempt = 0; attempt < this.opts.maxAttempts; attempt++) {
      try {
        const outcome = await withTimeout(
          async (signal) => {
            if (chaos.shouldFailTool(def.name, attempt)) {
              await sleep(250, signal);
              throw new AppError('TOOL_FAILED', `Simulated outage: ${def.name} backend returned 503`, { retryable: true });
            }
            return def.execute(parsed.data, {
              ...base,
              signal,
              span,
              progress: (l) => steps.progress(stepId, l),
            });
          },
          this.opts.timeoutMs,
          {
            signal: signalFor,
            onTimeout: () => new AppError('TOOL_FAILED', `${def.name} timed out after ${this.opts.timeoutMs}ms`, { retryable: true }),
          },
        );
        const content = JSON.stringify(outcome.result);
        base.turn.toolEvidence.push(content);
        if (!def.mutating) base.turn.callCache.set(cacheKey, content);
        span.setAttributes({ attempts: attempt + 1 });
        return finish('ok', outcome.summary, outcome.result);
      } catch (err) {
        if (isAbortError(err) && base.abortSignal.aborted) {
          finish('error', 'Cancelled', { error: 'CANCELLED' });
          throw err;
        }
        lastError =
          err instanceof AppError
            ? err
            : new AppError('TOOL_FAILED', err instanceof Error ? err.message : String(err), { retryable: true, cause: err });
        if (!lastError.retryable) break;
        if (attempt < this.opts.maxAttempts - 1 && lastError.retryable) {
          const delayMs = backoffDelay(attempt, 300, 2_000);
          const message = `${label.replace('…', '')} failed (${lastError.message}) — retrying`;
          steps.progress(stepId, message);
          steps.recovery({ code: 'TOOL_FAILED', attempt: attempt + 1, delayMs, message });
          await sleep(delayMs, signalFor);
        }
      }
    }

    base.turn.failedTools.add(def.name);
    return finish('error', `Unavailable — ${lastError?.message ?? 'unknown error'}`, {
      error: 'TOOL_UNAVAILABLE',
      message: `The system behind ${def.name} is temporarily unavailable (${lastError?.message}). Do not guess or invent results. Briefly apologise and offer to escalate to a human specialist (create_escalation_ticket, reason tool_failure) or to try again shortly.`,
    });
  }
}

const INVALID = Symbol('invalid');
function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return INVALID;
  }
}
