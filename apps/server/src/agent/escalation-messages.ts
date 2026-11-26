import type { ConversationMode, EscalationTicket } from '@acme/contracts';
import type { CustomerRecord } from '../domain/crm-fixtures';

/**
 * Deterministic copy for guardrail-driven outcomes. When the guardrail fires, the model is taken
 * out of the loop on purpose — templated text cannot hallucinate, and it is instant, which matters
 * in voice mode.
 */

const tierName = (c: CustomerRecord | null) => (c ? `${c.tier[0]!.toUpperCase()}${c.tier.slice(1)}` : null);

function spokenId(id: string, mode: ConversationMode): string {
  // Voice: the TTS layer spells IDs out (see voice/spoken-text.ts); the transcript stays readable.
  return mode === 'voice' ? id : `**${id}**`;
}

function slaPhrase(ticket: EscalationTicket, customer: CustomerRecord | null): string {
  const tier = tierName(customer);
  return tier
    ? `As a ${tier} customer, you can expect a first response within ${ticket.slaHours} hours.`
    : `A specialist will follow up within ${ticket.slaHours} hours.`;
}

export function lowConfidenceEscalation(ticket: EscalationTicket, customer: CustomerRecord | null, mode: ConversationMode): string {
  const contact = customer ? '' : mode === 'voice' ? ' If you verify your account, they can reach you directly.' : ' If you share your account ID and ZIP code, they can reach you directly.';
  return `I couldn't find verified information about that in our support policies, so I'd rather not guess. I've passed your question to a support specialist — your ticket number is ${spokenId(ticket.id, mode)}. ${slaPhrase(ticket, customer)}${contact}`;
}

export function outOfScopeDecline(): string {
  return "I'm Acme Cloud's support assistant, so I can only help with your Acme Cloud account, billing, and our products and policies. Is there anything along those lines I can help you with?";
}

export function agentLimitEscalation(ticket: EscalationTicket, customer: CustomerRecord | null, mode: ConversationMode): string {
  return `I wasn't able to fully resolve this automatically, so I've escalated it to a specialist — ticket ${spokenId(ticket.id, mode)}. ${slaPhrase(ticket, customer)}`;
}

/** Appended when policy required an escalation the model's own reply didn't create. */
export function escalationAddendum(ticket: EscalationTicket, customer: CustomerRecord | null, mode: ConversationMode): string {
  return `I've opened ticket ${spokenId(ticket.id, mode)} with our ${ticket.queue} so a specialist can take it from here. ${slaPhrase(ticket, customer)}`;
}

export function emptyResponseFallback(): string {
  return "Sorry — I wasn't able to put together a response just now. Could you rephrase, or would you like me to connect you with a human specialist?";
}
