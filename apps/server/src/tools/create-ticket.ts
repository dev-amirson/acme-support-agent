import { z } from 'zod';
import { ESCALATION_REASONS, TICKET_PRIORITIES, type EscalationReason, type TicketPriority } from '@acme/contracts';
import { QUEUES, slaHoursFor, type QueueName } from '../domain/policy';
import { defineTool, type ToolDeps } from './types';

const CATEGORIES = ['billing', 'technical', 'account', 'security', 'general'] as const;

const schema = z.object({
  summary: z.string().describe('Concise, specific summary for the human specialist: what the customer needs and what was already tried.'),
  category: z.enum(CATEGORIES),
  priority: z.enum(TICKET_PRIORITIES).describe('urgent = outage/security incident; high = refund/billing approval or major breakage; normal = general; low = how-to.'),
  reason: z.enum(ESCALATION_REASONS),
});

const CATEGORY_QUEUE: Record<(typeof CATEGORIES)[number], QueueName> = {
  billing: QUEUES.billing,
  technical: QUEUES.technical,
  account: QUEUES.general,
  security: QUEUES.security,
  general: QUEUES.general,
};

const rank = (p: TicketPriority) => TICKET_PRIORITIES.indexOf(p);

export const createTicketTool = (deps: ToolDeps) =>
  defineTool<z.infer<typeof schema>>({
    name: 'create_escalation_ticket',
    description:
      'Hand the conversation to a human specialist by creating a structured escalation ticket. Use when the customer asks for a human, a policy exception/approval is required, a system is unavailable, or you cannot resolve the issue. Returns the ticket ID and response-time target to tell the customer.',
    schema,
    label: 'Creating escalation ticket…',
    requiresVerifiedCustomer: false,
    mutating: true,
    async execute(args, ctx) {
      // One ticket per turn: a model that calls this twice gets the same ticket back.
      if (ctx.turn.ticket) {
        const t = ctx.turn.ticket;
        return { summary: `Ticket ${t.id} already open`, result: { status: 'already_open', ticket_id: t.id, queue: t.queue, first_response_within_hours: t.slaHours } };
      }
      const required = ctx.turn.requiredEscalation;
      const customer = ctx.turn.customer;
      // A route mandated by the policy engine wins over the model's choice; priority only ratchets up.
      const queue: QueueName = required?.queue ?? CATEGORY_QUEUE[args.category];
      const priority: TicketPriority = required && rank(required.priority) > rank(args.priority) ? required.priority : args.priority;
      const reason: EscalationReason = required?.reason ?? args.reason;
      const slaHours = slaHoursFor(customer?.tier ?? null, priority);

      ctx.progress(`Routing to ${queue}…`);
      const ticket = await deps.crm.createTicket({
        sessionId: ctx.sessionId,
        customerId: customer?.id ?? null,
        priority,
        category: args.category,
        reason,
        queue,
        summary: args.summary,
        slaHours,
        payload: {
          customer: customer ? { id: customer.id, name: customer.name, tier: customer.tier, contract: customer.contractStatus } : null,
          policyContext: required?.summary ?? null,
          mode: ctx.mode,
          turnId: ctx.turnId,
        },
      });
      ctx.turn.ticket = ticket;
      await ctx.effects.escalate(ticket);
      return {
        summary: `Ticket ${ticket.id} · ${priority} · ${queue} · ${slaHours}h SLA`,
        result: {
          status: 'created',
          ticket_id: ticket.id,
          queue,
          priority,
          first_response_within_hours: slaHours,
          customer_verified: Boolean(customer),
        },
      };
    },
  });
