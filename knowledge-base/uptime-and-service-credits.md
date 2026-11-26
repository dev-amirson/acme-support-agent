---
id: uptime-and-service-credits
title: Uptime and Service Credits
category: support
tiers: all
updated: 2026-10-01
---

# Uptime and Service Credits

## Uptime Commitments by Plan

| Plan | Uptime commitment | Service credits |
| --- | --- | --- |
| Free | None | No |
| Pro | 99.9% target | No |
| Enterprise | 99.95% monthly uptime SLA | Yes |

- Current and past incidents are posted on the status page at status.acmecloud.example.
- Scheduled maintenance is excluded from uptime calculations on every plan.

## Enterprise Uptime SLA
<!-- tiers: enterprise -->

On the Enterprise plan, Acme Cloud provides a 99.95% monthly uptime SLA backed by service credits.

- Uptime is measured per calendar month.
- Scheduled maintenance, announced 72 hours in advance, is excluded from the uptime calculation.
- If monthly uptime falls below 99.95%, the Enterprise customer is eligible for a service credit (see the credit table below).
- Enterprise urgent issues, such as production outages, are covered 24/7 with a 1-hour first-response target, and the Customer Success Manager (CSM) is notified.

## Enterprise Service Credit Amounts
<!-- tiers: enterprise -->

On the Enterprise plan, service credits are a percentage of the monthly fee for the affected month:

| Monthly uptime | Service credit |
| --- | --- |
| Below 99.95% | 10% of the monthly fee |
| Below 99.0% | 25% of the monthly fee |
| Below 95.0% | 50% of the monthly fee |

- Credits do not stack: only the largest applicable credit is given. For example, uptime that is below 99.0% but not below 95.0% earns a 25% credit, not 10% plus 25%.
- Credits apply to future invoices. Service credits are not cash refunds.

## Requesting an Enterprise Service Credit
<!-- tiers: enterprise -->

On the Enterprise plan, service credits are not applied automatically; the customer must request them.

1. Submit the request within 30 days of the end of the affected month. Requests after 30 days are not eligible.
2. Send the request to support or your Customer Success Manager (CSM).
3. Include the affected month, the services or projects affected, and the times of the downtime you experienced. Linking the incident on status.acmecloud.example helps.
4. Acme Cloud checks the request against its uptime records and confirms the credit percentage.
5. The approved credit is applied to a future invoice.

## Pro Plan Uptime Target
<!-- tiers: pro -->

On the Pro plan, Acme Cloud targets 99.9% uptime.

- The 99.9% figure is a target, not a contractual SLA.
- The Pro plan does not include service credits for downtime, even if uptime falls below the 99.9% target.
- Pro customers affected by a service issue can contact support. Any refund request follows the Refund Policy: Pro subscription charges are refundable in full within 14 days of the charge date, with the reason recorded as "service issue".
- Customers who need a contractual uptime SLA with service credits can move to the Enterprise plan.

## Scheduled Maintenance

- Scheduled maintenance is announced 72 hours in advance.
- Announcements are posted on the status page at status.acmecloud.example.
- Scheduled maintenance is excluded from uptime calculations.
- Unscheduled downtime and incidents count toward uptime.
- If something is broken outside an announced maintenance window, check the status page, then contact support. A production outage is urgent priority.
