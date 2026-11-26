import { z } from 'zod';
import { defineTool, type ToolDeps } from './types';

const schema = z.object({
  limit: z.number().int().min(1).max(24).nullable().describe('Max invoices to return (default 6).'),
});

const DAY_MS = 86_400_000;

export const billingHistoryTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'get_billing_history',
    description:
      "Retrieve the verified customer's recent invoices and charges (amount, date, type, status, duplicate flags, prior refunds). Use before issuing any refund to identify the right invoice.",
    schema,
    label: 'Retrieving billing history…',
    requiresVerifiedCustomer: true,
    mutating: false,
    async execute(args, ctx) {
      const customer = ctx.turn.customer!;
      const invoices = (await deps.crm.listInvoices(ctx.sessionId, customer.id)).slice(0, args.limit ?? 6);
      const now = ctx.now().getTime();
      return {
        summary: invoices.length ? `Retrieved ${invoices.length} invoice${invoices.length === 1 ? '' : 's'}` : 'No invoices on file',
        result: {
          customer_id: customer.id,
          invoices: invoices.map((i) => ({
            invoice_id: i.id,
            date: i.chargedAt.toISOString().slice(0, 10),
            days_since_charge: Math.floor((now - i.chargedAt.getTime()) / DAY_MS),
            description: i.description,
            type: i.type,
            amount_usd: i.amountCents / 100,
            status: i.status,
            duplicate_of: i.duplicateOf ?? null,
            refunded_usd: i.refundedCents / 100,
          })),
          note: invoices.length ? undefined : 'This account has no paid charges.',
        },
      };
    },
  });
