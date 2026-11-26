---
id: billing-and-payments
title: Billing and Payments
category: billing
tiers: all
updated: 2026-10-01
---

# Billing and Payments

## Billing Cycles and Charges

- Free plan workspaces have no paid charges.
- Pro plan workspaces are billed $49/month or $490/year. Seats are billed at $12/seat/month, up to 10 seats.
- Enterprise plan workspaces are billed according to a custom annual contract starting at $2,000/month.
- Usage-based charges, such as bandwidth and storage overage, appear as separate line items on the invoice.
- Upgrades take effect immediately and are prorated for the rest of the current billing cycle. Downgrades take effect at the end of the current billing cycle, so no partial credit is issued for the rest of the current cycle.

## Payment Methods

- Pro plan subscriptions are paid by credit or debit card.
- Enterprise plan customers can pay by card, ACH, or invoice with net-30 terms. The payment method is set in the Enterprise contract and can be changed through your account manager or Customer Success Manager (CSM).
- To update a card, go to Settings → Billing → Payment method, enter the new card, and save. The new card is used for the next charge and for any retry of a failed payment.

## Invoices and Receipts

- Every invoice is emailed to the workspace's billing email address.
- All invoices can be downloaded at any time from Settings → Billing.
- If invoices are going to the wrong person, support can change the billing email after identity verification. See the Account Management article.
- On the Enterprise plan with invoice billing, payment is due within net-30 terms from the invoice date.

## Taxes and VAT

- Sales tax and VAT are added to invoices where applicable, based on the billing address.
- EU business customers can add a VAT ID in Settings → Billing. With a valid VAT ID, invoices are issued under the EU reverse-charge mechanism and VAT is not charged by Acme Cloud.
- A VAT ID applies to future invoices once it is saved. Questions about tax on an invoice that was already issued are handled by the billing team.

## Failed Payments and Past-Due Accounts

When a payment fails, Acme Cloud retries it automatically and the account moves through these stages:

| Timing | What happens |
| --- | --- |
| First failure | Account becomes past_due. |
| Day 1, day 3, day 7 after the failure | Payment is retried automatically. |
| 14 days past due | Service is suspended. |
| 30 days after suspension | End of the data retention period. |

- An account becomes past_due after the first failed payment, even before any retry.
- Payment is retried on days 1, 3 and 7 after the failure. Updating the payment method in Settings → Billing before a retry gives that retry the best chance to succeed.
- If the balance is still unpaid after 14 days past due, service is suspended. Projects and API access are unavailable while suspended.
- Data is retained for 30 days after suspension. Paying the outstanding balance within that time restores service.
- Past_due accounts cannot receive refunds until the outstanding balance is settled. Refund requests from past_due accounts are routed to the billing team.

## Resolving a Failed Payment

1. Check the email sent to the billing email address for the reason the payment failed (for example, an expired card or insufficient funds).
2. Go to Settings → Billing → Payment method and update or replace the card.
3. Pay the outstanding invoice from Settings → Billing, or wait for the next automatic retry on day 1, 3 or 7.
4. If the payment still fails, contact support. Billing problems are escalated to the billing team.
5. Enterprise customers paying by ACH or invoice should contact their account manager or CSM.

## Billing Questions and Errors

- If you believe a charge is wrong, contact support with the invoice number. Possible billing errors are recorded with the reason "billing error".
- Free plan users can email billing issues even though general Free plan support is through the community forum.
- Being charged twice for the same period is a duplicate charge, refundable in full within 90 days on any paid plan. See the Refund Policy for details and approval limits.
