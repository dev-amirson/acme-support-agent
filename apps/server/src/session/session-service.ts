import type { ChaosConfig, CustomerSummary, SessionSnapshot } from '@acme/contracts';
import { AppError } from '../lib/errors';
import { isSessionId, newSessionId } from '../lib/ids';
import type { CustomerRecord } from '../domain/crm-fixtures';
import type { CrmRepository } from '../domain/crm-repository';
import type { SessionRepository, SessionRow } from './session-repository';

export function toCustomerSummary(c: CustomerRecord): CustomerSummary {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    tier: c.tier,
    plan: c.plan,
    contractStatus: c.contractStatus,
    contractEndsAt: c.contractEndsAt?.toISOString() ?? null,
  };
}

interface ActiveTurn {
  turnId: string;
  controller: AbortController;
  done: Promise<unknown>;
}

/**
 * Session lifecycle + the single-flight guard. Both transports go through here, which is what
 * makes memory consistent across text and voice: there is exactly one conversation per session,
 * persisted in Postgres, and at most one turn mutating it at any time.
 */
export class SessionService {
  private readonly active = new Map<string, ActiveTurn>();

  constructor(
    readonly repo: SessionRepository,
    private readonly crm: CrmRepository,
  ) {}

  async create(): Promise<SessionRow> {
    return this.repo.create(newSessionId());
  }

  async require(sessionId: string): Promise<SessionRow> {
    if (!isSessionId(sessionId)) throw new AppError('SESSION_NOT_FOUND', 'Unknown session');
    const session = await this.repo.get(sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Unknown session');
    return session;
  }

  customerFor(session: SessionRow): CustomerRecord | null {
    return session.customerId ? this.crm.getCustomer(session.customerId) : null;
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = await this.require(sessionId);
    const customer = this.customerFor(session);
    const [messages, traces, totals] = await Promise.all([
      this.repo.transcript(sessionId),
      this.repo.recentTraces(sessionId),
      this.repo.totals(sessionId),
    ]);
    return {
      sessionId,
      status: session.status,
      customer: customer ? toCustomerSummary(customer) : null,
      escalation: session.escalation,
      messages,
      traces,
      chaos: session.chaos,
      totals,
    };
  }

  async setChaos(sessionId: string, chaos: ChaosConfig): Promise<ChaosConfig> {
    await this.require(sessionId);
    await this.repo.update(sessionId, { chaos });
    return chaos;
  }

  // -- single-flight turn guard -------------------------------------------------------------

  activeTurn(sessionId: string): ActiveTurn | undefined {
    return this.active.get(sessionId);
  }

  /**
   * Claim the session for a new turn. `preempt` (voice barge-in) aborts the in-flight turn and
   * waits for it to persist its partial state; otherwise a concurrent turn is rejected.
   */
  async beginTurn(
    sessionId: string,
    turnId: string,
    opts: { preempt: boolean },
  ): Promise<{ controller: AbortController; finish: (p: Promise<unknown>) => void }> {
    const existing = this.active.get(sessionId);
    if (existing) {
      if (!opts.preempt) throw new AppError('TURN_IN_PROGRESS', 'A response is already in progress for this conversation');
      existing.controller.abort();
      await existing.done.catch(() => undefined);
    }
    const controller = new AbortController();
    const entry: ActiveTurn = { turnId, controller, done: Promise.resolve() };
    this.active.set(sessionId, entry);
    return {
      controller,
      finish: (p) => {
        entry.done = p;
        void p.finally(() => {
          if (this.active.get(sessionId) === entry) this.active.delete(sessionId);
        }).catch(() => undefined);
      },
    };
  }

  abortTurn(sessionId: string): boolean {
    const t = this.active.get(sessionId);
    if (!t) return false;
    t.controller.abort();
    return true;
  }
}
