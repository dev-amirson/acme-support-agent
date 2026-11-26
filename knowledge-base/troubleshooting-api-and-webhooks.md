---
id: troubleshooting-api-and-webhooks
title: Troubleshooting API and Webhooks
category: technical
tiers: all
updated: 2026-10-01
---

# Troubleshooting API and Webhooks

## API Rate Limits by Plan

| Plan | API limit |
| --- | --- |
| Free | 60 requests/minute |
| Pro | 600 requests/minute |
| Enterprise | 3,000 requests/minute |

- The rate limit is set by the workspace's plan.
- A burst allowance lets traffic reach 2× the per-minute limit for up to 10 seconds. Sustained traffic above the plan's per-minute limit is rate limited.
- To get a higher limit, upgrade your plan. Enterprise customers can request higher limits through their CSM.

## Handling 429 Too Many Requests

A 429 response means the workspace has exceeded its rate limit.

1. Read the Retry-After header on the 429 response. It tells you how long to wait before retrying.
2. Do not retry before the Retry-After time has passed.
3. Use exponential backoff with jitter: increase the wait after each consecutive 429, and add a random delay so many clients do not retry at the same moment.
4. Reduce request volume: batch work, cache responses that do not change often, and spread scheduled jobs over time.
5. If you regularly hit the limit, consider upgrading (Free to Pro, or Pro to Enterprise).

Retrying immediately in a tight loop keeps the workspace over the limit and causes more 429 responses.

## Handling 5xx Server Errors

- 5xx responses (such as 500, 502, 503) indicate a server-side problem.
- Retry idempotent requests (for example, GET, or requests that are safe to repeat) up to 3 times, using exponential backoff with jitter.
- Do not automatically retry non-idempotent requests, such as creating a resource, unless you can confirm the first attempt did not succeed.
- If errors continue after 3 retries, check the status page at status.acmecloud.example for an active incident.
- If there is no posted incident, contact support with the request ID, endpoint, timestamp, and status code. A production outage is urgent priority.

## Rotating API Keys

API keys are managed in Settings → API Keys.

1. Go to Settings → API Keys and choose "Rotate" on the key.
2. Copy the new key and store it securely, for example in a secrets manager.
3. Update every service and environment that uses the old key.
4. Confirm traffic is using the new key.

- After rotation, the old key stays valid for 24 hours, so you have a 24-hour window to deploy the new key without downtime.
- After 24 hours, requests with the old key fail with an authentication error.
- If you believe a key was leaked, rotate it immediately and contact support. A suspected key leak is a security incident and is treated as urgent priority.
- Never put API keys in client-side code or public repositories.

## Webhook Delivery and Retries

- A webhook delivery succeeds when your endpoint responds with a 2xx status code.
- Failed deliveries are retried up to 8 times over 24 hours, using exponential backoff.
- An endpoint that fails for 3 consecutive days is disabled automatically. Disabled endpoints receive no further deliveries until they are re-enabled.

### Troubleshooting Failed Webhooks

1. Check that the endpoint URL is correct, publicly reachable, and uses a valid TLS certificate.
2. Make sure the endpoint returns a 2xx response quickly, and does slow processing in the background after responding.
3. Check your server logs for errors or timeouts at the times of the failed deliveries.
4. Make your handler idempotent: because of retries, the same event may be delivered more than once.
5. After fixing a disabled endpoint, re-enable it in your workspace's webhook settings.

## Checking Service Status

- The Acme Cloud status page is at status.acmecloud.example.
- Check it first when you see widespread 5xx errors, timeouts, or delayed webhooks.
- Scheduled maintenance is announced 72 hours in advance.

## Higher API Limits for Enterprise
<!-- tiers: enterprise -->

On the Enterprise plan, the standard API limit is 3,000 requests/minute, and higher limits can be requested.

- Contact your Customer Success Manager (CSM) to request a higher limit.
- Include the expected requests per minute, the endpoints involved, the traffic pattern (steady or bursty), and the date the higher limit is needed.
- The 2× burst allowance for up to 10 seconds also applies to Enterprise workspaces.
