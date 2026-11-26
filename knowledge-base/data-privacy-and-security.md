---
id: data-privacy-and-security
title: Data Privacy and Security
category: security
tiers: all
updated: 2026-10-01
---

# Data Privacy and Security

## Security and Compliance

- Acme Cloud is SOC 2 Type II certified.
- All customer data is encrypted at rest with AES-256.
- All data in transit is encrypted with TLS 1.2+. Connections using older protocol versions are refused.
- These protections apply to every plan: Free, Pro, and Enterprise.
- To report a suspected security incident, such as unauthorized access or a leaked API key, contact support. Security incidents are urgent priority.

## Exporting Your Data

Data export is available on all plans, in JSON or CSV format.

1. Go to Settings → Data.
2. Choose the projects or data to export.
3. Choose JSON or CSV as the format.
4. Start the export and download the file when it is ready.

- Export your data before deleting a project, deleting your account, or letting a contract expire.
- On an expired Enterprise contract, data can still be exported during the 30-day read-only grace period.

## Deleted Projects and Recovery

- A deleted project can be recovered for 30 days after deletion.
- To recover a project within the 30-day window, contact support or restore it from your workspace settings.
- After 30 days, the project and its data are permanently deleted and cannot be recovered.
- Workspace deletion is also permanent after the 30-day recovery window.

## Account Deletion Requests

- Customers can request deletion of their Acme Cloud account and its personal data.
- Account deletion requests are processed within 30 days.
- Support verifies the requester's identity before processing a deletion request.
- Before requesting deletion, export any data you want to keep from Settings → Data.
- Deleting an account does not by itself cancel an Enterprise contract; contract terms still apply. See Contracts and Cancellation.

## GDPR and Data Processing Agreements

- Acme Cloud supports GDPR compliance for customers in the EU and elsewhere.
- A standard Data Processing Agreement (DPA) is available to every customer on every plan. Ask support for a copy.
- Data subject requests, such as access, export, and deletion, are handled through Settings → Data and the account deletion process above.

### Custom DPA Negotiation
<!-- tiers: enterprise -->

On the Enterprise plan, customers can negotiate a custom DPA instead of the standard DPA.

- Custom DPA negotiation is available only to Enterprise customers.
- Start the request through your Customer Success Manager (CSM) or account manager.
- The custom DPA is agreed as part of, or as an addendum to, the Enterprise contract.

## Audit Logs
<!-- tiers: enterprise -->

On the Enterprise plan, audit logs record security-relevant activity in the workspace, such as sign-ins, member and permission changes, API key rotation, and settings changes.

- Audit logs are available only on the Enterprise plan.
- Audit logs are retained for 1 year.
- Workspace admins can review audit log entries in workspace settings and export them for their own records or security tools.
- Combined with SSO/SAML and SCIM, audit logs help Enterprise customers meet internal access-review requirements.
