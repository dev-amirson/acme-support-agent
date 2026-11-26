import { z } from 'zod';
import { defineTool, type ToolDeps } from './types';

const schema = z.object({
  query: z
    .string()
    .describe("A focused search query capturing what the customer needs to know, e.g. 'refund window for annual Pro plan'."),
});

export const searchKnowledgeBaseTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'search_knowledge_base',
    description:
      "Search Acme Cloud's support policies and troubleshooting guides. Results are automatically scoped to the verified customer's plan tier. Use for ANY question about policies, pricing, limits, procedures, or troubleshooting — never answer those from memory.",
    schema,
    label: 'Searching knowledge base…',
    requiresVerifiedCustomer: false,
    mutating: false,
    async execute(args, ctx) {
      const tier = ctx.turn.customer?.tier ?? null;
      ctx.progress(tier ? `Scoping to ${tier} plan policies…` : 'Searching general policies (customer not verified)…');
      const outcome = await deps.knowledge.search({
        query: args.query,
        userMessage: ctx.userMessage,
        tier,
        signal: ctx.signal,
        recorder: ctx.recorder,
        parentSpanId: ctx.span.id,
      });
      ctx.turn.retrievals.push(outcome);
      const { band, score } = outcome.confidence;

      if (outcome.status === 'insufficient') {
        ctx.progress(outcome.judge ? 'Secondary verification: sources do not answer this' : 'No passage met the confidence threshold');
        return {
          summary: `No verified answer · confidence ${score.toFixed(2)} (${band})`,
          result: {
            status: 'insufficient_evidence',
            in_domain: outcome.inDomain,
            confidence: { score, band },
            message: 'No knowledge-base passage reliably answers this. Do NOT answer from general knowledge.',
          },
        };
      }

      if (outcome.judge) ctx.progress('Secondary verification passed');
      const citations = ctx.turn.registerSources(outcome.hits);
      return {
        summary: `Found ${citations.length} passage${citations.length === 1 ? '' : 's'} · confidence ${score.toFixed(2)} (${band})`,
        result: {
          status: 'grounded',
          confidence: { score, band },
          tier_scope: tier ?? 'general (customer not verified — plan-specific policies hidden)',
          sources: citations.map((c, i) => ({
            index: c.index,
            document: c.docTitle,
            section: c.section,
            content: outcome.hits[i]?.content ?? c.snippet,
          })),
          instructions: 'Answer using only these sources. Cite them inline like [1]. If they do not fully answer the question, say what is missing.',
        },
      };
    },
  });
