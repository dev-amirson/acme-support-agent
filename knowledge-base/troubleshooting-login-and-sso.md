---
id: troubleshooting-login-and-sso
title: Troubleshooting Login and SSO
category: technical
tiers: all
updated: 2026-10-01
---

# Troubleshooting Login and SSO

## Resetting a Forgotten Password

1. On the Acme Cloud sign-in page, select "Forgot password".
2. Enter the email address on the account.
3. Open the reset email and follow the link to choose a new password.

- The password reset link is valid for 60 minutes. After 60 minutes, request a new link.
- If you requested more than one link, use the one in the most recent email.
- If the email does not arrive, check spam and quarantine folders, and confirm you are using the email address registered on the account.
- If your workspace enforces SSO, you sign in through your identity provider and cannot reset an Acme Cloud password. Contact your company's IT administrator.

## Locked Account After Failed Logins

- After 5 failed login attempts, the account is locked for 15 minutes.
- The lock clears automatically after 15 minutes. Wait, then sign in with the correct password, or reset the password.
- Repeated failures after the lock clears can lock the account again.
- If you did not make the failed attempts yourself, reset your password and contact support. A suspected unauthorized access attempt is a security incident and is treated as urgent priority.

## Two-Factor Authentication (2FA) Problems

If you lost access to your 2FA device or authenticator app:

1. Use a recovery code, if you saved them when you enabled 2FA.
2. If you have no recovery code, contact support to request a 2FA reset.
3. Support verifies your identity before any 2FA reset.
4. After identity verification, a 24-hour security hold applies. The 2FA reset is completed when the 24-hour hold ends.
5. Sign in and set up 2FA again on your new device.

- The 24-hour security hold protects the account if someone else is attempting the reset, and cannot be skipped.
- If codes are rejected even though you have your device, check that the device's time is set automatically; authenticator codes depend on an accurate clock.

## SSO Availability

SSO/SAML single sign-on and SCIM user provisioning are available only on the Enterprise plan.

- Supported identity providers: Okta, Azure AD (Microsoft Entra ID), and Google Workspace.
- Free and Pro workspaces sign in with email and password, plus optional 2FA.
- To get SSO, upgrade to an Enterprise contract. See Plans and Pricing.

## Setting Up SSO/SAML
<!-- tiers: enterprise -->

On the Enterprise plan, a workspace owner or admin can configure SAML single sign-on with Okta, Azure AD, or Google Workspace.

1. In Acme Cloud, go to Settings → Security → Single sign-on and copy the ACS URL (Assertion Consumer Service URL) and the Entity ID.
2. In your identity provider, create a new SAML application:
   - **Okta**: Applications → Create App Integration → SAML.
   - **Azure AD**: Enterprise applications → New application → Create your own application → SAML.
   - **Google Workspace**: Admin console → Apps → Web and mobile apps → Add custom SAML app.
3. Paste the ACS URL and Entity ID from Acme Cloud into the identity provider exactly as shown.
4. Set the NameID format to email address and map it to the user's primary email.
5. Download the identity provider's metadata (or its SSO URL and signing certificate) and upload it in Acme Cloud under Settings → Security → Single sign-on.
6. Assign the users or groups who should have access to the SAML app in the identity provider.
7. Use "Test connection" in Acme Cloud with a test user before enforcing SSO.
8. Once the test succeeds, turn on SSO enforcement so all members sign in through the identity provider.

## Setting Up SCIM Provisioning
<!-- tiers: enterprise -->

On the Enterprise plan, SCIM automatically creates, updates, and deactivates Acme Cloud users from your identity provider.

1. Set up SSO/SAML first.
2. In Acme Cloud, go to Settings → Security → SCIM and generate a SCIM token. Copy the SCIM base URL and token.
3. In Okta, Azure AD, or Google Workspace, enable provisioning for the Acme Cloud app and enter the base URL and token.
4. Turn on create, update, and deactivate actions.
5. Assign users or groups, then run an initial sync.

- Users removed from the app in the identity provider lose access to Acme Cloud on the next sync.
- If the SCIM token is regenerated, update it in the identity provider, or provisioning stops.
- Seats used by provisioned users count toward the seats in your Enterprise contract.

## Common SAML Errors
<!-- tiers: enterprise -->

On the Enterprise plan, most SSO failures come from one of these causes:

- **Clock skew**: the assertion is rejected as "not yet valid" or "expired" because the identity provider's server clock is out of sync. Make sure the identity provider's servers sync time via NTP, then retry.
- **Certificate mismatch**: the signature cannot be verified because the signing certificate uploaded to Acme Cloud does not match the one the identity provider is using. This often happens after a certificate rotation. Download the current certificate or metadata from the identity provider and upload it again.
- **Wrong ACS URL**: the identity provider sends the assertion to the wrong address and sign-in fails or loops. Copy the ACS URL from Settings → Security → Single sign-on again and paste it into the identity provider exactly, with no extra characters.
- **User not assigned**: the identity provider refuses to sign in a user who is not assigned to the Acme Cloud app. Assign the user or their group.

If SSO is still failing, contact support with the error message, the identity provider, and the time of the attempt. Broken SSO is a major feature broken (high priority); if it causes a production outage for your team, it is urgent.
