# Synchronous DB + External API Consistency

Use this reference when one HTTP request changes both a local database and a remote system such as an identity provider.

## Why compensation alone is insufficient

A sequence such as `lock row → update DB transaction → call remote API → commit DB → return success` has at least two ambiguous boundaries:

1. The remote API may apply the mutation and then the request context may be cancelled or the response may be lost. An error return does not prove the remote mutation did not happen.
2. `COMMIT` may reach the database and succeed while the client loses the acknowledgement. A commit error does not always prove rollback.

Blindly restoring the remote value on every commit error can invert the inconsistency: the DB may contain the new value while the remote system is restored to the old value. A request-context-bound compensation call is weaker still because it may fail immediately after cancellation.

## Minimum safe contract

- Do not send a success response until the required local commit is known successful.
- Bound row-lock and external-call duration explicitly.
- If best-effort compensation is used, run it with a new bounded context detached from request cancellation (`context.WithoutCancel` plus `context.WithTimeout` in Go).
- Treat external response ambiguity and DB commit ambiguity as distinct durable states, not generic failures.
- Persist an operation ID and enough old/new state to reconcile without trusting stale authentication/session context.
- Provide a durable reconciliation path that reads actual local and remote state, chooses the documented source of truth, retries idempotently, and reaches a terminal state or operator-visible dead-letter state.
- Never log raw credentials or tokens; minimize PII in reconciliation logs. Log operation IDs, state, age, attempt count, and classified failure.

## Design choices

### Durable synchronous saga

Create the durable operation record before crossing the first non-atomic boundary. Perform the user-visible path synchronously, then mark the operation complete. Ambiguous outcomes remain pending for a worker or scheduled reconciler. This can preserve a synchronous API while still guaranteeing eventual convergence.

### Transactional outbox / asynchronous operation

Atomically write the business mutation and an outbox event, commit, then let a relay/worker call the remote API. Return `202 Accepted` when the public contract is asynchronous, or expose operation status. This gives the clearest durability boundary but changes product/API semantics.

### Best-effort compensation only

Acceptable only when the product owner explicitly accepts residual inconsistency and the review gate records that exception. It cannot be described as a zero-inconsistency guarantee.

## Required tests

- Remote success followed by local commit failure.
- Cancelled request context before compensation; detached bounded compensation still executes.
- Remote mutation applied but response reported as error/timeout.
- Database commit acknowledgement lost/unknown.
- Compensation failure and subsequent durable reconciliation.
- Same-identity concurrent updates under row locking/idempotency.
- Reconciler retries, deduplication, terminal failure visibility, and PII-safe logs.
- Success response is emitted only after the documented consistency boundary.

## Review pitfall

Do not turn a review finding into an implicit outbox/worker architecture change. A new durable execution boundary requires a specification, failure-state model, operational contract, and independent adversarial review before implementation.
