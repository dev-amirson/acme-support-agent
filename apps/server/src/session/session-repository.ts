import type { ChaosConfig, ConversationMode, EscalationTicket, SessionStatus, TranscriptMessage, TurnTrace, UsageLine } from '@acme/contracts';
import { DEFAULT_CHAOS } from '@acme/contracts';
import { and, count, desc, eq, gte, sql, sum } from 'drizzle-orm';
import type { Database, Executor } from '../db/pool';
import { messages, sessions, traces, usageEvents } from '../db/schema';
import type { ChatToolCall } from '../llm/types';

export interface SessionRow {
  id: string;
  status: SessionStatus;
  customerId: string | null;
  verifiedAt: Date | null;
  failedVerifications: number;
  escalation: EscalationTicket | null;
  chaos: ChaosConfig;
  turnCount: number;
  createdAt: Date;
}

export interface StoredMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'tool';
  mode: ConversationMode;
  content: string;
  toolCalls: ChatToolCall[] | null;
  toolCallId: string | null;
  toolName: string | null;
  visible: boolean;
  interrupted: boolean;
  meta: Record<string, unknown>;
  createdAt: Date;
}

export type NewMessage = Omit<StoredMessage, 'createdAt'> & { clientTurnId?: string | null };

type SessionRecord = typeof sessions.$inferSelect;
type MessageRecord = typeof messages.$inferSelect;

const toSession = (r: SessionRecord): SessionRow => ({
  id: r.id,
  status: r.status,
  customerId: r.customerId,
  verifiedAt: r.verifiedAt,
  failedVerifications: r.failedVerifications,
  escalation: r.escalation ?? null,
  chaos: { ...DEFAULT_CHAOS, ...r.chaos },
  turnCount: r.turnCount,
  createdAt: r.createdAt,
});

const toMessage = (r: MessageRecord): StoredMessage => ({
  id: r.id,
  turnId: r.turnId,
  role: r.role,
  mode: r.mode,
  content: r.content,
  toolCalls: r.toolCalls ?? null,
  toolCallId: r.toolCallId,
  toolName: r.toolName,
  visible: r.visible,
  interrupted: r.interrupted,
  meta: r.meta ?? {},
  createdAt: r.createdAt,
});

export type SessionPatch = Partial<
  Pick<SessionRow, 'status' | 'customerId' | 'verifiedAt' | 'failedVerifications' | 'escalation' | 'chaos'>
>;

export class SessionRepository {
  constructor(private readonly db: Database) {}

  async create(id: string): Promise<SessionRow> {
    const [row] = await this.db.insert(sessions).values({ id, chaos: DEFAULT_CHAOS }).returning();
    return toSession(row!);
  }

  async get(id: string): Promise<SessionRow | null> {
    const row = await this.db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    return row ? toSession(row) : null;
  }

  async update(id: string, patch: SessionPatch, tx: Executor = this.db): Promise<void> {
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(set).length) return;
    await tx
      .update(sessions)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(sessions.id, id));
  }

  async incrementTurnCount(id: string, tx: Executor = this.db): Promise<void> {
    await tx
      .update(sessions)
      .set({ turnCount: sql`${sessions.turnCount} + 1`, updatedAt: sql`now()` })
      .where(eq(sessions.id, id));
  }

  async appendMessages(sessionId: string, items: NewMessage[], tx: Executor = this.db): Promise<void> {
    if (!items.length) return;
    await tx.insert(messages).values(
      items.map((m) => ({
        id: m.id,
        sessionId,
        turnId: m.turnId,
        clientTurnId: m.clientTurnId ?? null,
        role: m.role,
        mode: m.mode,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        visible: m.visible,
        interrupted: m.interrupted,
        meta: m.meta,
      })),
    );
  }

  /** The most recent `limit` messages, oldest first — the model's working memory. */
  async recentMessages(sessionId: string, limit: number): Promise<StoredMessage[]> {
    const rows = await this.db.query.messages.findMany({
      where: eq(messages.sessionId, sessionId),
      orderBy: desc(messages.seq),
      limit,
    });
    return rows.reverse().map(toMessage);
  }

  async transcript(sessionId: string, limit = 200): Promise<TranscriptMessage[]> {
    const rows = await this.db.query.messages.findMany({
      where: and(eq(messages.sessionId, sessionId), eq(messages.visible, true)),
      orderBy: desc(messages.seq),
      limit,
    });
    return rows.reverse().map((r) => {
      const meta = r.meta ?? {};
      return {
        id: r.id,
        turnId: r.turnId,
        role: r.role === 'user' ? 'user' : 'assistant',
        mode: r.mode,
        text: typeof meta.displayText === 'string' ? meta.displayText : r.content,
        createdAt: r.createdAt.toISOString(),
        interrupted: r.interrupted,
        confidence: (meta.confidence as TranscriptMessage['confidence']) ?? null,
        citations: (meta.citations as TranscriptMessage['citations']) ?? [],
        grounding: (meta.grounding as TranscriptMessage['grounding']) ?? null,
        steps: (meta.steps as TranscriptMessage['steps']) ?? [],
      };
    });
  }

  /** Voice barge-in: keep only what the customer actually heard. */
  async truncateMessage(sessionId: string, messageId: string, heardText: string): Promise<void> {
    await this.db
      .update(messages)
      .set({
        content: heardText,
        interrupted: true,
        meta: sql`jsonb_set(${messages.meta}, '{displayText}', to_jsonb(${heardText}::text))`,
      })
      .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)));
  }

  async clientTurnExists(sessionId: string, clientTurnId: string): Promise<boolean> {
    const row = await this.db.query.messages.findFirst({
      columns: { id: true },
      where: and(eq(messages.sessionId, sessionId), eq(messages.clientTurnId, clientTurnId)),
    });
    return Boolean(row);
  }

  async saveTrace(trace: TurnTrace, tx: Executor = this.db): Promise<void> {
    const values = {
      turnId: trace.turnId,
      sessionId: trace.sessionId,
      mode: trace.mode,
      status: trace.status,
      trace,
      costUsd: trace.metrics.costUsd,
    };
    await tx
      .insert(traces)
      .values(values)
      .onConflictDoUpdate({ target: traces.turnId, set: { trace, status: trace.status, costUsd: trace.metrics.costUsd } });
  }

  async getTrace(turnId: string): Promise<TurnTrace | null> {
    const row = await this.db.query.traces.findFirst({ where: eq(traces.turnId, turnId) });
    return row?.trace ?? null;
  }

  async recentTraces(sessionId: string, limit = 30): Promise<TurnTrace[]> {
    const rows = await this.db.query.traces.findMany({
      columns: { trace: true },
      where: eq(traces.sessionId, sessionId),
      orderBy: desc(traces.createdAt),
      limit,
    });
    return rows.reverse().map((r) => r.trace);
  }

  async totals(sessionId: string): Promise<{ costUsd: number; inputTokens: number; outputTokens: number; turns: number }> {
    const [row] = await this.db
      .select({
        cost: sum(traces.costUsd),
        input: sql<string | null>`sum((${traces.trace} -> 'metrics' ->> 'inputTokens')::int)`,
        output: sql<string | null>`sum((${traces.trace} -> 'metrics' ->> 'outputTokens')::int)`,
        turns: count(),
      })
      .from(traces)
      .where(eq(traces.sessionId, sessionId));
    return {
      costUsd: Number(row?.cost ?? 0),
      inputTokens: Number(row?.input ?? 0),
      outputTokens: Number(row?.output ?? 0),
      turns: row?.turns ?? 0,
    };
  }

  async recordUsage(sessionId: string | null, lines: UsageLine[], tx: Executor = this.db): Promise<void> {
    const billable = lines.filter((l) => l.costUsd > 0);
    if (!billable.length) return;
    await tx
      .insert(usageEvents)
      .values(billable.map((l) => ({ sessionId, kind: l.kind, model: l.model, costUsd: l.costUsd, detail: l })));
  }

  async spendSince(since: Date): Promise<number> {
    const [row] = await this.db.select({ total: sum(usageEvents.costUsd) }).from(usageEvents).where(gte(usageEvents.createdAt, since));
    return Number(row?.total ?? 0);
  }
}
