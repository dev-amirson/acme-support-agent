import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TICKET_PRIORITIES, TIERS, type ContractStatus, type Tier } from '@acme/contracts';
import { describe, expect, it } from 'vitest';
import { buildSectionTree, parseDocument } from '../rag/chunker';
import {
  evaluateRefund,
  QUEUES,
  REFUND_RULES,
  slaHoursFor,
  SLA_HOURS,
  type InvoiceForPolicy,
  type RefundDecision,
  type RefundReason,
} from './policy';

const NOW = new Date('2026-11-26T12:00:00Z');
const DAY = 86_400_000;

function invoice(over: Partial<InvoiceForPolicy> & { ageDays?: number } = {}): InvoiceForPolicy {
  const { ageDays = 3, ...rest } = over;
  return {
    id: 'INV-TEST-01',
    amountCents: 49_00,
    type: 'subscription',
    status: 'paid',
    chargedAt: new Date(NOW.getTime() - ageDays * DAY),
    ...rest,
  };
}

function decide(opts: {
  tier?: Tier;
  status?: ContractStatus;
  invoice?: InvoiceForPolicy;
  amountCents?: number;
  reason?: RefundReason;
  alreadyRefundedCents?: number;
}): RefundDecision {
  const inv = opts.invoice ?? invoice();
  return evaluateRefund({
    tier: opts.tier ?? 'pro',
    contractStatus: opts.status ?? 'active',
    invoice: inv,
    amountCents: opts.amountCents ?? inv.amountCents,
    reason: opts.reason ?? 'service_issue',
    alreadyRefundedCents: opts.alreadyRefundedCents ?? 0,
    now: NOW,
  });
}

const billingTeam = { queue: QUEUES.billing, priority: 'high' };
const accountManager = { queue: QUEUES.accountManager, priority: 'high' };

describe('evaluateRefund — decision matrix', () => {
  // [description, input, outcome, code, route]
  const cases: Array<[string, Parameters<typeof decide>[0], RefundDecision['outcome'], RefundDecision['code'], object | undefined]> = [
    // ---- approvals
    ['Pro $49 subscription, 3 days old', {}, 'approve', 'APPROVED', undefined],
    ['Pro exactly at the $100 limit', { invoice: invoice({ amountCents: 100_00 }) }, 'approve', 'APPROVED', undefined],
    ['Pro on day 14 (window is inclusive)', { invoice: invoice({ ageDays: 14 }) }, 'approve', 'APPROVED', undefined],
    ['Pro partial refund', { invoice: invoice({ amountCents: 490_00 }), amountCents: 50_00 }, 'approve', 'APPROVED', undefined],
    ['Enterprise exactly at the $500 limit', { tier: 'enterprise', invoice: invoice({ amountCents: 500_00 }) }, 'approve', 'APPROVED', undefined],
    ['Enterprise on day 30', { tier: 'enterprise', invoice: invoice({ amountCents: 2_400_00, ageDays: 30 }), amountCents: 300_00 }, 'approve', 'APPROVED', undefined],
    [
      'Pro duplicate charge at 60 days (90-day duplicate window)',
      { invoice: invoice({ ageDays: 60, duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'approve',
      'APPROVED',
      undefined,
    ],
    [
      'Enterprise overage that was a billing error',
      { tier: 'enterprise', invoice: invoice({ type: 'overage', amountCents: 350_00, ageDays: 9 }), reason: 'billing_error' },
      'approve',
      'APPROVED',
      undefined,
    ],
    [
      'overage that is a flagged duplicate',
      { invoice: invoice({ type: 'overage', duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'approve',
      'APPROVED',
      undefined,
    ],
    [
      'cancelled account, duplicate charge (the only refund cancelled accounts get)',
      { status: 'cancelled', invoice: invoice({ duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'approve',
      'APPROVED',
      undefined,
    ],
    // ---- denials
    ['invoice never paid', { invoice: invoice({ status: 'failed' }) }, 'deny', 'INVOICE_NOT_PAID', undefined],
    ['invoice already refunded', { alreadyRefundedCents: 10_00 }, 'deny', 'ALREADY_REFUNDED', undefined],
    ['amount exceeds invoice', { amountCents: 49_01 }, 'deny', 'AMOUNT_EXCEEDS_INVOICE', undefined],
    [
      'overage charge for a service issue',
      { tier: 'enterprise', invoice: invoice({ type: 'overage', amountCents: 350_00 }), reason: 'service_issue' },
      'deny',
      'NON_REFUNDABLE_USAGE',
      undefined,
    ],
    ['Pro subscription on day 15', { invoice: invoice({ ageDays: 15 }) }, 'deny', 'OUTSIDE_REFUND_WINDOW', undefined],
    [
      'Pro duplicate charge after 90 days',
      { invoice: invoice({ ageDays: 91, duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'deny',
      'OUTSIDE_REFUND_WINDOW',
      undefined,
    ],
    [
      '"duplicate_charge" reason on an invoice that is not flagged as a duplicate gets the normal window',
      { invoice: invoice({ ageDays: 30 }), reason: 'duplicate_charge' },
      'deny',
      'OUTSIDE_REFUND_WINDOW',
      undefined,
    ],
    // ---- human approval required
    ['any charge on a Free account', { tier: 'free', invoice: invoice({ amountCents: 5_00 }) }, 'requires_approval', 'FREE_TIER_BILLING_ERROR', billingTeam],
    ['past-due account, otherwise eligible', { status: 'past_due' }, 'requires_approval', 'PAST_DUE_BALANCE', billingTeam],
    [
      'past-due beats duplicate',
      { status: 'past_due', invoice: invoice({ duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'requires_approval',
      'PAST_DUE_BALANCE',
      billingTeam,
    ],
    ['cancelled account, non-duplicate', { status: 'cancelled' }, 'requires_approval', 'ACCOUNT_CANCELLED', billingTeam],
    ['expired Enterprise contract, even a tiny amount', { tier: 'enterprise', status: 'expired', amountCents: 1_00 }, 'requires_approval', 'CONTRACT_EXPIRED', accountManager],
    [
      'Enterprise request after 30 days',
      { tier: 'enterprise', invoice: invoice({ amountCents: 2_400_00, ageDays: 39 }), amountCents: 100_00 },
      'requires_approval',
      'OUTSIDE_REFUND_WINDOW',
      accountManager,
    ],
    ['Pro $490 annual charge (over $100 limit)', { invoice: invoice({ amountCents: 490_00, ageDays: 6 }) }, 'requires_approval', 'OVER_APPROVAL_LIMIT', billingTeam],
    ['Pro $100.01', { invoice: invoice({ amountCents: 100_01 }) }, 'requires_approval', 'OVER_APPROVAL_LIMIT', billingTeam],
    ['Enterprise $500.01', { tier: 'enterprise', invoice: invoice({ amountCents: 500_01 }) }, 'requires_approval', 'OVER_APPROVAL_LIMIT', accountManager],
    [
      'Pro duplicate over the limit still needs approval',
      { invoice: invoice({ amountCents: 490_00, duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' },
      'requires_approval',
      'OVER_APPROVAL_LIMIT',
      billingTeam,
    ],
  ];

  it.each(cases)('%s', (_name, input, outcome, code, route) => {
    const d = decide(input);
    expect(d.outcome).toBe(outcome);
    expect(d.code).toBe(code);
    expect(d.route).toEqual(route);
    expect(d.explanation.length).toBeGreaterThan(10);
    expect(d.policyRef).toMatch(/^refund-policy#[a-z-]+$/);
  });

  it('covers every outcome code', () => {
    const codes = new Set(cases.map((c) => c[3]));
    const all: RefundDecision['code'][] = [
      'APPROVED',
      'INVOICE_NOT_PAID',
      'ALREADY_REFUNDED',
      'AMOUNT_EXCEEDS_INVOICE',
      'FREE_TIER_BILLING_ERROR',
      'PAST_DUE_BALANCE',
      'ACCOUNT_CANCELLED',
      'CONTRACT_EXPIRED',
      'NON_REFUNDABLE_USAGE',
      'OUTSIDE_REFUND_WINDOW',
      'OVER_APPROVAL_LIMIT',
    ];
    expect([...codes].sort()).toEqual([...all].sort());
  });

  it('policy references point at real KB section anchors', () => {
    const kb = readFileSync(KB('refund-policy.md'), 'utf8');
    const anchors = new Set(buildSectionTree(parseDocument(kb, 'refund-policy')).children.map((c) => slug(c.title)));
    for (const [, input] of cases) {
      const ref = decide(input).policyRef.split('#')[1]!;
      expect(anchors, ref).toContain(ref);
    }
  });

  it('uses the duplicate-charge policy section for duplicate approvals', () => {
    const d = decide({ invoice: invoice({ duplicateOf: 'INV-TEST-00' }), reason: 'duplicate_charge' });
    expect(d.policyRef).toBe('refund-policy#duplicate-charges');
  });

  it('explains amounts in dollars', () => {
    expect(decide({ invoice: invoice({ amountCents: 490_00 }) }).explanation).toContain('$490.00 is above the $100.00');
  });
});

describe('slaHoursFor', () => {
  it('looks up tier × priority and treats unverified customers as Free', () => {
    expect(slaHoursFor('enterprise', 'urgent')).toBe(1);
    expect(slaHoursFor('pro', 'high')).toBe(8);
    expect(slaHoursFor(null, 'normal')).toBe(SLA_HOURS.free.normal);
  });

  it('higher priority never has a slower target', () => {
    for (const tier of TIERS) {
      const hours = TICKET_PRIORITIES.map((p) => SLA_HOURS[tier][p]);
      for (let i = 1; i < hours.length; i++) expect(hours[i]!).toBeLessThanOrEqual(hours[i - 1]!);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The KB documents the rules for the model to *explain*; policy.ts *enforces* them. They must agree.
// ---------------------------------------------------------------------------------------------

const KB = (file: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../knowledge-base', file);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

/** Section text by H2 title (including its sub-sections). */
function sections(file: string): Map<string, string> {
  const tree = buildSectionTree(parseDocument(readFileSync(KB(file), 'utf8'), file));
  type Node = (typeof tree.children)[number];
  const flatten = (n: Node): string => [n.title, ...n.blocks, ...n.children.map(flatten)].join('\n');
  return new Map(tree.children.map((c) => [c.title, flatten(c)]));
}

const dollars = (cents: number) => `$${cents / 100}`;

describe('knowledge base ↔ policy engine consistency', () => {
  const refund = sections('refund-policy.md');
  const support = sections('support-and-escalation.md');
  const get = (m: Map<string, string>, title: string) => {
    const s = m.get(title);
    if (!s) throw new Error(`KB section "${title}" not found`);
    return s;
  };

  it('Pro: 14-day window and $100 agent approval limit', () => {
    const pro = get(refund, 'Pro Plan Refunds');
    expect(REFUND_RULES.pro.windowDays).toBe(14);
    expect(REFUND_RULES.pro.autoApproveLimitCents).toBe(100_00);
    expect(pro).toContain(`refunded in full within ${REFUND_RULES.pro.windowDays} days of the charge date`);
    expect(pro).toContain(`Pro plan refunds of up to ${dollars(REFUND_RULES.pro.autoApproveLimitCents)} per invoice`);
    expect(pro).toContain(`older than ${REFUND_RULES.pro.windowDays} days are non-refundable`);
    expect(pro).toMatch(/requires billing team approval/);
  });

  it('Enterprise: 30-day window and $500 agent approval limit, account manager above that', () => {
    const ent = get(refund, 'Enterprise Plan Refunds');
    expect(REFUND_RULES.enterprise.windowDays).toBe(30);
    expect(REFUND_RULES.enterprise.autoApproveLimitCents).toBe(500_00);
    expect(ent).toContain(
      `up to ${dollars(REFUND_RULES.enterprise.autoApproveLimitCents)} per invoice when the request is made within ${REFUND_RULES.enterprise.windowDays} days`,
    );
    expect(ent).toContain(`above ${dollars(REFUND_RULES.enterprise.autoApproveLimitCents)} require approval by the customer's account manager`);
    expect(ent).toContain(`more than ${REFUND_RULES.enterprise.windowDays} days after the charge date also require account manager approval`);
    expect(ent).toMatch(/expired, any refund requires approval by the account manager/);
  });

  it('Duplicate charges: 90-day window, plan limits still apply', () => {
    const dup = get(refund, 'Duplicate Charges');
    expect(REFUND_RULES.duplicateChargeWindowDays).toBe(90);
    expect(dup).toContain(`within ${REFUND_RULES.duplicateChargeWindowDays} days of the charge date`);
    expect(dup).toContain(`up to ${dollars(REFUND_RULES.pro.autoApproveLimitCents)} per invoice`);
    expect(dup).toContain(`up to ${dollars(REFUND_RULES.enterprise.autoApproveLimitCents)} per invoice`);
    expect(dup).toMatch(/only refunds available to cancelled accounts/);
  });

  it('Free: nothing for the agent to approve; charges go to the billing team', () => {
    expect(REFUND_RULES.free).toEqual({ windowDays: 0, autoApproveLimitCents: 0 });
    expect(get(refund, 'Free Plan Refunds')).toMatch(/handled by the billing team/);
  });

  it('the step-by-step procedure repeats the same numbers', () => {
    const how = get(refund, 'How Refunds Are Processed');
    expect(how).toContain(
      `${REFUND_RULES.pro.windowDays} days for Pro subscription charges, ${REFUND_RULES.enterprise.windowDays} days for Enterprise, ${REFUND_RULES.duplicateChargeWindowDays} days for duplicate charges`,
    );
    expect(how).toContain(
      `${dollars(REFUND_RULES.pro.autoApproveLimitCents)} per invoice on Pro, ${dollars(REFUND_RULES.enterprise.autoApproveLimitCents)} per invoice on Enterprise`,
    );
  });

  it('account-status table matches the order of checks in the engine', () => {
    const status = get(refund, 'Account Status and Refund Eligibility');
    expect(status).toMatch(/\| past_due \| No refunds until the outstanding balance is settled\. Route to the billing team\. \|/);
    expect(status).toMatch(/\| cancelled \| Only duplicate-charge refunds\. Any other request goes to the billing team\. \|/);
    expect(status).toMatch(/\| expired Enterprise contract \| Any refund requires the account manager\. \|/);
  });

  it('SLA first-response table equals SLA_HOURS', () => {
    const table = get(support, 'First-Response Targets (SLA)');
    const header = table.match(/^\| Plan \|(.+)\|$/m);
    expect(header?.[1]?.split('|').map((s) => s.trim().toLowerCase())).toEqual([...TICKET_PRIORITIES]);
    const parsed: Record<string, number[]> = {};
    for (const m of table.matchAll(/^\| (Free|Pro|Enterprise) \|((?:\s*\d+\s*\|)+)$/gm)) {
      parsed[m[1]!.toLowerCase()] = m[2]!.split('|').map((s) => s.trim()).filter(Boolean).map(Number);
    }
    expect(Object.keys(parsed).sort()).toEqual([...TIERS].sort());
    for (const tier of TIERS) {
      expect(parsed[tier], tier).toEqual(TICKET_PRIORITIES.map((p) => SLA_HOURS[tier][p]));
    }
  });

  it('Enterprise urgent coverage states the same 1-hour target', () => {
    expect(get(support, 'Enterprise Urgent Coverage')).toContain(
      `The first-response target for Enterprise urgent tickets is ${SLA_HOURS.enterprise.urgent} hour.`,
    );
  });

  it('refund and billing approvals are high priority in both the KB and the engine routes', () => {
    expect(get(support, 'Priority Definitions')).toMatch(/\*\*High\*\*: .*a refund or billing approval is needed/);
    expect(get(refund, 'Pro Plan Refunds')).toMatch(/Refund and billing approvals are high priority/);
    expect(decide({ invoice: invoice({ amountCents: 490_00 }) }).route?.priority).toBe('high');
    expect(decide({ tier: 'enterprise', invoice: invoice({ amountCents: 900_00 }) }).route?.priority).toBe('high');
  });
});
