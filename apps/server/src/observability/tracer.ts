import type { SpanKind, TraceSpan, UsageLine } from '@acme/contracts';
import { newId } from '../lib/ids';
import { redactDeep } from '../lib/redact';

export interface SpanHandle {
  readonly id: string;
  setAttributes(attrs: Record<string, unknown>): void;
  end(result?: { attributes?: Record<string, unknown>; usage?: UsageLine }): void;
  fail(error: unknown, attributes?: Record<string, unknown>): void;
  child(kind: SpanKind, name: string, attributes?: Record<string, unknown>): SpanHandle;
}

export interface SpanRecorder {
  start(kind: SpanKind, name: string, attributes?: Record<string, unknown>, parentId?: string | null): SpanHandle;
  addUsage(line: UsageLine): void;
}

/**
 * Minimal in-process tracer, OpenTelemetry-shaped (spans with parent ids, attributes, status)
 * without the SDK weight. Spans stream to the UI live and the full trace is persisted per turn.
 * Swapping in an OTLP exporter later only means mirroring `onSpan` to a collector.
 */
export class TurnTracer implements SpanRecorder {
  readonly spans: TraceSpan[] = [];
  readonly usage: UsageLine[] = [];

  constructor(private readonly onSpan: (span: TraceSpan) => void = () => undefined) {}

  start(
    kind: SpanKind,
    name: string,
    attributes: Record<string, unknown> = {},
    parentId: string | null = null,
  ): SpanHandle {
    const span: TraceSpan = {
      id: newId('span'),
      parentId,
      kind,
      name,
      startedAt: Date.now(),
      endedAt: null,
      durationMs: null,
      status: 'running',
      attributes: redactDeep(attributes),
    };
    const t0 = performance.now();
    this.spans.push(span);
    this.onSpan({ ...span });

    let closed = false;
    const close = (status: 'ok' | 'error', patch: Partial<TraceSpan>) => {
      if (closed) return;
      closed = true;
      span.status = status;
      span.endedAt = Date.now();
      span.durationMs = Math.round(performance.now() - t0);
      Object.assign(span, patch);
      if (patch.usage) this.usage.push(patch.usage);
      this.onSpan({ ...span, attributes: { ...span.attributes } });
    };

    const handle: SpanHandle = {
      id: span.id,
      setAttributes: (attrs) => Object.assign(span.attributes, redactDeep(attrs)),
      end: (result = {}) => {
        if (result.attributes) Object.assign(span.attributes, redactDeep(result.attributes));
        close('ok', result.usage ? { usage: result.usage } : {});
      },
      fail: (error, attrs) => {
        if (attrs) Object.assign(span.attributes, redactDeep(attrs));
        close('error', { error: error instanceof Error ? error.message : String(error) });
      },
      child: (childKind, childName, childAttrs) => this.start(childKind, childName, childAttrs, span.id),
    };
    return handle;
  }

  addUsage(line: UsageLine): void {
    this.usage.push(line);
  }
}

/** No-op recorder for code paths that run outside a turn (ingestion, evals). */
export const NOOP_RECORDER: SpanRecorder = {
  start: () => NOOP_SPAN,
  addUsage: () => undefined,
};
const NOOP_SPAN: SpanHandle = {
  id: 'noop',
  setAttributes: () => undefined,
  end: () => undefined,
  fail: () => undefined,
  child: () => NOOP_SPAN,
};
