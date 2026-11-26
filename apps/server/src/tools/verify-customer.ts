import { z } from 'zod';
import { QUEUES, REFUND_RULES, SLA_HOURS } from '../domain/policy';
import { normalizeZip } from '../domain/crm-repository';
import { defineTool, type ToolDeps } from './types';

export const MAX_VERIFICATION_ATTEMPTS = 3;

const schema = z.object({
  account_id: z
    .string()
    .nullable()
    .describe('Account ID as the customer gave it, e.g. "AC-1001". Null if they gave an email instead.'),
  email: z.string().nullable().describe('Account email address, if the customer gave one instead of an account ID.'),
  zip_code: z.string().describe("Billing ZIP code — the verification factor. Must come from the customer, never guessed."),
});

export const verifyCustomerTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'verify_customer_identity',
    description:
      "Verify the customer's identity (account ID or email + billing ZIP code) and load their subscription tier, plan, and contract status. Required before any account-specific action or account data lookup.",
    schema,
    label: 'Verifying account identity…',
    requiresVerifiedCustomer: false,
    mutating: true,
    async execute(args, ctx) {
      if (ctx.turn.customer && ctx.session.customerId) {
        const c = ctx.turn.customer;
        return {
          summary: `Already verified · ${c.name}`,
          result: { verified: true, already_verified: true, customer: { id: c.id, name: c.name, tier: c.tier } },
        };
      }
      if (ctx.session.failedVerifications >= MAX_VERIFICATION_ATTEMPTS) {
        ctx.turn.requireEscalation({
          reason: 'verification_failed',
          queue: QUEUES.security,
          priority: 'normal',
          category: 'security',
          summary: 'Customer exceeded identity verification attempts; manual verification required.',
        });
        return {
          summary: 'Verification locked — too many attempts',
          result: {
            verified: false,
            locked: true,
            message: 'Identity verification is locked for this conversation after repeated failures. A specialist must verify the customer manually.',
          },
        };
      }

      ctx.progress('Looking up account…');
      const customer = deps.crm.findCustomer({ accountId: args.account_id, email: args.email });
      ctx.progress('Checking verification factor…');
      if (!customer || customer.zip !== normalizeZip(args.zip_code)) {
        const failures = await ctx.effects.recordFailedVerification();
        const remaining = Math.max(0, MAX_VERIFICATION_ATTEMPTS - failures);
        // Deliberately generic: don't reveal whether the account exists (enumeration defence).
        return {
          summary: `Verification failed · ${remaining} attempt(s) left`,
          result: {
            verified: false,
            attempts_remaining: remaining,
            message: 'The details provided do not match our records. Ask the customer to double-check their account ID or email and billing ZIP code.',
          },
        };
      }

      ctx.progress('Checking subscription tier…');
      ctx.progress('Checking contract status…');
      await ctx.effects.markVerified(customer);
      const rules = REFUND_RULES[customer.tier];
      return {
        summary: `Verified ${customer.name} · ${customer.plan} · contract ${customer.contractStatus.replace('_', ' ')}`,
        result: {
          verified: true,
          customer: {
            id: customer.id,
            name: customer.name,
            tier: customer.tier,
            plan: customer.plan,
            contract_status: customer.contractStatus,
            contract_ends_at: customer.contractEndsAt?.toISOString().slice(0, 10) ?? null,
            account_manager: customer.accountManager,
            seats: customer.seats,
          },
          entitlements: {
            agent_refund_approval_limit_usd: rules.autoApproveLimitCents / 100,
            refund_window_days: rules.windowDays,
            duplicate_charge_window_days: REFUND_RULES.duplicateChargeWindowDays,
            support_first_response_hours: SLA_HOURS[customer.tier],
          },
        },
      };
    },
  });
