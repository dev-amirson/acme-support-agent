import { z } from 'zod';
import type { AccountSettings } from '../domain/crm-fixtures';
import { normalizeEmail } from '../domain/crm-repository';
import { defineTool, type ToolDeps } from './types';

const FIELDS = ['billing_email', 'phone', 'auto_renew', 'communication_preference'] as const;

const schema = z.object({
  field: z.enum(FIELDS).describe('The one setting support is allowed to change.'),
  value: z.string().describe('New value. auto_renew: "true"/"false"; communication_preference: email | sms | none.'),
});

type Parsed<K extends keyof AccountSettings> = { ok: true; value: AccountSettings[K] } | { ok: false; error: string };

function parseValue(field: (typeof FIELDS)[number], raw: string): Parsed<typeof field> {
  const v = raw.trim();
  switch (field) {
    case 'billing_email': {
      const email = normalizeEmail(v);
      return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ? { ok: true, value: email } : { ok: false, error: 'Not a valid email address.' };
    }
    case 'phone': {
      const digits = v.replace(/[^\d+]/g, '');
      return digits.replace('+', '').length >= 7 ? { ok: true, value: digits } : { ok: false, error: 'Not a valid phone number.' };
    }
    case 'auto_renew':
      if (/^(true|yes|on|enable[d]?)$/i.test(v)) return { ok: true, value: true };
      if (/^(false|no|off|disable[d]?)$/i.test(v)) return { ok: true, value: false };
      return { ok: false, error: 'auto_renew must be true or false.' };
    case 'communication_preference':
      return ['email', 'sms', 'none'].includes(v.toLowerCase())
        ? { ok: true, value: v.toLowerCase() as AccountSettings['communication_preference'] }
        : { ok: false, error: 'communication_preference must be email, sms, or none.' };
  }
}

export const updateAccountTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'update_account_settings',
    description:
      "Change one of the verified customer's account settings: billing_email, phone, auto_renew, or communication_preference. Plan changes and ownership transfers are NOT possible here (plan: customer self-serve; ownership: escalate).",
    schema,
    label: 'Updating account settings…',
    requiresVerifiedCustomer: true,
    mutating: true,
    async execute(args, ctx) {
      const customer = ctx.turn.customer!;
      const parsed = parseValue(args.field, args.value);
      if (!parsed.ok) {
        return { summary: `Invalid ${args.field.replaceAll('_', ' ')}`, result: { status: 'rejected', error: parsed.error } };
      }
      const before = await deps.crm.getSettings(ctx.sessionId, customer);
      await deps.crm.updateSetting(ctx.sessionId, customer.id, args.field, parsed.value);
      return {
        summary: `Updated ${args.field.replaceAll('_', ' ')}`,
        result: { status: 'updated', field: args.field, previous_value: before[args.field], new_value: parsed.value },
      };
    },
  });
