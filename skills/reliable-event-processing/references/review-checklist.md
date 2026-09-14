# Reliable event workflow review checklist

Use this checklist as an adversarial-review input, not as an implementation template.

## Producer and transaction

- Can the actual producer runtime call the queue binding directly? If not, where is the durable outbox and how is it relayed?
- Does one database transaction contain business state, idempotency result, and outbox rows?
- Are local, CI, and production transaction prerequisites verified before traffic is accepted?
- What happens when the same idempotency key arrives concurrently? Specify duplicate-key and transaction-conflict handling.
- What exact request components are canonically hashed? Include all effect-bearing method/path/query/body/header inputs or prohibit them.
- What response status, location, and cookie headers are persisted and replayed?

## Envelope, limits, and ordering

- List every event type, payload schema, legal destination, callback route, and runtime validation rule.
- Specify a versioned envelope with stable application `eventId`; do not substitute a provider transport ID.
- Verify current provider maximum message bytes, batch bytes, batch count, and retention. Preflight serialized size before committing the business mutation.
- Bound synchronous work: event count, batches, total deadline, and per-call timeout. State the response after a partial batch sequence.
- State whether effects are order-independent. Otherwise include aggregate ordering key/version and transactional stale-event rejection.

## Recovery and operations

- Claim with atomic owner/lease compare-and-set. Define empty-claim vs leased vs dispatched operation state.
- Do not automatically delete unresolved outbox rows. Define repair/quarantine and retention after a durable terminal state.
- Define consumer receipt retention against the permitted DLQ/manual replay horizon.
- Define DLQ source retention. If provider retention is shorter than promised re-drive time, archive unchanged validated envelopes durably before acknowledgment.
- Define a protected re-drive method that preserves `eventId`, validates the original envelope, records an audit entry, and cannot mutate on malformed input.
- Emit structured relay logs: event ID, operation ID, attempt, claim outcome, lease age, oldest pending age, failure category, and counts. Document Dashboard/log queries and escalation thresholds.

## Proxy and realtime boundary

- Strip client-supplied internal and forwarding headers; set one trusted forwarding chain. Define host, raw path/query, redirects, request abort, cookies, CORS, and streaming behavior.
- If gateway policy depends on command classification, make it exhaustive/versioned. Prefer protecting all requests of a method/path when body inspection conflicts with streaming.
- Specify the exact realtime frame field(s) that carry stable `eventId`, and its persistence/de-duplication horizon relative to all replay paths.

## Deterministic tests

Test: same-key race; transaction abort; direct publish rejection; accepted-send/failed-ack crash; lease expiry; duplicate delivery; stale ordering; callback five-retry/DLQ; archived manual re-drive; payload/count cap; missing indexes; unauthenticated internal calls; proxy OAuth/cookie/CORS/SSE behavior; and replica-set startup in local/CI.
