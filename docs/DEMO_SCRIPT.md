# Loom walkthrough script (≈ 4 minutes)

Prep: open the live URL a minute early (free tier cold start). Use headphones for the voice segment.
Keep the **Observability** drawer open on the right throughout (⌘/Ctrl + .).

| Time | Show | Say (roughly) |
| --- | --- | --- |
| 0:00–0:20 | Start screen | "One agent, two transports. Chat streams over SSE and voice runs over a WebSocket, both into the same orchestrator, so tools, guardrails and memory are identical." |
| 0:20–1:05 | Click **Refund a duplicate charge**. Point at the live step timeline, then the customer bar. | "It verifies identity, checks tier and contract, pulls billing, finds the duplicate and issues the refund. The model chose that chain. The policy engine, not the model, decided the refund was allowed. The confidence chip and '2 details verified' come from the post-generation grounding check." |
| 1:05–1:30 | Drawer → **Trace**, then **Prompts** | "Every model call, tool call and guardrail is a span: latency, tokens, cost, and the exact prompt and tool arguments." |
| 1:30–2:00 | New chat → **Out-of-policy question** (student discount). Drawer → **Guardrails** | "Similarity is low, and the answerability judge confirms the sources don't answer it. The confidence gate takes the model out of the loop: no guessing, a ticket is opened and the customer gets a deterministic handoff." |
| 2:00–2:20 | **Refund above the agent limit** (Frank, $490) | "Over the $100 Pro limit, so the policy engine returns requires-approval. The agent escalates to Billing with an 8-hour SLA. If the model forgets, the orchestrator opens the ticket itself." |
| 2:20–3:15 | Click the **mic**. Say: *"What's the refund policy on the Pro plan?"* While it answers, **interrupt**: *"Sorry — how long do refunds take to arrive?"* | "Live transcript while I speak. A holding phrase covers the tool call. When I talk over it, playback ducks immediately, then stops once speech is confirmed. Look at the transcript: the interrupted reply is cut to exactly what I heard, so the agent's memory matches reality." Then point at **Voice latency** in Overview. |
| 3:15–3:45 | End call, type a follow-up: *"And which plan was that for again?"* | "Same session, same memory, across voice and text." |
| 3:45–4:15 | Drawer → **Failure lab**: arm *Rate limit*, send any message; arm *Persistent* failure on `get_billing_history`, ask for invoices | "Retries with backoff honour Retry-After, with fallback to a second model family. A persistent tool outage comes back to the agent as a structured result, so it apologises and offers a human instead of hallucinating." |
| 4:15–4:30 | README architecture diagram | "Chunking keeps whole policy sections together, retrieval is hybrid with tier scoping in SQL, and the thresholds were calibrated with an eval set: 30 of 30 correct." |

Demo identities (also under **Demo accounts** in the header):

| Account | ZIP | Scenario |
| --- | --- | --- |
| AC-1001 Alice (Pro) | 94107 | Duplicate charge → in-policy refund |
| AC-1006 Frank (Pro) | 98101 | $490 annual → needs billing approval |
| AC-1003 Carol (Enterprise) | 60601 | Enterprise-only docs (SSO/SCIM), $350 overage billing error |
| AC-1004 Dan (Pro, past due) | 73301 | Refund blocked → billing team |
| AC-1005 Erin (Enterprise, expired) | 02139 | Account-manager escalation |
| AC-1002 Bob (Free) | 10001 | Tier-scoped answers (no SSO on Free) |
