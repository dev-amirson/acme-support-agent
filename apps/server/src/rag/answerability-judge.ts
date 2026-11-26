import { z } from 'zod';
import { completeText, type ChatModel } from '../llm/types';
import { chatUsageLine } from '../llm/pricing';
import type { SpanHandle } from '../observability/tracer';
import type { SearchHit } from './kb-repository';

export interface JudgeVerdict {
  inDomain: boolean;
  answerable: boolean;
  confidence: number;
  supportingSources: number[];
  rationale: string;
}

const verdictSchema = z.object({
  in_domain: z.boolean(),
  answerable: z.boolean(),
  confidence: z.number().min(0).max(1),
  supporting_sources: z.array(z.number().int()),
  rationale: z.string(),
});

/** Strict-mode JSON schema (every property required, no extras) for structured outputs. */
const VERDICT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['in_domain', 'answerable', 'confidence', 'supporting_sources', 'rationale'],
  properties: {
    in_domain: {
      type: 'boolean',
      description: "True if the question is about Acme Cloud's products, plans, billing, accounts, security, or support.",
    },
    answerable: {
      type: 'boolean',
      description: 'True only if the SOURCES alone contain the specific facts needed to answer fully.',
    },
    confidence: { type: 'number', description: '0..1 confidence in the answerable judgement.' },
    supporting_sources: {
      type: 'array',
      items: { type: 'integer' },
      description: 'Indices of the sources that contain the answer.',
    },
    rationale: { type: 'string', description: 'One short sentence.' },
  },
} as const;

const SYSTEM = `You are a strict verification step in a customer-support retrieval pipeline for Acme Cloud.
Decide whether the numbered SOURCES contain enough specific information to answer the customer's QUESTION
without any outside knowledge or assumptions.

Rules:
- "answerable" is true only if a support agent could answer using these sources alone. Topically related
  sources that do not state the specific fact asked about are NOT enough.
- If the question asks about something the sources never mention (a discount, product, payment method, or
  program they don't cover), answerable = false.
- "in_domain" is about the topic, not the sources: billing, plans, refunds, accounts, login, API, security,
  contracts and support for Acme Cloud are in domain; general knowledge, other companies, chit-chat,
  coding help unrelated to Acme Cloud are not.
- Be calibrated: use confidence < 0.6 when unsure.`;

/**
 * Secondary verification ("answerability judge"). Runs only when dense similarity alone is
 * inconclusive (medium band) or to classify low-band questions as in/out of domain — so the
 * common high-confidence path pays no extra latency.
 */
export async function judgeAnswerability(opts: {
  model: ChatModel;
  modelName: string;
  question: string;
  hits: SearchHit[];
  signal: AbortSignal;
  span: SpanHandle;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
}): Promise<JudgeVerdict> {
  const sources = opts.hits
    .map((h, i) => `[${i + 1}] ${h.docTitle} › ${h.headingPath.join(' › ')}\n${h.content}`)
    .join('\n\n---\n\n');
  const { text, usage, model } = await completeText(opts.model, {
    model: opts.modelName,
    reasoningEffort: opts.reasoningEffort,
    signal: opts.signal,
    maxOutputTokens: 600,
    responseFormat: { name: 'answerability_verdict', schema: VERDICT_JSON_SCHEMA },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `QUESTION:\n${opts.question}\n\nSOURCES:\n${sources || '(none)'}` },
    ],
  });
  const parsed = verdictSchema.safeParse(safeJson(text));
  const line = chatUsageLine(model, usage);
  if (!parsed.success) {
    opts.span.fail(new Error('Judge returned malformed JSON'), { raw: text.slice(0, 500) });
    // Fail closed: an unverifiable verdict must never upgrade confidence.
    return { inDomain: true, answerable: false, confidence: 0, supportingSources: [], rationale: 'Verifier output was malformed.' };
  }
  const verdict: JudgeVerdict = {
    inDomain: parsed.data.in_domain,
    answerable: parsed.data.answerable,
    confidence: parsed.data.confidence,
    supportingSources: parsed.data.supporting_sources.filter((i) => i >= 1 && i <= opts.hits.length),
    rationale: parsed.data.rationale,
  };
  opts.span.end({ attributes: { verdict, model }, usage: line });
  return verdict;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
