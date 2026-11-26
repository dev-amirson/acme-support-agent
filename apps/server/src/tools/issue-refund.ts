import { z } from 'zod';
import { evaluateRefund, REFUND_REASONS } from '../domain/policy';
import { defineTool, type ToolDeps } from './types';

const schema = z.object({
  invoice_id: z.string().describe('Invoice to refund, e.g. "INV-1001-04" (from get_billing_history).'),
  amount_usd: z.number().positive().describe('Refund amount in US dollars, e.g. 49.00.'),
  reason: z.enum(REFUND_REASONS).describe('Why the refund is being issued.'),
});

const usd = (n: number) => `$${n.toFixed(2)}`;

export const issueRefundTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'issue_refund',
    description:
      'Issue a refund for one invoice of the verified customer. The refund policy (window, approval limits, account status) is enforced by this system: it returns refunded, requires_approval (you must then create an escalation ticket), or denied. Idempotent per invoice.',
    schema,
    label: 'Processing refund…',
    requiresVerifiedCustomer: true,
    mutating: true,
    async execute(args, ctx) {
      const customer = ctx.turn.customer!;
      ctx.progress('Locating invoice…');
      const invoice = await deps.crm.getInvoice(ctx.sessionId, customer.id, args.invoice_id);
      if (!invoice) {
        return {
          summary: `Invoice ${args.invoice_id} not found`,
          result: { status: 'denied', code: 'INVOICE_NOT_FOUND', explanation: `No invoice ${args.invoice_id} exists on this account. Check get_billing_history.` },
        };
      }
      const amountCents = Math.round(args.amount_usd * 100);
      ctx.progress('Checking refund policy…');
      const decision = evaluateRefund({
        tier: customer.tier,
        contractStatus: customer.contractStatus,
        invoice,
        amountCents,
        reason: args.reason,
        alreadyRefundedCents: invoice.refundedCents,
        now: ctx.now(),
      });

      if (decision.outcome === 'deny') {
        return {
          summary: `Refund not allowed · ${decision.code.toLowerCase().replaceAll('_', ' ')}`,
          result: { status: 'denied', code: decision.code, explanation: decision.explanation, policy: decision.policyRef },
        };
      }
      if (decision.outcome === 'requires_approval') {
        const route = decision.route!;
        ctx.turn.requireEscalation({
          reason: 'policy_exception',
          queue: route.queue,
          priority: route.priority,
          category: 'billing',
          summary: `Refund request ${usd(args.amount_usd)} on ${invoice.id} (${args.reason.replaceAll('_', ' ')}) needs approval: ${decision.explanation}`,
        });
        return {
          summary: `Needs approval · routed to ${route.queue}`,
          result: {
            status: 'requires_approval',
            code: decision.code,
            explanation: decision.explanation,
            route: { queue: route.queue, priority: route.priority },
            next_step: 'Create an escalation ticket (reason: policy_exception) and tell the customer who will follow up and when.',
            policy: decision.policyRef,
          },
        };
      }

      ctx.progress('Submitting refund…');
      const { refund, replayed } = await deps.crm.recordRefund({
        sessionId: ctx.sessionId,
        customerId: customer.id,
        invoiceId: invoice.id,
        amountCents,
        reason: args.reason,
        // One refund per invoice per sandbox: retries/replays resolve to the original refund.
        idempotencyKey: `${ctx.sessionId}:${invoice.id}`,
      });
      return {
        summary: `${replayed ? 'Refund already issued' : 'Refund issued'} · ${refund.id} · ${usd(refund.amountCents / 100)}`,
        result: {
          status: 'refunded',
          refund_id: refund.id,
          invoice_id: invoice.id,
          amount_usd: refund.amountCents / 100,
          reason: refund.reason,
          replayed,
          arrives_in: '5–10 business days to the original payment method',
          policy: decision.policyRef,
        },
      };
    },
  });
