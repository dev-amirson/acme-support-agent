import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Single source of runtime configuration. Parsed once at boot; an invalid environment fails
 * fast with a readable error instead of surfacing as a confusing runtime fault mid-demo.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ in dev, dist/ in prod — both live directly under apps/server.
const repoRoot = path.resolve(here, '../../..');

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');
const num = (fallback: number) => z.coerce.number().finite().default(fallback);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: num(8080),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    /** "auto" enables TLS for any non-local host (Neon, Render, Supabase all require it). */
    DATABASE_SSL: z.enum(['auto', 'require', 'disable']).default('auto'),

    /** `fake` runs fully offline with deterministic models — used by tests and CI. */
    AI_PROVIDER: z.enum(['openai', 'fake']).default('openai'),
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_BASE_URL: z.string().url().optional(),
    OPENAI_CHAT_MODEL: z.string().default('gpt-5.4-mini'),
    OPENAI_FALLBACK_CHAT_MODEL: z.string().default('gpt-4.1-mini'),
    OPENAI_JUDGE_MODEL: z.string().default('gpt-5.4-mini'),
    /**
     * Agent loop reasoning effort (Responses API, so reasoning + function tools combine). Measured:
     * `low` adds ~20 reasoning tokens and no meaningful first-token latency vs `none`, and plans
     * multi-step tool chains better. Blank = model default.
     */
    OPENAI_REASONING_EFFORT: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high']).default('low'),
    /** The answerability judge uses no tools, so it can afford a little reasoning. */
    OPENAI_JUDGE_REASONING_EFFORT: z.enum(['none', 'minimal', 'low', 'medium', 'high']).default('low'),
    OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
    OPENAI_TRANSCRIBE_MODEL: z.string().default('gpt-live-transcribe'),
    OPENAI_TRANSCRIBE_DELAY: z.enum(['', 'minimal', 'low', 'medium', 'high']).default('low'),
    OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
    OPENAI_TTS_VOICE: z.string().default('marin'),

    // Resilience
    LLM_TIMEOUT_MS: num(45_000),
    LLM_FIRST_TOKEN_TIMEOUT_MS: num(15_000),
    LLM_MAX_RETRIES: num(2),
    TOOL_TIMEOUT_MS: num(8_000),
    TOOL_MAX_ATTEMPTS: num(2),
    AGENT_MAX_STEPS: num(8),
    TURN_DEADLINE_MS: num(90_000),

    // Guardrails (see rag/confidence.ts — calibrate with `npm run eval:retrieval`)
    RAG_TOP_K: num(4),
    RAG_MIN_SIMILARITY: num(0.3),
    RAG_SIMILARITY_CEILING: num(0.62),
    RAG_HIGH_CONFIDENCE: num(0.7),
    RAG_LOW_CONFIDENCE: num(0.42),
    /** Run the LLM answerability judge for medium-band retrievals (secondary verification). */
    RAG_JUDGE_ENABLED: bool.default(true),

    // Abuse / cost protection
    RATE_LIMIT_CHAT_PER_MIN: num(20),
    RATE_LIMIT_SESSIONS_PER_HOUR: num(40),
    VOICE_MAX_CONCURRENT_PER_IP: num(2),
    VOICE_MAX_SESSION_MINUTES: num(15),
    DAILY_BUDGET_USD: num(5),
    SESSION_TURN_LIMIT: num(80),

    // Voice activity detection (server-side; the live transcription models have no VAD)
    VAD_START_FRAMES: num(4),
    /** Endpointing pause. 750 ms keeps natural between-sentence pauses from splitting a turn. */
    VAD_END_SILENCE_MS: num(750),
    VAD_MIN_UTTERANCE_MS: num(250),
    VAD_BARGE_IN_MS: num(320),

    ENABLE_CHAOS: bool.default(true),
    AUTO_MIGRATE: bool.default(true),
    AUTO_INGEST: bool.default(true),
    CORS_ORIGINS: z.string().default(''),
    /** Origins allowed to embed the UI in an iframe, e.g. https://huggingface.co for Spaces. */
    FRAME_ANCESTORS: z.string().default(''),
    TRUST_PROXY: bool.default(true),
    KB_DIR: z.string().default(path.join(repoRoot, 'knowledge-base')),
    MIGRATIONS_DIR: z.string().default(path.join(repoRoot, 'apps/server/drizzle')),
    WEB_DIST_DIR: z.string().default(path.join(repoRoot, 'apps/web/out')),
  })
  .superRefine((env, ctx) => {
    if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'OPENAI_API_KEY is required when AI_PROVIDER=openai (or set AI_PROVIDER=fake)',
      });
    }
    if (env.RAG_LOW_CONFIDENCE >= env.RAG_HIGH_CONFIDENCE) {
      ctx.addIssue({
        code: 'custom',
        path: ['RAG_LOW_CONFIDENCE'],
        message: 'RAG_LOW_CONFIDENCE must be below RAG_HIGH_CONFIDENCE',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  env: Env;
  isProd: boolean;
  corsOrigins: string[];
  frameAncestors: string[];
  reasoningEffort: Exclude<Env['OPENAI_REASONING_EFFORT'], ''> | null;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings as "unset" so `.env.example` placeholders don't defeat defaults.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([key, v]) => v !== '' || key === 'OPENAI_REASONING_EFFORT'),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    env,
    isProd: env.NODE_ENV === 'production',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    frameAncestors: env.FRAME_ANCESTORS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reasoningEffort: env.OPENAI_REASONING_EFFORT === '' ? null : env.OPENAI_REASONING_EFFORT,
  };
}
