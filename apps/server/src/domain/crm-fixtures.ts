import type { ContractStatus, Tier } from '@acme/contracts';
import type { InvoiceForPolicy } from './policy';

/**
 * Mock CRM. Fixtures are immutable and dated *relative to now*, so every demo scenario stays
 * valid no matter when the app is opened. Mutations (refunds, tickets, setting changes) live in
 * Postgres scoped to the session — each conversation is an isolated sandbox.
 */

export interface CustomerRecord {
  id: string;
  name: string;
  email: string;
  zip: string;
  tier: Tier;
  plan: string;
  contractStatus: ContractStatus;
  contractEndsAt: Date | null;
  accountManager: string | null;
  seats: number;
  settings: AccountSettings;
}

export interface AccountSettings {
  billing_email: string;
  phone: string;
  auto_renew: boolean;
  communication_preference: 'email' | 'sms' | 'none';
}

export interface InvoiceRecord extends InvoiceForPolicy {
  customerId: string;
  description: string;
  currency: 'USD';
}

export interface DemoScenario {
  accountId: string;
  zip: string;
  name: string;
  tier: Tier;
  scenario: string;
}

const DAY = 86_400_000;
const daysAgo = (now: Date, d: number) => new Date(now.getTime() - d * DAY);
const daysAhead = (now: Date, d: number) => new Date(now.getTime() + d * DAY);

export function buildFixtures(now: Date): { customers: CustomerRecord[]; invoices: InvoiceRecord[] } {
  const customers: CustomerRecord[] = [
    {
      id: 'AC-1001',
      name: 'Alice Chen',
      email: 'alice@example.com',
      zip: '94107',
      tier: 'pro',
      plan: 'Pro (monthly)',
      contractStatus: 'active',
      contractEndsAt: null,
      accountManager: null,
      seats: 3,
      settings: { billing_email: 'alice@example.com', phone: '+1-415-555-0101', auto_renew: true, communication_preference: 'email' },
    },
    {
      id: 'AC-1002',
      name: 'Bob Martinez',
      email: 'bob@example.com',
      zip: '10001',
      tier: 'free',
      plan: 'Free',
      contractStatus: 'active',
      contractEndsAt: null,
      accountManager: null,
      seats: 1,
      settings: { billing_email: 'bob@example.com', phone: '+1-212-555-0102', auto_renew: false, communication_preference: 'email' },
    },
    {
      id: 'AC-1003',
      name: 'Carol Davis',
      email: 'carol@globex.example',
      zip: '60601',
      tier: 'enterprise',
      plan: 'Enterprise (annual contract)',
      contractStatus: 'active',
      contractEndsAt: daysAhead(now, 128),
      accountManager: 'Priya Natarajan',
      seats: 85,
      settings: { billing_email: 'ap@globex.example', phone: '+1-312-555-0103', auto_renew: true, communication_preference: 'email' },
    },
    {
      id: 'AC-1004',
      name: 'Dan Okafor',
      email: 'dan@example.com',
      zip: '73301',
      tier: 'pro',
      plan: 'Pro (monthly)',
      contractStatus: 'past_due',
      contractEndsAt: null,
      accountManager: null,
      seats: 2,
      settings: { billing_email: 'dan@example.com', phone: '+1-512-555-0104', auto_renew: true, communication_preference: 'sms' },
    },
    {
      id: 'AC-1005',
      name: 'Erin Walsh',
      email: 'erin@initech.example',
      zip: '02139',
      tier: 'enterprise',
      plan: 'Enterprise (annual contract)',
      contractStatus: 'expired',
      contractEndsAt: daysAgo(now, 20),
      accountManager: 'Marcus Webb',
      seats: 40,
      settings: { billing_email: 'billing@initech.example', phone: '+1-617-555-0105', auto_renew: false, communication_preference: 'email' },
    },
    {
      id: 'AC-1006',
      name: 'Frank Li',
      email: 'frank@example.com',
      zip: '98101',
      tier: 'pro',
      plan: 'Pro (annual)',
      contractStatus: 'active',
      contractEndsAt: daysAhead(now, 359),
      accountManager: null,
      seats: 5,
      settings: { billing_email: 'frank@example.com', phone: '+1-206-555-0106', auto_renew: true, communication_preference: 'email' },
    },
  ];

  const inv = (
    customerId: string,
    id: string,
    amountCents: number,
    type: InvoiceRecord['type'],
    ago: number,
    description: string,
    extra: Partial<InvoiceRecord> = {},
  ): InvoiceRecord => ({
    id,
    customerId,
    amountCents,
    type,
    status: 'paid',
    chargedAt: daysAgo(now, ago),
    description,
    currency: 'USD',
    ...extra,
  });

  const invoices: InvoiceRecord[] = [
    inv('AC-1001', 'INV-1001-04', 49_00, 'subscription', 4, 'Pro monthly subscription', { duplicateOf: 'INV-1001-03' }),
    inv('AC-1001', 'INV-1001-03', 49_00, 'subscription', 4, 'Pro monthly subscription'),
    inv('AC-1001', 'INV-1001-02', 49_00, 'subscription', 34, 'Pro monthly subscription'),
    inv('AC-1001', 'INV-1001-01', 49_00, 'subscription', 64, 'Pro monthly subscription'),
    inv('AC-1003', 'INV-1003-12', 350_00, 'overage', 9, 'Bandwidth overage (billing error under review)'),
    inv('AC-1003', 'INV-1003-11', 2_400_00, 'subscription', 9, 'Enterprise monthly contract fee'),
    inv('AC-1003', 'INV-1003-10', 2_400_00, 'subscription', 39, 'Enterprise monthly contract fee'),
    inv('AC-1004', 'INV-1004-02', 49_00, 'subscription', 6, 'Pro monthly subscription', { status: 'failed' }),
    inv('AC-1004', 'INV-1004-01', 49_00, 'subscription', 36, 'Pro monthly subscription'),
    inv('AC-1005', 'INV-1005-08', 2_000_00, 'subscription', 25, 'Enterprise monthly contract fee'),
    inv('AC-1006', 'INV-1006-01', 490_00, 'subscription', 6, 'Pro annual subscription'),
  ];
  return { customers, invoices };
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  { accountId: 'AC-1001', zip: '94107', name: 'Alice Chen', tier: 'pro', scenario: 'Charged twice this month → in-policy duplicate refund' },
  { accountId: 'AC-1006', zip: '98101', name: 'Frank Li', tier: 'pro', scenario: '$490 annual refund → over agent limit, escalates to billing' },
  { accountId: 'AC-1003', zip: '60601', name: 'Carol Davis', tier: 'enterprise', scenario: '$350 overage billing error → refund; ask about SSO/SCIM' },
  { accountId: 'AC-1004', zip: '73301', name: 'Dan Okafor', tier: 'pro', scenario: 'Past-due account → refund blocked, routed to billing' },
  { accountId: 'AC-1005', zip: '02139', name: 'Erin Walsh', tier: 'enterprise', scenario: 'Expired contract → account-manager escalation' },
  { accountId: 'AC-1002', zip: '10001', name: 'Bob Martinez', tier: 'free', scenario: 'Free tier → tier-scoped answers (e.g. SSO not available)' },
];
