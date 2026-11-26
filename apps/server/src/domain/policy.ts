import type { ContractStatus, Tier, TicketPriority } from '@acme/contracts';

/**
 * Business rules, as code. The knowledge base documents these same numbers for the model to
 * *explain*; this module is what actually *enforces* them, so a persuasive prompt can never talk
 * the agent into an out-of-policy refund. `policy.test.ts` asserts the KB and code agree.
 */

export const REFUND_REASONS = [
  'duplicate_charge',
  'service_issue',
  'accidental_purchase',
  'billing_error',
  'other',
] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const REFUND_RULES = {
  free: { windowDays: 0, autoApproveLimitCents: 0 },
  pro: { windowDays: 14, autoApproveLimitCents: 100_00 },
  enterprise: { windowDays: 30, autoApproveLimitCents: 500_00 },
  duplicateChargeWindowDays: 90,
} as const;

/** First-response targets in hours, by tier × priority (support-and-escalation.md). */
export const SLA_HOURS: Record<Tier, Record<TicketPriority, number>> = {
  free: { low: 72, normal: 72, high: 48, urgent: 24 },
  pro: { low: 48, normal: 24, high: 8, urgent: 4 },
  enterprise: { low: 24, normal: 8, high: 4, urgent: 1 },
};

export const QUEUES = {
  billing: 'Billing Team',
  accountManager: 'Enterprise Account Management',
  technical: 'Technical Support',
  security: 'Trust & Safety',
  general: 'Customer Support',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface InvoiceForPolicy {
  id: string;
  amountCents: number;
  type: 'subscription' | 'overage' | 'seats';
  status: 'paid' | 'failed';
  chargedAt: Date;
  duplicateOf?: string;
}

export interface RefundDecision {
  outcome: 'approve' | 'requires_approval' | 'deny';
  code:
    | 'APPROVED'
    | 'INVOICE_NOT_PAID'
    | 'ALREADY_REFUNDED'
    | 'AMOUNT_EXCEEDS_INVOICE'
    | 'FREE_TIER_BILLING_ERROR'
    | 'PAST_DUE_BALANCE'
    | 'ACCOUNT_CANCELLED'
    | 'CONTRACT_EXPIRED'
    | 'NON_REFUNDABLE_USAGE'
    | 'OUTSIDE_REFUND_WINDOW'
    | 'OVER_APPROVAL_LIMIT';
  explanation: string;
  /** Where a `requires_approval` case must be routed. */
  route?: { queue: QueueName; priority: TicketPriority };
  /** The policy section a human can check. */
  policyRef: string;
}

const DAY_MS = 86_400_000;
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function evaluateRefund(input: {
  tier: Tier;
  contractStatus: ContractStatus;
  invoice: InvoiceForPolicy;
  amountCents: number;
  reason: RefundReason;
  alreadyRefundedCents: number;
  now: Date;
}): RefundDecision {
  const { tier, contractStatus, invoice, amountCents, reason, alreadyRefundedCents, now } = input;
  const ageDays = Math.floor((now.getTime() - invoice.chargedAt.getTime()) / DAY_MS);
  const isDuplicate = reason === 'duplicate_charge' && Boolean(invoice.duplicateOf);
  const billingTeam = { queue: QUEUES.billing, priority: 'high' as const };
  const accountManager = { queue: QUEUES.accountManager, priority: 'high' as const };

  if (invoice.status !== 'paid') {
    return {
      outcome: 'deny',
      code: 'INVOICE_NOT_PAID',
      explanation: `Invoice ${invoice.id} was never successfully paid, so there is nothing to refund.`,
      policyRef: 'refund-policy#general-refund-rules',
    };
  }
  if (alreadyRefundedCents > 0) {
    return {
      outcome: 'deny',
      code: 'ALREADY_REFUNDED',
      explanation: `Invoice ${invoice.id} has already been refunded (${usd(alreadyRefundedCents)}). Only one refund is allowed per invoice.`,
      policyRef: 'refund-policy#general-refund-rules',
    };
  }
  if (amountCents > invoice.amountCents) {
    return {
      outcome: 'deny',
      code: 'AMOUNT_EXCEEDS_INVOICE',
      explanation: `The requested ${usd(amountCents)} exceeds the invoice amount of ${usd(invoice.amountCents)}.`,
      policyRef: 'refund-policy#general-refund-rules',
    };
  }
  if (tier === 'free') {
    return {
      outcome: 'requires_approval',
      code: 'FREE_TIER_BILLING_ERROR',
      explanation: 'Charges on a Free account are billing errors and are handled by the billing team.',
      route: billingTeam,
      policyRef: 'refund-policy#free-plan-refunds',
    };
  }
  if (contractStatus === 'past_due') {
    return {
      outcome: 'requires_approval',
      code: 'PAST_DUE_BALANCE',
      explanation:
        'The account is past due. Refunds cannot be issued until the outstanding balance is settled; the billing team must review.',
      route: billingTeam,
      policyRef: 'refund-policy#account-status-and-refund-eligibility',
    };
  }
  if (contractStatus === 'cancelled' && !isDuplicate) {
    return {
      outcome: 'requires_approval',
      code: 'ACCOUNT_CANCELLED',
      explanation: 'Cancelled accounts can only receive duplicate-charge refunds; other requests go to the billing team.',
      route: billingTeam,
      policyRef: 'refund-policy#account-status-and-refund-eligibility',
    };
  }
  if (contractStatus === 'expired') {
    return {
      outcome: 'requires_approval',
      code: 'CONTRACT_EXPIRED',
      explanation: 'The Enterprise contract has expired, so any refund requires the account manager.',
      route: accountManager,
      policyRef: 'refund-policy#account-status-and-refund-eligibility',
    };
  }
  if (invoice.type === 'overage' && reason !== 'billing_error' && !isDuplicate) {
    return {
      outcome: 'deny',
      code: 'NON_REFUNDABLE_USAGE',
      explanation: 'Usage and overage charges are non-refundable unless they were a billing error or a duplicate.',
      policyRef: 'refund-policy#non-refundable-charges',
    };
  }

  const rules = REFUND_RULES[tier];
  const windowDays = isDuplicate ? REFUND_RULES.duplicateChargeWindowDays : rules.windowDays;
  if (ageDays > windowDays) {
    return tier === 'enterprise'
      ? {
          outcome: 'requires_approval',
          code: 'OUTSIDE_REFUND_WINDOW',
          explanation: `The charge is ${ageDays} days old, beyond the ${windowDays}-day window the support agent can approve; the account manager must approve.`,
          route: accountManager,
          policyRef: 'refund-policy#enterprise-plan-refunds',
        }
      : {
          outcome: 'deny',
          code: 'OUTSIDE_REFUND_WINDOW',
          explanation: `The charge is ${ageDays} days old. Pro subscription charges are only refundable within ${windowDays} days.`,
          policyRef: 'refund-policy#pro-plan-refunds',
        };
  }
  if (amountCents > rules.autoApproveLimitCents) {
    return {
      outcome: 'requires_approval',
      code: 'OVER_APPROVAL_LIMIT',
      explanation: `${usd(amountCents)} is above the ${usd(rules.autoApproveLimitCents)} the support agent can approve on the ${tier} plan.`,
      route: tier === 'enterprise' ? accountManager : billingTeam,
      policyRef: `refund-policy#${tier}-plan-refunds`,
    };
  }
  return {
    outcome: 'approve',
    code: 'APPROVED',
    explanation: `Within policy: ${usd(amountCents)} on a ${tier} account, charged ${ageDays} day(s) ago.`,
    policyRef: `refund-policy#${isDuplicate ? 'duplicate-charges' : `${tier}-plan-refunds`}`,
  };
}

export function slaHoursFor(tier: Tier | null, priority: TicketPriority): number {
  return SLA_HOURS[tier ?? 'free'][priority];
}
