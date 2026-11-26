import { z } from 'zod';
import type {
  Citation,
  Confidence,
  ConversationMode,
  CustomerSummary,
  EscalationTicket,
  GroundingReport,
  SessionStatus,
  ToolName,
  TurnTrace,
} from './domain';
import { TOOL_NAMES } from './domain';
import type { StepRecord } from './events';

// ---------------------------------------------------------------------------
// Requests (validated at the edge with zod)
// ---------------------------------------------------------------------------

export const MAX_USER_MESSAGE_CHARS = 2_000;

export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARS),
  /** Client-generated id; a retried POST with the same id will not run the turn twice. */
  clientTurnId: z.string().min(8).max(64).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chaosConfigSchema = z.object({
  /** Make the next call(s) of this tool fail. */
  failTool: z.enum(TOOL_NAMES).nullable(),
  /** transient: first attempt fails, the retry recovers. persistent: every attempt fails. */
  failToolMode: z.enum(['transient', 'persistent']),
  /** Next LLM call stalls past the timeout (one-shot). */
  llmTimeout: z.boolean(),
  /** Next LLM call gets an upstream 429 (one-shot). */
  rateLimit: z.boolean(),
});
export type ChaosConfig = z.infer<typeof chaosConfigSchema>;

export const DEFAULT_CHAOS: ChaosConfig = {
  failTool: null,
  failToolMode: 'transient',
  llmTimeout: false,
  rateLimit: false,
};

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface TranscriptMessage {
  id: string;
  turnId: string;
  role: 'user' | 'assistant';
  mode: ConversationMode;
  text: string;
  createdAt: string;
  interrupted: boolean;
  confidence: Confidence | null;
  citations: Citation[];
  grounding: GroundingReport | null;
  steps: StepRecord[];
}

export interface SessionSnapshot {
  sessionId: string;
  status: SessionStatus;
  customer: CustomerSummary | null;
  escalation: EscalationTicket | null;
  messages: TranscriptMessage[];
  traces: TurnTrace[];
  chaos: ChaosConfig;
  totals: { costUsd: number; inputTokens: number; outputTokens: number; turns: number };
}

export interface CreateSessionResponse {
  sessionId: string;
  createdAt: string;
}

export interface PublicConfig {
  voiceEnabled: boolean;
  chaosEnabled: boolean;
  offlineMode: boolean;
  models: { chat: string; embedding: string; transcription: string; tts: string };
  guardrails: { highConfidence: number; lowConfidence: number; minSimilarity: number };
  demoAccounts: Array<{ accountId: string; zip: string; name: string; tier: string; scenario: string }>;
  tools: ToolName[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean; requestId?: string };
}
