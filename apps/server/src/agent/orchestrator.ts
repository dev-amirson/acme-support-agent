import type {
  AgentEvent,
  Citation,
  ConversationMode,
  EscalationTicket,
  TurnMetrics,
  TurnStatus,
  TurnTrace,
  UsageLine,
} from '@acme/contracts';
import type { AppConfig } from '../config';
import type { Database } from '../db/pool';
import type { CustomerRecord } from '../domain/crm-fixtures';
import { QUEUES } from '../domain/policy';
import { anySignal } from '../lib/async';
import { AppError, classifyUpstreamError, userFacingMessage } from '../lib/errors';
import { newId } from '../lib/ids';
import type { Logger } from '../lib/logger';
import { truncate } from '../lib/redact';
import { chatUsageLine, sumCost } from '../llm/pricing';
import { resilientStream, type AttemptRecord } from '../llm/resilient-chat';
import type { ChatMessage, ChatModel, ChatToolCall, TokenUsage } from '../llm/types';
import type { BudgetGuard } from '../observability/budget';
import { TurnTracer } from '../observability/tracer';
import type { KnowledgeService } from '../rag/knowledge-service';
import type { NewMessage, SessionRow } from '../session/session-repository';
import { toCustomerSummary, type SessionService } from '../session/session-service';
import { toolSpecs, type ToolRegistry } from '../tools/registry';
import type { ToolRunner } from '../tools/runner';
import type { SessionEffects } from '../tools/types';
import { scoreAnswer } from './answer-confidence';
import { ChaosController } from './chaos';
import {
  agentLimitEscalation,
  emptyResponseFallback,
  escalationAddendum,
  lowConfidenceEscalation,
  outOfScopeDecline,
} from './escalation-messages';
import { checkGrounding } from './grounding';
import { buildHistory, HISTORY_MESSAGE_LIMIT } from './memory';
import { buildSystemPrompt, sessionFacts } from './prompts';
import { StepTracker } from './step-tracker';
import { TurnState } from './turn-state';

export interface OrchestratorDeps {
  config: AppConfig;
  db: Database;
  chat: ChatModel;
  registry: ToolRegistry;
  runner: ToolRunner;
  sessions: SessionService;
  knowledge: KnowledgeService;
  budget: BudgetGuard;
  log: Logger;
  now?: () => Date;
}

export interface TurnInput {
  sessionId: string;
  text: string;
  mode: ConversationMode;
  emit: (event: AgentEvent) => void;
  clientTurnId?: string;
  /** Voice barge-in: abort an in-flight turn instead of rejecting the new one. */
  preempt?: boolean;
  /** Transport-level cancellation (client disconnected, voice interruption). */
  signal?: AbortSignal;
  /** Usage incurred before the turn (e.g. transcription of this utterance). */
  priorUsage?: UsageLine[];
}

export interface TurnResult {
  turnId: string;
  status: TurnStatus;
  assistantMessageId: string | null;
  text: string;
  trace: TurnTrace;
}

/** How the reasoning loop ended — decides what the final phase does. */
type LoopOutcome = 'answered' | 'gate_low_confidence' | 'gate_out_of_scope' | 'step_limit';

/**
 * The agent: an explicit state machine rather than a framework graph, so every transition is
 * observable, testable with a scripted model, and guarded:
 *
 *   RECEIVE ─▶ REASON ──tool calls──▶ ACT ──▶ OBSERVE (confidence gate) ──▶ REASON …
 *                 │                                     │
 *                 └──final text──▶ ESCALATE? ◀──────────┘ (gate tripped / step limit / policy)
 *                                        │
 *                                        ▼
 *                                   VERIFY (grounding) ─▶ PERSIST ─▶ DONE
 *
 * The model chooses *which* tools to chain (autonomy); the orchestrator decides *whether its
 * output is allowed to stand* (control): tool preconditions, retrieval confidence gating,
 * mandated escalations and post-generation grounding are all enforced here, in code.
 */
export class AgentOrchestrator {
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async runTurn(input: TurnInput): Promise<TurnResult> {
    const { sessions } = this.deps;
    const session = await sessions.require(input.sessionId);
    if (input.clientTurnId && (await sessions.repo.clientTurnExists(input.sessionId, input.clientTurnId))) {
      throw new AppError('TURN_IN_PROGRESS', 'This message was already received.');
    }
    if (session.turnCount >= this.deps.config.env.SESSION_TURN_LIMIT) {
      throw new AppError('VALIDATION', 'This conversation reached its length limit. Please start a new one.');
    }
    await this.deps.budget.assertAvailable();

    const turnId = newId('turn');
    const claim = await sessions.beginTurn(input.sessionId, turnId, { preempt: Boolean(input.preempt) });
    // Re-read after acquiring: a preempted turn may have changed verification/escalation state.
    const fresh = (await sessions.repo.get(input.sessionId)) ?? session;
    const run = this.execute(turnId, fresh, input, claim.controller.signal);
    claim.finish(run);
    return run;
  }

  private async execute(turnId: string, session: SessionRow, input: TurnInput, claimSignal: AbortSignal): Promise<TurnResult> {
    const { config, sessions, chat, registry, runner, knowledge, log } = this.deps;
    const env = config.env;
    const { emit, mode, sessionId } = input;
    const repo = sessions.repo;

    const t0 = performance.now();
    const startedAt = Date.now();
    const abort = anySignal(claimSignal, input.signal);
    const deadline = AbortSignal.timeout(env.TURN_DEADLINE_MS);
    const tracer = new TurnTracer((span) => emit({ type: 'trace.span', turnId, span }));
    const root = tracer.start('turn', `${mode} turn`, { sessionId, mode, userText: input.text });
    // Pre-turn costs (e.g. streaming transcription of this utterance) as first-class spans.
    for (const line of input.priorUsage ?? []) {
      tracer
        .start(line.kind, line.kind === 'stt' ? 'speech recognition' : line.kind, { model: line.model, audioSeconds: line.audioSeconds }, root.id)
        .end({ usage: line });
    }
    const steps = new StepTracker(turnId, emit);
    const turn = new TurnState(sessions.customerFor(session));
    const chaos = new ChaosController(session.chaos, env.ENABLE_CHAOS);
    const specs = toolSpecs(registry);

    const messageId = newId('msg');
    let messageStarted = false;
    let displayText = '';
    let ttftMs: number | null = null;
    const emitText = (delta: string) => {
      if (!delta) return;
      if (!messageStarted) {
        messageStarted = true;
        ttftMs = Math.round(performance.now() - t0);
        emit({ type: 'message.started', turnId, messageId });
      }
      displayText += delta;
      emit({ type: 'message.delta', turnId, messageId, delta });
    };
    /** Stream deterministic text in word-sized pieces so text and voice UIs behave identically. */
    const emitTemplate = (text: string) => {
      const sep = displayText.trim() ? (mode === 'voice' ? ' ' : '\n\n') : '';
      for (const piece of `${sep}${text}`.match(/\S+\s*|\s+/g) ?? []) emitText(piece);
      return `${sep}${text}`;
    };

    const emitSession = () =>
      emit({
        type: 'session.updated',
        customer: turn.customer ? toCustomerSummary(turn.customer) : null,
        status: session.status,
        escalation: session.escalation,
      });

    const effects: SessionEffects = {
      markVerified: async (customer: CustomerRecord) => {
        await repo.update(sessionId, { customerId: customer.id, verifiedAt: this.now(), failedVerifications: 0 });
        session.customerId = customer.id;
        session.failedVerifications = 0;
        turn.customer = customer;
        turn.sessionChanged = true;
        emitSession();
      },
      recordFailedVerification: async () => {
        session.failedVerifications += 1;
        await repo.update(sessionId, { failedVerifications: session.failedVerifications });
        return session.failedVerifications;
      },
      escalate: async (ticket: EscalationTicket) => {
        session.status = 'escalated';
        session.escalation = ticket;
        await repo.update(sessionId, { status: 'escalated', escalation: ticket });
        turn.sessionChanged = true;
        emit({ type: 'escalation.created', turnId, ticket });
        emitSession();
      },
    };

    // RECEIVE — persist the user message first: even a failed turn keeps what the customer said.
    const userMessageId = newId('msg');
    await repo.appendMessages(sessionId, [
      {
        id: userMessageId,
        turnId,
        clientTurnId: input.clientTurnId ?? null,
        role: 'user',
        mode,
        content: input.text,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        visible: true,
        interrupted: false,
        meta: {},
      },
    ]);
    emit({ type: 'turn.started', turnId, mode, userMessageId, userText: input.text, at: startedAt });

    const history = buildHistory(await repo.recentMessages(sessionId, HISTORY_MESSAGE_LIMIT));
    const working: ChatMessage[] = [...history];
    const pending: NewMessage[] = [];
    const usage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let llmCalls = 0;
    let finalContent = '';
    let status: TurnStatus = 'ok';
    let outcome: LoopOutcome = 'answered';
    let systemPrompt = '';
    let failure: AppError | null = null;

    const toolBase = {
      sessionId,
      turnId,
      mode,
      userMessage: input.text,
      session,
      turn,
      recorder: tracer,
      effects,
      now: this.now,
      abortSignal: abort,
      deadlineSignal: deadline,
    };

    const forceTicket = async (reason: string): Promise<EscalationTicket> => {
      const required = turn.requiredEscalation!;
      const call: ChatToolCall = {
        id: newId('call'),
        name: 'create_escalation_ticket',
        arguments: JSON.stringify({ summary: required.summary, category: required.category, priority: required.priority, reason: required.reason }),
      };
      const gate = tracer.start('guardrail', 'mandatory_escalation', { reason, required });
      const result = await runner.run(call, toolBase, steps, chaos);
      gate.end({ attributes: { result: result.summary } });
      // Record the forced call in model memory as if the agent had made it.
      pending.push(assistantToolCallMessage(turnId, mode, [call]), toolResultMessage(turnId, mode, call, result.content));
      if (!turn.ticket) throw new AppError('TOOL_FAILED', 'Escalation ticket could not be created');
      return turn.ticket;
    };

    try {
      // REASON ⇄ ACT loop -------------------------------------------------------------------
      for (let step = 0; ; step++) {
        if (step >= env.AGENT_MAX_STEPS) {
          outcome = 'step_limit';
          break;
        }
        systemPrompt = buildSystemPrompt({ mode, customer: turn.customer, escalation: session.escalation, now: this.now() });
        const label = step === 0 ? 'Understanding your request…' : 'Reasoning over results…';
        const llmStep = steps.begin('llm', `reason_${step + 1}`, label);
        const attempts: AttemptRecord[] = [];
        const span = tracer.start('llm', `reason #${step + 1}`, {
          model: env.OPENAI_CHAT_MODEL,
          prompt: traceablePrompt(systemPrompt, working, history.length),
          tools: specs.map((s) => s.name),
        });

        let stepText = '';
        const calls: ChatToolCall[] = [];
        let finishReason = 'stop';
        let resolvedModel = env.OPENAI_CHAT_MODEL;
        let stepUsage: TokenUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
        let opaque: unknown[] | undefined;
        try {
          const stream = resilientStream(
            chat,
            { messages: [{ role: 'system', content: systemPrompt }, ...working], tools: specs, maxOutputTokens: 1_500, signal: abort },
            {
              firstEventTimeoutMs: env.LLM_FIRST_TOKEN_TIMEOUT_MS,
              idleTimeoutMs: env.LLM_FIRST_TOKEN_TIMEOUT_MS,
              maxRetries: env.LLM_MAX_RETRIES,
              fallbackModel: env.OPENAI_FALLBACK_CHAT_MODEL,
              beforeAttempt: ({ signal }) => chaos.beforeLlmAttempt(signal),
              onAttempt: (a) => attempts.push(a),
              onRecovery: (r) => {
                steps.progress(llmStep, r.message);
                steps.recovery(r);
              },
            },
          );
          for await (const ev of stream) {
            if (ev.type === 'text') {
              stepText += ev.delta;
              emitText(ev.delta);
            } else if (ev.type === 'tool_call') {
              calls.push(ev.call);
            } else {
              finishReason = ev.finishReason;
              resolvedModel = ev.model;
              stepUsage = ev.usage;
              opaque = ev.opaque;
            }
          }
        } catch (err) {
          span.fail(err, { attempts });
          steps.finish(llmStep, 'error', classifyUpstreamError(err).message);
          throw err;
        }
        llmCalls++;
        addUsage(usage, stepUsage);
        span.end({
          attributes: {
            model: resolvedModel,
            finishReason,
            response: truncate(stepText, 4_000),
            toolCalls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
            attempts,
            reasoningTokens: stepUsage.reasoningTokens,
          },
          usage: chatUsageLine(resolvedModel, stepUsage),
        });
        steps.finish(llmStep, 'ok', calls.length ? `Planned: ${calls.map((c) => c.name).join(' → ')}` : 'Drafted reply');

        working.push({ role: 'assistant', content: stepText || null, ...(calls.length ? { toolCalls: calls } : {}), ...(opaque ? { opaque } : {}) });
        if (!calls.length) {
          finalContent = stepText;
          break;
        }
        pending.push(assistantToolCallMessage(turnId, mode, calls, stepText));

        // ACT — sequential, in model order: later calls may depend on earlier ones (verify → billing).
        const retrievalsBefore = turn.retrievals.length;
        for (const call of calls) {
          const result = await runner.run(call, toolBase, steps, chaos);
          chaos.afterTool();
          working.push({ role: 'tool', toolCallId: call.id, content: result.content });
          pending.push(toolResultMessage(turnId, mode, call, result.content));
        }
        if (abort.aborted) throw new AppError('ABORTED', 'Turn aborted');

        // OBSERVE — the confidence gate. If every search this step came back insufficient and
        // nothing in the turn is grounded, the model does not get another chance to improvise.
        const fresh = turn.retrievals.slice(retrievalsBefore);
        const grounded = turn.retrievals.some((r) => r.status === 'grounded');
        if (fresh.length && !grounded && fresh.every((r) => r.status === 'insufficient')) {
          const inDomain = fresh.some((r) => r.inDomain !== false);
          outcome = inDomain ? 'gate_low_confidence' : 'gate_out_of_scope';
          const best = turn.bestRetrieval!;
          const gate = tracer.start('guardrail', 'confidence_gate', {
            decision: inDomain ? 'escalate_to_human' : 'decline_out_of_scope',
            confidence: best.confidence,
            thresholds: knowledge.thresholds,
          });
          gate.end();
          const gateStep = steps.begin('guardrail', 'confidence_gate', 'Checking answer confidence…');
          steps.finish(
            gateStep,
            'ok',
            inDomain
              ? `Low confidence (${best.confidence.score.toFixed(2)}) — routing to a human specialist`
              : 'Out of scope — politely declining',
          );
          break;
        }
      }

      // ESCALATE / DECLINE -----------------------------------------------------------------
      let templateText = '';
      if (outcome === 'gate_out_of_scope') {
        templateText = emitTemplate(outOfScopeDecline());
      } else if (outcome === 'gate_low_confidence' || outcome === 'step_limit') {
        const best = turn.bestRetrieval;
        turn.requireEscalation({
          reason: outcome === 'step_limit' ? 'agent_limit' : 'low_confidence',
          queue: QUEUES.general,
          priority: 'normal',
          category: 'general',
          summary:
            outcome === 'step_limit'
              ? `Agent could not resolve within ${env.AGENT_MAX_STEPS} reasoning steps. Customer said: "${truncate(input.text, 300)}"`
              : `No knowledge-base passage met the confidence threshold (best ${best?.confidence.score.toFixed(2) ?? 'n/a'}). Customer asked: "${truncate(input.text, 300)}"`,
        });
        const ticket = turn.ticket ?? (await forceTicket(outcome));
        templateText = emitTemplate(
          outcome === 'step_limit' ? agentLimitEscalation(ticket, turn.customer, mode) : lowConfidenceEscalation(ticket, turn.customer, mode),
        );
      } else if (turn.requiredEscalation && !turn.ticket) {
        // The policy engine mandated a human (e.g. refund over the agent's limit) but the model
        // didn't open the ticket. Do it deterministically and tell the customer.
        const ticket = await forceTicket('policy_mandated');
        templateText = emitTemplate(escalationAddendum(ticket, turn.customer, mode));
      }
      if (templateText) finalContent = `${finalContent}${templateText}`.trim();
      if (!displayText.trim()) {
        const text = emitTemplate(emptyResponseFallback());
        finalContent = text.trim();
      }
      if (turn.ticket) status = 'escalated';

      // VERIFY — post-generation grounding ---------------------------------------------------
      const verifyStep = steps.begin('guardrail', 'grounding_check', 'Verifying answer against sources…');
      const gSpan = tracer.start('guardrail', 'grounding_check');
      // Evidence = session facts + tool outputs. Not the whole system prompt: its instructions
      // ("1. …", "under 120 words") would otherwise vouch for invented numbers.
      const facts = sessionFacts(turn.customer, session.escalation, this.now());
      const evidence = [facts, ...working.filter((m) => m.role === 'tool').map((m) => m.content), ...turn.toolEvidence];
      const grounding = checkGrounding({
        answer: displayText,
        evidence,
        validCitationIndices: new Set(turn.citations.map((c) => c.index)),
      });
      const confidence =
        outcome === 'gate_out_of_scope'
          ? null
          : outcome === 'gate_low_confidence'
            ? (turn.bestRetrieval?.confidence ?? null)
            : scoreAnswer(turn, grounding, knowledge.thresholds);
      gSpan.end({ attributes: { grounding, confidence } });
      steps.finish(
        verifyStep,
        grounding.passed ? 'ok' : 'error',
        grounding.passed
          ? grounding.checkedClaims
            ? `${grounding.checkedClaims} specific claim${grounding.checkedClaims === 1 ? '' : 's'} verified`
            : 'No specific claims to verify'
          : `Flagged: ${[...grounding.unsupportedClaims, ...grounding.invalidCitations.map((i) => `[${i}]`)].join(', ')}`,
      );

      const citations = selectCitations(turn.citations, displayText);
      return await this.complete({
        turnId,
        sessionId,
        mode,
        input,
        startedAt,
        t0,
        ttftMs,
        status,
        root,
        tracer,
        steps,
        chaos,
        pending,
        final: {
          id: messageId,
          content: finalContent,
          displayText,
          meta: { confidence, citations, grounding },
          interrupted: false,
        },
        events: { confidence, citations, grounding },
        usage,
        llmCalls,
        toolCalls: turn.toolCalls,
      });
    } catch (err) {
      failure = classifyUpstreamError(err);
      const aborted = failure.code === 'ABORTED';
      steps.closeDangling(aborted ? 'Interrupted' : 'Failed');
      if (!aborted) {
        log.warn({ err: failure.message, code: failure.code, turnId, sessionId }, 'turn failed');
        emit({ type: 'error', turnId, code: failure.code, message: userFacingMessage(failure.code), retryable: failure.retryable });
      }
      root.setAttributes({ error: { code: failure.code, message: failure.message } });
      return await this.complete({
        turnId,
        sessionId,
        mode,
        input,
        startedAt,
        t0,
        ttftMs,
        status: aborted ? 'aborted' : 'error',
        root,
        tracer,
        steps,
        chaos,
        pending,
        final: displayText.trim()
          ? { id: messageId, content: displayText, displayText, meta: { confidence: null, citations: [], grounding: null, error: aborted ? undefined : failure.code }, interrupted: aborted }
          : null,
        events: { confidence: null, citations: [], grounding: null },
        usage,
        llmCalls,
        toolCalls: turn.toolCalls,
        error: failure,
      });
    }
  }

  /** PERSIST + DONE: one transaction for messages, trace and usage, then the final events. */
  private async complete(p: {
    turnId: string;
    sessionId: string;
    mode: ConversationMode;
    input: TurnInput;
    startedAt: number;
    t0: number;
    ttftMs: number | null;
    status: TurnStatus;
    root: ReturnType<TurnTracer['start']>;
    tracer: TurnTracer;
    steps: StepTracker;
    chaos: ChaosController;
    pending: NewMessage[];
    final: { id: string; content: string; displayText: string; meta: Record<string, unknown>; interrupted: boolean } | null;
    events: { confidence: unknown; citations: Citation[]; grounding: unknown };
    usage: TokenUsage;
    llmCalls: number;
    toolCalls: number;
    error?: AppError;
  }): Promise<TurnResult> {
    const { sessions, budget, log } = this.deps;
    const repo = sessions.repo;
    const { emit } = p.input;

    if (p.status === 'error' && p.error) p.root.fail(p.error);
    else p.root.end({ attributes: { status: p.status } });

    const costUsd = sumCost(p.tracer.usage);
    const metrics: TurnMetrics = {
      e2eLatencyMs: Math.round(performance.now() - p.t0),
      ttftMs: p.ttftMs,
      timeToFirstAudioMs: null,
      llmCalls: p.llmCalls,
      toolCalls: p.toolCalls,
      inputTokens: p.usage.inputTokens,
      cachedInputTokens: p.usage.cachedInputTokens,
      outputTokens: p.usage.outputTokens,
      costUsd,
    };
    const trace: TurnTrace = {
      turnId: p.turnId,
      sessionId: p.sessionId,
      mode: p.mode,
      userText: p.input.text,
      status: p.status,
      startedAt: p.startedAt,
      spans: p.tracer.spans,
      usage: p.tracer.usage,
      metrics,
    };

    const messages = [...p.pending];
    if (p.final) {
      messages.push({
        id: p.final.id,
        turnId: p.turnId,
        role: 'assistant',
        mode: p.mode,
        content: p.final.content,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        visible: true,
        interrupted: p.final.interrupted,
        meta: { ...p.final.meta, displayText: p.final.displayText, steps: p.steps.records },
      });
    }

    try {
      await this.deps.db.transaction(async (tx) => {
        await repo.appendMessages(p.sessionId, messages, tx);
        await repo.saveTrace(trace, tx);
        await repo.recordUsage(p.sessionId, p.tracer.usage, tx);
        await repo.incrementTurnCount(p.sessionId, tx);
        if (p.chaos.changed) await repo.update(p.sessionId, { chaos: p.chaos.current }, tx);
      });
    } catch (err) {
      // Persistence failure must not lose the response the user already saw streamed.
      log.error({ err, turnId: p.turnId }, 'failed to persist turn');
    }
    budget.note(costUsd);

    if (p.final) {
      emit({
        type: 'message.completed',
        turnId: p.turnId,
        messageId: p.final.id,
        text: p.final.displayText,
        confidence: p.events.confidence as never,
        citations: p.events.citations,
        grounding: p.events.grounding as never,
        interrupted: p.final.interrupted,
      });
    }
    emit({ type: 'turn.completed', turnId: p.turnId, status: p.status, metrics });

    return { turnId: p.turnId, status: p.status, assistantMessageId: p.final?.id ?? null, text: p.final?.displayText ?? '', trace };
  }
}

// -- helpers ---------------------------------------------------------------------------------

function addUsage(total: TokenUsage, add: TokenUsage): void {
  total.inputTokens += add.inputTokens;
  total.cachedInputTokens += add.cachedInputTokens;
  total.outputTokens += add.outputTokens;
  total.reasoningTokens += add.reasoningTokens;
}

function assistantToolCallMessage(turnId: string, mode: ConversationMode, calls: ChatToolCall[], text = ''): NewMessage {
  return {
    id: newId('msg'),
    turnId,
    role: 'assistant',
    mode,
    content: text,
    toolCalls: calls,
    toolCallId: null,
    toolName: null,
    visible: false,
    interrupted: false,
    meta: {},
  };
}

function toolResultMessage(turnId: string, mode: ConversationMode, call: ChatToolCall, content: string): NewMessage {
  return {
    id: newId('msg'),
    turnId,
    role: 'tool',
    mode,
    content,
    toolCalls: null,
    toolCallId: call.id,
    toolName: call.name,
    visible: false,
    interrupted: false,
    meta: {},
  };
}

/** Prefer the sources the answer actually cites; fall back to everything consulted. */
function selectCitations(all: Citation[], text: string): Citation[] {
  const cited = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const used = all.filter((c) => cited.has(c.index));
  return used.length ? used : all;
}

/** Prompt snapshot for the trace viewer: full system prompt + this turn's messages, bounded. */
function traceablePrompt(system: string, working: ChatMessage[], historyLength: number) {
  const recent = working.slice(Math.max(0, historyLength - 4));
  return {
    system,
    historyMessagesOmitted: Math.max(0, historyLength - 4),
    messages: recent.map((m) => ({
      role: m.role,
      content: truncate(m.content ?? '', 1_500),
      ...(m.role === 'assistant' && m.toolCalls ? { toolCalls: m.toolCalls.map((c) => `${c.name}(${truncate(c.arguments, 300)})`) } : {}),
    })),
  };
}
