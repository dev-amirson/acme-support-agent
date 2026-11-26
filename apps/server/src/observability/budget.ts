import { AppError } from '../lib/errors';
import type { SessionRepository } from '../session/session-repository';

/**
 * Global daily spend cap — the circuit breaker that keeps a public demo URL from running up an
 * unbounded bill. Reads the usage ledger with a short cache so it costs ~nothing per request.
 */
export class BudgetGuard {
  private cached: { at: number; spent: number } | null = null;
  private pendingUsd = 0;

  constructor(
    private readonly repo: SessionRepository,
    private readonly dailyBudgetUsd: number,
    private readonly cacheMs = 15_000,
  ) {}

  private startOfUtcDay(): Date {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  async spentToday(): Promise<number> {
    const now = Date.now();
    if (!this.cached || now - this.cached.at > this.cacheMs) {
      this.cached = { at: now, spent: await this.repo.spendSince(this.startOfUtcDay()) };
      this.pendingUsd = 0;
    }
    return this.cached.spent + this.pendingUsd;
  }

  /** Account for spend that's not yet visible through the cache. */
  note(costUsd: number): void {
    this.pendingUsd += costUsd;
  }

  async assertAvailable(): Promise<void> {
    if (this.dailyBudgetUsd <= 0) return;
    const spent = await this.spentToday();
    if (spent >= this.dailyBudgetUsd) {
      throw new AppError('BUDGET_EXCEEDED', `Daily demo budget of $${this.dailyBudgetUsd.toFixed(2)} reached`);
    }
  }

  async status(): Promise<{ spentUsd: number; budgetUsd: number }> {
    return { spentUsd: Math.round((await this.spentToday()) * 1e4) / 1e4, budgetUsd: this.dailyBudgetUsd };
  }
}
