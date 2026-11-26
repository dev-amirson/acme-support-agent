import type { EscalationReason, EscalationTicket, TicketPriority } from '@acme/contracts';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Database } from '../db/pool';
import { refunds, sessions, tickets } from '../db/schema';
import { newReference } from '../lib/ids';
import {
  buildFixtures,
  type AccountSettings,
  type CustomerRecord,
  type InvoiceRecord,
} from './crm-fixtures';
import type { RefundReason } from './policy';

export interface InvoiceView extends InvoiceRecord {
  refundedCents: number;
}

export interface RefundRecord {
  id: string;
  invoiceId: string;
  amountCents: number;
  reason: RefundReason;
  createdAt: string;
}

/**
 * Normalisers make identity verification robust to how people actually type — and how speech
 * transcription renders them ("A C one zero zero one", "alice at example dot com").
 */
const SPOKEN_DIGITS: Record<string, string> = {
  zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

function spokenToDigits(input: string): string {
  return input
    .toLowerCase()
    .split(/[\s,-]+/)
    .map((w) => SPOKEN_DIGITS[w] ?? w)
    .join(' ');
}

export function normalizeAccountId(raw: string): string | null {
  const compact = spokenToDigits(raw).replace(/[^a-z0-9]/gi, '').toUpperCase();
  const match = compact.match(/^(?:AC)?(\d{4})$/);
  return match ? `AC-${match[1]}` : null;
}

export function normalizeEmail(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+/g, '');
}

export function normalizeZip(raw: string): string {
  return spokenToDigits(raw).replace(/\D/g, '').slice(0, 5);
}

export class CrmRepository {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private fixtures() {
    return buildFixtures(this.now());
  }

  findCustomer(ref: { accountId?: string | null; email?: string | null }): CustomerRecord | null {
    const { customers } = this.fixtures();
    if (ref.accountId) {
      const id = normalizeAccountId(ref.accountId);
      const byId = id ? customers.find((c) => c.id === id) : undefined;
      if (byId) return byId;
    }
    if (ref.email) {
      const email = normalizeEmail(ref.email);
      return customers.find((c) => c.email === email) ?? null;
    }
    return null;
  }

  getCustomer(id: string): CustomerRecord | null {
    return this.fixtures().customers.find((c) => c.id === id) ?? null;
  }

  async listInvoices(sessionId: string, customerId: string): Promise<InvoiceView[]> {
    const invoices = this.fixtures().invoices.filter((i) => i.customerId === customerId);
    const rows = await this.db
      .select({ invoiceId: refunds.invoiceId, amountCents: refunds.amountCents })
      .from(refunds)
      .where(and(eq(refunds.sessionId, sessionId), eq(refunds.customerId, customerId)));
    const refunded = new Map(rows.map((r) => [r.invoiceId, r.amountCents]));
    return invoices
      .map((i) => ({ ...i, refundedCents: refunded.get(i.id) ?? 0 }))
      .sort((a, b) => b.chargedAt.getTime() - a.chargedAt.getTime());
  }

  async getInvoice(sessionId: string, customerId: string, invoiceId: string): Promise<InvoiceView | null> {
    const wanted = invoiceId.trim().toUpperCase();
    const all = await this.listInvoices(sessionId, customerId);
    return all.find((i) => i.id === wanted) ?? null;
  }

  /**
   * Idempotent: the same idempotency key returns the original refund instead of paying twice
   * (protects against model retries, network retries and double-clicks alike).
   */
  async recordRefund(input: {
    sessionId: string;
    customerId: string;
    invoiceId: string;
    amountCents: number;
    reason: RefundReason;
    idempotencyKey: string;
  }): Promise<{ refund: RefundRecord; replayed: boolean }> {
    const [inserted] = await this.db
      .insert(refunds)
      .values({
        id: newReference('RF'),
        sessionId: input.sessionId,
        customerId: input.customerId,
        invoiceId: input.invoiceId,
        amountCents: input.amountCents,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      })
      .onConflictDoNothing()
      .returning();
    const row =
      inserted ??
      (await this.db.query.refunds.findFirst({
        where: or(
          eq(refunds.idempotencyKey, input.idempotencyKey),
          and(eq(refunds.sessionId, input.sessionId), eq(refunds.invoiceId, input.invoiceId)),
        ),
      }));
    if (!row) throw new Error('Refund insert conflicted but no existing refund was found');
    return {
      replayed: !inserted,
      refund: {
        id: row.id,
        invoiceId: row.invoiceId,
        amountCents: row.amountCents,
        reason: row.reason as RefundReason,
        createdAt: row.createdAt.toISOString(),
      },
    };
  }

  async createTicket(input: {
    sessionId: string;
    customerId: string | null;
    priority: TicketPriority;
    category: string;
    reason: EscalationReason;
    queue: string;
    summary: string;
    slaHours: number;
    payload: Record<string, unknown>;
  }): Promise<EscalationTicket> {
    const [row] = await this.db
      .insert(tickets)
      .values({ id: newReference('ESC'), ...input })
      .returning({ id: tickets.id, createdAt: tickets.createdAt });
    return {
      id: row!.id,
      priority: input.priority,
      category: input.category,
      reason: input.reason,
      summary: input.summary,
      queue: input.queue,
      slaHours: input.slaHours,
      customerId: input.customerId,
      createdAt: row!.createdAt.toISOString(),
      status: 'open',
    };
  }

  async getSettings(sessionId: string, customer: CustomerRecord): Promise<AccountSettings> {
    const row = await this.db.query.sessions.findFirst({ columns: { accountOverrides: true }, where: eq(sessions.id, sessionId) });
    const overrides = (row?.accountOverrides[customer.id] ?? {}) as Partial<AccountSettings>;
    return { ...customer.settings, ...overrides };
  }

  async updateSetting<K extends keyof AccountSettings>(
    sessionId: string,
    customerId: string,
    field: K,
    value: AccountSettings[K],
  ): Promise<void> {
    await this.db
      .update(sessions)
      .set({
        accountOverrides: sql`jsonb_set(
          ${sessions.accountOverrides},
          ARRAY[${customerId}::text],
          COALESCE(${sessions.accountOverrides} -> ${customerId}::text, '{}'::jsonb) || jsonb_build_object(${field}::text, ${JSON.stringify(value)}::jsonb)
        )`,
        updatedAt: sql`now()`,
      })
      .where(eq(sessions.id, sessionId));
  }
}
