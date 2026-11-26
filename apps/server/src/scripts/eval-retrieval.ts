/**
 * Retrieval + guardrail evaluation. Thresholds in rag/confidence.ts are calibrated from this,
 * not guessed. Usage:
 *   npm run eval:retrieval            dense/hybrid scores only (cheap: embeddings only)
 *   npm run eval:retrieval -- --judge include the answerability judge (full guardrail path)
 */
import type { Tier } from '@acme/contracts';
import { loadConfig } from '../config';
import { createDatabase } from '../db/pool';
import { createProviders } from '../llm/providers';
import { NOOP_RECORDER } from '../observability/tracer';
import { KnowledgeBaseRepository } from '../rag/kb-repository';
import { KnowledgeService } from '../rag/knowledge-service';

type Expect = { kind: 'answerable'; doc: string } | { kind: 'uncovered' } | { kind: 'off_domain' };
interface Case {
  q: string;
  tier?: Tier | null;
  expect: Expect;
}

const CASES: Case[] = [
  { q: 'I was charged twice this month, can I get my money back?', expect: { kind: 'answerable', doc: 'refund-policy' } },
  { q: 'How long does it take for a refund to show up on my card?', expect: { kind: 'answerable', doc: 'refund-policy' } },
  { q: 'Can I get a refund on my annual plan? I bought it last week.', expect: { kind: 'answerable', doc: 'refund-policy' } },
  { q: 'What is the API rate limit on the Pro plan?', expect: { kind: 'answerable', doc: 'troubleshooting-api-and-webhooks' } },
  { q: "I'm getting 429 errors from the API, what should my client do?", expect: { kind: 'answerable', doc: 'troubleshooting-api-and-webhooks' } },
  { q: 'Webhook deliveries to my endpoint keep failing', expect: { kind: 'answerable', doc: 'troubleshooting-api-and-webhooks' } },
  { q: 'How do I set up SAML single sign-on with Okta?', tier: 'enterprise', expect: { kind: 'answerable', doc: 'troubleshooting-login-and-sso' } },
  { q: "I'm locked out after too many failed login attempts", expect: { kind: 'answerable', doc: 'troubleshooting-login-and-sso' } },
  { q: 'My card payment failed, what happens to my account now?', expect: { kind: 'answerable', doc: 'billing-and-payments' } },
  { q: 'How do I cancel my subscription?', expect: { kind: 'answerable', doc: 'contracts-and-cancellation' } },
  { q: "What's the fee for ending our enterprise contract early?", tier: 'enterprise', expect: { kind: 'answerable', doc: 'contracts-and-cancellation' } },
  { q: 'How fast will you respond to an urgent ticket?', tier: 'enterprise', expect: { kind: 'answerable', doc: 'support-and-escalation' } },
  { q: 'Can I get a service credit for last month’s outage?', tier: 'enterprise', expect: { kind: 'answerable', doc: 'uptime-and-service-credits' } },
  { q: 'How do I export all of my data?', expect: { kind: 'answerable', doc: 'data-privacy-and-security' } },
  { q: 'Are you SOC 2 certified?', expect: { kind: 'answerable', doc: 'data-privacy-and-security' } },
  // Certification is documented; how a customer obtains the audit report is not → human.
  { q: 'Can you email me a copy of your SOC 2 audit report?', expect: { kind: 'uncovered' } },
  { q: 'Can you change the billing email on my account?', expect: { kind: 'answerable', doc: 'account-management' } },
  { q: 'How much does it cost to add another seat?', expect: { kind: 'answerable', doc: 'plans-and-pricing' } },
  { q: "What's the difference between Pro and Enterprise?", expect: { kind: 'answerable', doc: 'plans-and-pricing' } },
  { q: 'Do you offer a student discount?', expect: { kind: 'uncovered' } },
  { q: 'Can I pay with Bitcoin or other crypto?', expect: { kind: 'uncovered' } },
  { q: 'Can I run Acme Cloud on-premise in my own data center?', expect: { kind: 'uncovered' } },
  { q: 'Are you HIPAA compliant and will you sign a BAA?', expect: { kind: 'uncovered' } },
  { q: 'Do you have a reseller or partner program?', expect: { kind: 'uncovered' } },
  { q: 'Can I pay with PayPal?', expect: { kind: 'uncovered' } },
  { q: 'Do you sell hardware appliances?', expect: { kind: 'uncovered' } },
  { q: 'What is the capital of France?', expect: { kind: 'off_domain' } },
  { q: 'Write me a poem about the ocean', expect: { kind: 'off_domain' } },
  { q: "What's the weather in Paris tomorrow?", expect: { kind: 'off_domain' } },
  { q: 'How do I make pasta carbonara?', expect: { kind: 'off_domain' } },
];

const config = loadConfig();
const withJudge = process.argv.includes('--judge');
const { db, pool } = createDatabase(config);
const { chat, embedder } = createProviders(config);
const service = new KnowledgeService({
  repo: new KnowledgeBaseRepository(db),
  embedder,
  judgeModel: chat,
  judgeModelName: config.env.OPENAI_JUDGE_MODEL,
  judgeEnabled: withJudge,
  judgeReasoningEffort: config.env.OPENAI_JUDGE_REASONING_EFFORT,
  topK: config.env.RAG_TOP_K,
  thresholds: {
    minSimilarity: config.env.RAG_MIN_SIMILARITY,
    similarityCeiling: config.env.RAG_SIMILARITY_CEILING,
    high: config.env.RAG_HIGH_CONFIDENCE,
    low: config.env.RAG_LOW_CONFIDENCE,
  },
});

const rows: Array<{ c: Case; top: number; score: number; band: string; status: string; hit: boolean; inDomain: boolean | null }> = [];
try {
  for (const c of CASES) {
    const out = await service.search({
      query: c.q,
      userMessage: null,
      tier: c.tier === undefined ? 'pro' : c.tier,
      signal: AbortSignal.timeout(30_000),
      recorder: NOOP_RECORDER,
      parentSpanId: null,
    });
    const top = Math.max(0, ...out.candidates.map((h) => h.similarity));
    const hit = c.expect.kind === 'answerable' ? out.candidates.slice(0, config.env.RAG_TOP_K).some((h) => h.docId === (c.expect as { doc: string }).doc) : false;
    rows.push({ c, top, score: out.confidence.score, band: out.confidence.band, status: out.status, hit, inDomain: out.inDomain });
  }
} finally {
  await pool.end();
}

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(`\n${pad('query', 58)} ${pad('expect', 11)} top_sim  score  band    status        ${withJudge ? 'domain' : ''}`);
for (const r of rows) {
  const ok =
    r.c.expect.kind === 'answerable' ? r.status === 'grounded' && r.hit : r.status === 'insufficient';
  console.log(
    `${ok ? '✓' : '✗'} ${pad(r.c.q, 56)} ${pad(r.c.expect.kind, 11)} ${r.top.toFixed(3)}  ${r.score.toFixed(2)}   ${pad(r.band, 7)} ${pad(r.status, 13)} ${withJudge ? String(r.inDomain) : ''}`,
  );
}
const groups = (k: Expect['kind']) => rows.filter((r) => r.c.expect.kind === k).map((r) => r.top);
const stat = (xs: number[]) => (xs.length ? `min ${Math.min(...xs).toFixed(3)}  max ${Math.max(...xs).toFixed(3)}  mean ${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3)}` : '-');
console.log('\nTop-1 cosine similarity by class:');
console.log(`  answerable : ${stat(groups('answerable'))}`);
console.log(`  uncovered  : ${stat(groups('uncovered'))}`);
console.log(`  off_domain : ${stat(groups('off_domain'))}`);
const answerable = rows.filter((r) => r.c.expect.kind === 'answerable');
const negatives = rows.filter((r) => r.c.expect.kind !== 'answerable');
console.log(`\nRecall@${config.env.RAG_TOP_K} (right doc retrieved): ${answerable.filter((r) => r.hit).length}/${answerable.length}`);
console.log(`Grounded when answerable: ${answerable.filter((r) => r.status === 'grounded').length}/${answerable.length}`);
console.log(`Correctly refused (uncovered + off-domain): ${negatives.filter((r) => r.status === 'insufficient').length}/${negatives.length}`);
