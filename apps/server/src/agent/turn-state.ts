import type { Citation, EscalationReason, EscalationTicket, TicketPriority } from '@acme/contracts';
import { TICKET_PRIORITIES } from '@acme/contracts';
import type { CustomerRecord } from '../domain/crm-fixtures';
import type { QueueName } from '../domain/policy';
import type { RetrievalOutcome } from '../rag/knowledge-service';
import type { SearchHit } from '../rag/kb-repository';

export interface RequiredEscalation {
  reason: EscalationReason;
  queue: QueueName;
  priority: TicketPriority;
  category: string;
  summary: string;
}

/**
 * Mutable state for one turn. Tools write facts here; the orchestrator's guardrails read them.
 * Keeping it explicit (rather than inferring from the message log) makes every decision the
 * orchestrator takes testable in isolation.
 */
export class TurnState {
  readonly citations: Citation[] = [];
  readonly retrievals: RetrievalOutcome[] = [];
  /** Raw tool outputs (JSON) — the evidence a numeric grounding check runs against. */
  readonly toolEvidence: string[] = [];
  readonly failedTools = new Set<string>();
  /** name+args → result, so a looping model doesn't re-execute identical read-only calls. */
  readonly callCache = new Map<string, string>();
  requiredEscalation: RequiredEscalation | null = null;
  ticket: EscalationTicket | null = null;
  sessionChanged = false;
  toolCalls = 0;

  constructor(public customer: CustomerRecord | null) {}

  registerSources(hits: SearchHit[]): Citation[] {
    const added = hits.map((h, i) => ({
      index: this.citations.length + i + 1,
      chunkId: h.chunkId,
      docId: h.docId,
      docTitle: h.docTitle,
      section: h.headingPath.join(' › ') || h.docTitle,
      snippet: h.content.length > 600 ? `${h.content.slice(0, 600)}…` : h.content,
      similarity: Math.round(h.similarity * 1000) / 1000,
    }));
    this.citations.push(...added);
    return added;
  }

  /** Escalations only ever ratchet *up* in priority within a turn. */
  requireEscalation(next: RequiredEscalation): void {
    const rank = (p: TicketPriority) => TICKET_PRIORITIES.indexOf(p);
    if (!this.requiredEscalation || rank(next.priority) > rank(this.requiredEscalation.priority)) {
      this.requiredEscalation = next;
    }
  }

  get bestRetrieval(): RetrievalOutcome | null {
    return [...this.retrievals].sort((a, b) => b.confidence.score - a.confidence.score)[0] ?? null;
  }
}
