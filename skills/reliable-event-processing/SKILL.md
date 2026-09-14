---
name: reliable-event-processing
description: Use when designing, reviewing, or migrating reliable asynchronous event and batch workflows using queues, brokers, workers, outboxes, retries, DLQs, provider batches, and consumer callbacks. Use when changing delivery guarantees, producer execution boundaries, idempotency, transactionality, relay recovery, event-driven realtime behavior, or high-volume LLM inference with durable resume and usage limits.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [events, queues, outbox, retries, idempotency, durability]
    related_skills: [spec-drilldown, fail-closed-automation, human-gated-worker-automation]
---

# Reliable Event Processing

## Overview

Use this skill for distributed event workflows where a database mutation must eventually produce external asynchronous effects. Also use it for nominally synchronous workflows that mutate both a database and an external API: request cancellation, ambiguous external responses, and unknown database commit outcomes make these distributed consistency problems even when no queue exists yet.

## When to Use

- A producer, relay, worker, broker, queue, outbox, callback, or DLQ crosses a process or service boundary.
- A database mutation must converge with an external side effect under retries, crashes, or ambiguous responses.
- A batch or LLM workflow needs durable resume, idempotency, usage limits, or operator recovery.

Do not use this skill for a purely local in-memory operation with no durable or external boundary; use a simpler implementation workflow instead.

For high-volume LLM Map/Reduce, repository analysis, model-tiered inference, provider batch APIs, content-addressed result reuse, and subscription/API usage-limit classification, read `references/llm-batch-inference.md`.

For the synchronous DB + external API failure matrix and durable convergence requirements, read `references/synchronous-db-external-api-consistency.md`.

## Required workflow

1. Map every producer, mutation boundary, event type, consumer, callback, retry path, and human recovery path before changing code.
2. Verify provider limits and semantics from current official documentation: producer binding/API availability, acknowledgment behavior, max message and batch bytes/count, retention, retry/DLQ behavior, local-development gaps, and observability support.
3. Verify every downstream source needed by the consumer (origin URL, authentication/WAF path, content type, size limit) with a bounded read-only probe before deploying the queue workflow. A successful producer/consumer deployment does not prove that the consumer can reach its source.
4. Choose and document one producer contract. If a service cannot directly use the queue binding, do not hide an unreliable HTTP bridge behind a publisher abstraction. Specify a durable outbox and its relay semantics instead.
5. Make business mutation, operation-idempotency record, and outbox insertion atomic. Require the actual transaction prerequisites in production, local development, and CI.
6. Write a complete versioned wire envelope and exact runtime schema for every event type before implementation. Include event ID, destination, operation ID, payload, ordering metadata, and serialization/size limits.
7. Specify queue publication, claim/lease, acknowledgment, retry, callback, DLQ archive/re-drive, observability, and operator runbook contracts. Do not rely on prose such as “retry safely”.
8. Obtain independent adversarial review before implementation. Use `spec-drilldown` for the full specification gate.

## Materialized read-model publication

When events build JSON/HTML read models, treat immutable revision publication, manifest CAS, source ordering, and unpublish tombstones as a separate consistency contract. A working publisher CLI does not prove source mutation → eventual publication reliability while outbox/scheduler stages remain out of scope. Read `references/materialized-read-model-publication.md` before implementing or reviewing this pattern.

## Non-negotiable invariants

- Use stable application event IDs; never use transport message IDs as business idempotency keys.
- Treat producer acceptance plus failed outbox acknowledgement as an unknown-result case that can duplicate. Consumers must safely de-duplicate.
- Claim leases with atomic compare-and-set owner/expiry predicates. Acknowledge only when the same owner still holds the lease.
- Never TTL-delete an outbox event that has not reached a documented durable terminal state.
- Retain consumer idempotency receipts for at least every authorized replay horizon; use non-expiring receipts when manual replay has no bounded horizon.
- Success response rules must distinguish `all dispatched` from `leased by another publisher`; bounded waits end in a deterministic retryable response.
- Every internal callback and manual re-drive endpoint needs an exact authenticated method, payload schema, timeout, success status, and rejection behavior.
- Record direct-producer and relay failures as structured logs with operation/event IDs and age/count fields. A repair endpoint is not monitoring.

## Review checklist

Before implementation, read `references/review-checklist.md` and answer every applicable item in the spec or label it out of scope with a recovery contract.

## Testing gate

Require deterministic tests/harnesses for transaction rollback, same-key concurrency, unknown producer result, lease expiry, duplicate queue delivery, callback retry/DLQ, manual re-drive identity preservation, oversized event rejection, proxy/auth rejection, and the configured local/CI transaction topology.

For MongoDB transaction topologies with root authentication enabled, read [references/mongodb-replica-set-test-topology.md](references/mongodb-replica-set-test-topology.md). In particular, authorization plus a replica set requires a keyfile, and readiness loops must be bounded and verify writable-primary state before integration tests.

## Common Pitfalls

- Treating a successful producer response as proof that the durable event was accepted and recoverable.
- Using transport message IDs or timestamps as business idempotency keys.
- Claiming at-least-once delivery is exactly-once without a consumer receipt or equivalent deduplication boundary.
- Retrying ambiguous external outcomes without recording the operation identity and reconciliation state.
- Treating local mocks or a unit suite as proof of provider limits, transaction topology, callback reachability, or source authentication.

## Verification checklist

- [ ] Every producer, mutation boundary, event type, consumer, callback, retry, DLQ, and operator path is mapped.
- [ ] Business mutation, idempotency record, and outbox insertion share the documented atomic boundary.
- [ ] Envelope schema, size limits, ordering rule, lease semantics, and acknowledgment behavior are versioned and tested.
- [ ] Unknown producer results and duplicate delivery have explicit recovery behavior.
- [ ] Re-drive identity, auth/method/status contracts, and receipt retention are verified.
- [ ] Local/CI transaction topology and provider/source read-only probes are checked independently.
- [ ] Independent adversarial review is complete before implementation proceeds.
