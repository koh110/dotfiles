# Ranked research workflow reference

This reference captures a reusable shape discovered while designing a ranked-data automation. It is deliberately repository-agnostic; replace names and times for each project.

## Sequence

1. A Worker refreshes the authoritative ranking snapshot after the daily source cutoff.
2. A morning agent job calls `prepare` for a bounded top-N set from the latest snapshot.
3. The Worker fetches external source data, reads current records, computes explicit formulas, and persists a run snapshot.
4. The agent interprets facts into field-level structured decisions and stores a separate recommendation/proposal record.
5. The chat adapter receives before/after/source/confidence and awaits a human decision in a continuable thread.
6. The agent calls `apply` with the exact run ID, proposal hash, and confirmed entity set.
7. The Worker validates and applies each entity in its own transaction, recording per-entity success/failure.

## Key decisions to preserve

- Human review means confidence is evidence, not an automatic threshold. Uncertainty should still be explicit as `skip` plus a reason.
- Existing values may be overwritten only by valid, explicitly approved fresh values. Failed retrieval and skipped fields do not become empty strings.
- Recommendation state belongs in a dedicated table when it is not the same concept as the canonical research/value record.
- Apply must reject stale, expired, hash-mismatched, unauthenticated, or out-of-scope proposals.
- Entity-level partial success must be represented in the run result; do not accidentally implement one large all-or-nothing transaction.

## Review questions

- Does the existing upsert/PUT semantics erase omitted fields?
- Is the recommendation table auditable independently from the canonical values?
- Can a duplicate apply be recognized without relying on chat text?
- Does the morning job consume a known snapshot generation, rather than assuming the refresh finished?
- Are the scheduler timezone and UTC expression verified from the scheduler documentation?
- Does the human confirmation identify the exact entities, not merely the run as a whole?
