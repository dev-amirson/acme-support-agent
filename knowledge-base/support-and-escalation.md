---
id: support-and-escalation
title: Support and Escalation
category: support
tiers: all
updated: 2026-10-01
---

# Support and Escalation

## Support Channels by Plan

| Plan | Support channels |
| --- | --- |
| Free | Community forum (billing issues can be emailed) |
| Pro | Email and in-app chat |
| Enterprise | Email, chat, phone, and a shared Slack channel |

- Free plan support is provided through the community forum. Billing issues on a Free account can be emailed to the billing team.
- Pro plan customers can reach support by email or through in-app chat.
- Enterprise plan customers can use email, chat, phone, or their shared Slack channel, and also have a dedicated Customer Success Manager (CSM).
- The AI support assistant is available on every plan and can answer questions, make supported account changes, and create escalation tickets.

## First-Response Targets (SLA)

First-response targets, in hours, by plan and ticket priority:

| Plan | Low | Normal | High | Urgent |
| --- | --- | --- | --- | --- |
| Free | 72 | 72 | 48 | 24 |
| Pro | 48 | 24 | 8 | 4 |
| Enterprise | 24 | 8 | 4 | 1 |

- These are first-response targets: the time until a human specialist first replies, not the time to full resolution.
- The target is measured from when the ticket is created.
- Enterprise urgent issues are covered 24/7.

## Priority Definitions

Each ticket is assigned one of four priorities:

- **Urgent**: a production outage or a security incident. Examples: the API is down for your workspace, a suspected leaked API key, or unauthorized access to an account.
- **High**: a major feature is broken, or a refund or billing approval is needed. Examples: webhooks have stopped delivering, or a refund above the support agent's approval limit.
- **Normal**: general questions or degraded functionality. Examples: slower than usual responses, or a question about how billing works.
- **Low**: how-to questions and feature requests. Examples: how to set up a project, or a request for a new integration.

If an issue fits more than one priority, use the higher one.

## How Escalation Works

When the AI support assistant cannot resolve a request, it escalates to a human specialist:

1. The assistant creates an escalation ticket with a summary of the issue, the customer's plan, and the assigned priority.
2. The customer receives a ticket ID. Keep it for any follow-up.
3. A human specialist follows up within the first-response target for the customer's plan and the ticket's priority.
4. The specialist may ask for more details, then works the issue through to resolution.

Common reasons for escalation:

- Refunds above the support agent's approval limit, or refunds that need billing team or account manager approval.
- Account ownership transfers, which require a written request from the current owner.
- Billing errors, and any refund request from a past_due or cancelled account (other than a duplicate charge).
- Technical issues that need investigation of a specific workspace.

## Enterprise Urgent Coverage
<!-- tiers: enterprise -->

On the Enterprise plan, urgent issues (production outages and security incidents) are covered 24/7.

- The first-response target for Enterprise urgent tickets is 1 hour.
- When an Enterprise urgent ticket is created, the customer's Customer Success Manager (CSM) is notified.
- Enterprise customers can raise urgent issues by email, chat, phone, or the shared Slack channel.
- Refund or credit approvals that need the account manager are escalated as high priority.

## Getting Faster Help

Include these details in any support request or escalation:

- The workspace name and the email address of the account.
- The project and, for API issues, the request ID, endpoint, timestamp, and the HTTP status code returned.
- For billing questions, the invoice number and the charge date.
- What you expected to happen, what happened instead, and any steps already tried.
- Check the status page at status.acmecloud.example first; if there is an active incident, updates are posted there.
