---
id: account-management
title: Account Management
category: account
tiers: all
updated: 2026-10-01
---

# Account Management

## Identity Verification

Support verifies the customer's identity before making any change to an account.

- Verification confirms that the person asking is authorized on the account, for example by confirming account details and a code sent to the account's email address.
- No account change is made until verification succeeds.
- Verification is also required for 2FA resets, account deletion requests, and refunds.

## Changes Support Can Make

After identity verification, support can change these account settings on the customer's behalf:

- **Billing email**: the address that receives invoices and billing notices.
- **Phone number**: the contact phone number on the account.
- **Auto-renew setting**: whether the subscription renews automatically at the end of the billing period.
- **Communication preference**: how Acme Cloud contacts the customer: email, SMS, or none.

Notes:

- Turning off auto-renew on the Pro plan means the subscription ends at the end of the current billing period.
- On the Enterprise plan, turning off auto-renew does not replace the written non-renewal notice, which must be given 60 days before the renewal date.
- Setting communication preference to "none" stops optional messages. Invoices still go to the billing email.

## Changes Support Cannot Make

- **Plan changes**: support cannot upgrade or downgrade a plan. Customers change their plan themselves in Settings → Billing. Upgrades take effect immediately and are prorated; downgrades take effect at the end of the current billing cycle.
- **Account ownership transfer**: support cannot transfer ownership directly. See "Transferring Account Ownership" below.

## Transferring Account Ownership

Ownership transfer moves the owner role of a workspace to another person.

1. The current owner sends a written request asking for the transfer, naming the new owner.
2. Support creates an escalation ticket and gives the customer the ticket ID.
3. A specialist reviews the request, verifies the current owner and the new owner, and completes the transfer.
4. The specialist follows up within the first-response target for the customer's plan.

- Ownership transfer always requires a written request from the current owner.
- If the current owner cannot send the request (for example, they have left the company), support still creates an escalation ticket so a specialist can review the situation. Support never transfers ownership directly.

## Managing Seats on the Pro Plan
<!-- tiers: pro -->

On the Pro plan, a workspace can have up to 10 seats at $12/seat/month.

- Add or remove seats in Settings → Billing.
- Seat changes appear on your next invoice.
- A Pro workspace cannot exceed 10 seats. Teams that need more than 10 seats should consider the Enterprise plan.

## Managing Seats on the Enterprise Plan
<!-- tiers: enterprise -->

On the Enterprise plan, the number of seats is set in the Enterprise contract.

- To change the seat count, contact your Customer Success Manager (CSM) or account manager.
- With SCIM provisioning, users added in your identity provider use seats from the contract.

## Deleting Projects and Workspaces

- A deleted project can be recovered for 30 days.
- A deleted workspace can be recovered during the 30-day recovery window. After the 30-day recovery window, workspace deletion is permanent.
- Account deletion requests are processed within 30 days.
- Export your data from Settings → Data (JSON or CSV) before deleting anything.
- Deleting a workspace does not refund past charges. Refunds follow the Refund Policy.
