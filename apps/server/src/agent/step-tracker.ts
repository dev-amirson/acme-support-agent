import type { AgentEvent, ErrorCode, StepKind, StepRecord, StepStatus } from '@acme/contracts';
import { newId } from '../lib/ids';
import type { StepSink } from '../tools/runner';

/**
 * Emits step lifecycle events (the UI's live status indicators) and keeps a persisted record so a
 * reloaded transcript shows the same timeline.
 */
export class StepTracker implements StepSink {
  readonly records: StepRecord[] = [];
  private readonly startedAt = new Map<string, number>();

  constructor(
    private readonly turnId: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  begin(kind: StepKind, name: string, label: string): string {
    const stepId = newId('step');
    this.started({ stepId, kind, name, label });
    return stepId;
  }

  started(step: { stepId: string; kind: StepKind; name: string; label: string }): void {
    this.startedAt.set(step.stepId, performance.now());
    this.records.push({ ...step, status: 'running', progress: [] });
    this.emit({ type: 'step.started', turnId: this.turnId, ...step });
  }

  progress(stepId: string, label: string): void {
    this.records.find((r) => r.stepId === stepId)?.progress?.push(label);
    this.emit({ type: 'step.progress', turnId: this.turnId, stepId, label });
  }

  completed(step: { stepId: string; status: Exclude<StepStatus, 'running'>; label: string; summary: string; durationMs: number }): void {
    const rec = this.records.find((r) => r.stepId === step.stepId);
    if (rec) Object.assign(rec, { status: step.status, summary: step.summary, durationMs: step.durationMs });
    this.emit({ type: 'step.completed', turnId: this.turnId, ...step });
  }

  finish(stepId: string, status: Exclude<StepStatus, 'running'>, summary: string): void {
    const rec = this.records.find((r) => r.stepId === stepId);
    const t0 = this.startedAt.get(stepId) ?? performance.now();
    this.completed({ stepId, status, label: rec?.label ?? '', summary, durationMs: Math.round(performance.now() - t0) });
  }

  /** Close any step left running (e.g. when a turn aborts mid-step). */
  closeDangling(summary: string): void {
    for (const r of this.records.filter((x) => x.status === 'running')) this.finish(r.stepId, 'error', summary);
  }

  recovery(info: { code: ErrorCode; attempt: number; delayMs: number; message: string }): void {
    this.emit({ type: 'recovery', turnId: this.turnId, ...info });
  }
}
