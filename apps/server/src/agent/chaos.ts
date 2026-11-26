import type { ChaosConfig, ToolName } from '@acme/contracts';
import { sleep } from '../lib/async';
import { AppError } from '../lib/errors';
import type { ChaosHook } from '../tools/runner';

/**
 * Per-session failure injection, armed from the observability drawer, so recovery paths can be
 * demonstrated live rather than claimed. Every flag is one-shot: it fires once and disarms itself,
 * and the disarmed config is persisted at the end of the turn.
 */
export class ChaosController implements ChaosHook {
  private readonly config: ChaosConfig;
  private toolFired = false;
  changed = false;

  constructor(config: ChaosConfig, private readonly enabled: boolean) {
    this.config = { ...config };
  }

  get current(): ChaosConfig {
    return { ...this.config };
  }

  shouldFailTool(tool: ToolName, attempt: number): boolean {
    if (!this.enabled || this.config.failTool !== tool) return false;
    if (this.config.failToolMode === 'transient' && attempt > 0) return false;
    this.toolFired = true;
    return true;
  }

  afterTool(): void {
    if (this.toolFired) {
      this.config.failTool = null;
      this.toolFired = false;
      this.changed = true;
    }
  }

  async beforeLlmAttempt(signal: AbortSignal): Promise<void> {
    if (!this.enabled) return;
    if (this.config.rateLimit) {
      this.config.rateLimit = false;
      this.changed = true;
      throw new AppError('RATE_LIMITED', 'Simulated upstream 429: rate limit reached', { retryAfterMs: 1_200 });
    }
    if (this.config.llmTimeout) {
      this.config.llmTimeout = false;
      this.changed = true;
      // Stall briefly, then surface exactly what the watchdog would raise for a hung stream.
      await sleep(1_500, signal);
      throw new AppError('LLM_TIMEOUT', 'Simulated: model produced no tokens before the first-token deadline');
    }
  }
}
