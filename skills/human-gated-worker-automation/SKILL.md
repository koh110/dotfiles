---
name: human-gated-worker-automation
description: Use when designing an agent-orchestrated automation that gathers data in a Worker/API, asks a human to review proposed updates in a chat interface, and applies confirmed changes to durable storage. Covers prepare-confirm-apply APIs, advisory confidence, entity-level partial success, idempotency, snapshots, and model/Worker responsibility boundaries.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [human-gating, workers, approvals, idempotency, snapshots]
    related_skills: [spec-drilldown, reliable-event-processing, fail-closed-automation]
---

# Human-gated Worker Automation

## Trigger

Use this skill when a task combines:

- a scheduled LLM agent or chat workflow;
- one or more Worker/serverless APIs that own data retrieval and persistence;
- model-generated semantic judgments such as recommendation, direction, classification, or prioritization;
- human review before side effects; and
- updates to existing records where stale or partial data could destroy valid state.

This is a class-level design skill. It is not limited to a particular repository, asset type, chat platform, or model provider.

## Core boundary

Keep the durable domain contract in the Worker/API and keep conversational orchestration in the agent or equivalent runtime:

| Responsibility | Worker/API | Agent/model/chat |
| --- | --- | --- |
| Candidate selection from authoritative data | Yes | No |
| External source retrieval and source timestamps | Yes | No |
| Deterministic calculations with explicit formulas | Yes | No |
| Durable run/proposal state | Yes | No |
| Input schema and value validation | Yes | No |
| Semantic interpretation and recommendation | No, validate only | Yes |
| Human-facing explanation and confirmation | No | Yes |
| Apply request orchestration | Validate and persist | Initiate after confirmation |

Do not give the agent direct database access when the Worker API can enforce validation, authentication, idempotency, and audit policy.

## Required lifecycle: prepare → confirm → apply

1. **Prepare**
   - Select the bounded candidate set from a named snapshot/version.
   - Read current values and fetch source data in the Worker.
   - Compute only unambiguous formulas in the Worker.
   - Persist a run/proposal snapshot before asking the model to reason over it.
   - Return a stable `runId`, `proposalHash`, `expiresAt`, source metadata, current values, and model inputs.

2. **Model decision**
   - Require structured JSON, not free-form text as the write contract.
   - Include field-level `action` (`update`/`skip`), proposed value, reason, and confidence where useful.
   - Treat model output as untrusted input: validate it at the Worker boundary.
   - A model's uncertainty must be explicit (`skip` plus reason), not represented by empty strings or guessed defaults.

3. **Confirm**
   - Present before/after, source, reason, and confidence to the human in a continuable chat thread/session.
   - Store the proposed recommendation in a dedicated recommendation/proposal table rather than mixing it into the canonical research/value table.
   - If a human reviews the proposal before apply, confidence is advisory evidence, not an automatic rejection threshold unless the user explicitly requires one.
   - Confirmation must identify the exact `runId`, proposal hash, and entity set being approved.

4. **Apply**
   - Require authentication, valid run state, non-expired proposal, matching hash, allowed entity IDs, and schema-valid decisions.
   - Apply only fields explicitly marked `update`; `skip`, rejected, missing, invalid, or unavailable fields remain unchanged.
   - Preserve existing values when retrieval or reasoning fails. Never turn unavailable data into an empty-string overwrite.
   - Make the operation idempotent by run/proposal identity.

## Data model

At minimum, persist:

- run/proposal identity and status (`prepared`, `confirmed`, `applied`, `expired`, `failed`);
- source snapshot timestamp and source references;
- before values and proposed values;
- proposal hash and expiration;
- model decision JSON, reason, and confidence;
- human decision JSON and confirmation timestamp;
- per-entity apply status and error;
- applied timestamp and run identity.

Keep semantic recommendation state in a dedicated table when it is conceptually different from raw research metrics or canonical values. Do not store `up/down/stay` in a numeric/text metric column merely because that column already exists.

## Partial failure and transaction scope

Choose the transaction boundary explicitly. When the requirement is entity-level partial success:

- process each entity in its own transaction;
- record success/failure per entity;
- continue with other entities after one entity fails;
- make retries safe for already-applied entities;
- report both successful and failed entity IDs.

Do not claim all-or-nothing semantics when the user selected entity-level application.

## Scheduling and snapshot ordering

When a morning prepare consumes a daily ranking or catalog updated later in the day:

- schedule the source snapshot refresh after the user's stated cutoff;
- schedule prepare after the snapshot is expected to be complete, commonly on the next morning;
- document the timezone and convert to the platform's actual cron timezone before writing expressions;
- avoid scheduling the source refresh and prepare at the same instant;
- include the snapshot's `fetchedAt` in the run and user-facing report.

If the source refresh currently shares a schedule with a new prepare flow, change the schedule or add an explicit generation/version barrier rather than relying on timing luck.

## Scheduled agent behavior and chat delivery

For a job that must receive a human reply, use a normal model-driven continuable job and a dedicated origin thread/session. Do not use script-only execution for semantic judgment or confirmation: a script-only job has no conversational model turn.

The job prompt must be self-contained because scheduled jobs run in fresh agent sessions. It must specify:

- Worker API endpoints and authentication mechanism without exposing secret values;
- the prepare/decision/confirm/apply sequence;
- the structured decision schema;
- what must never be overwritten;
- how to identify the approved run;
- how to report partial success and failures.

Pin the model/provider for unattended jobs when the runtime supports per-job pinning, and keep delivery scoped to the origin chat/thread. Never make a scheduled job recursively create more scheduled jobs.

## Decision endpoint adapter and chat delivery

When the Worker contract separates entity-level recommendation state from field-level actions, construct one decision object per entity. Represent each `updatableFields` entry in a `fields` record and set its nested action explicitly to `skip` with a reason; do not send a flat list of `{field, action}` objects unless the endpoint contract explicitly requires that shape. Do not include proposed values for skipped fields. Validate the live response contract before posting candidate messages. The reusable schema-probing and adapter details are documented in [`references/decision-endpoint-adapter.md`](references/decision-endpoint-adapter.md).

For runtimes that suppress duplicate-target posts, use the platform adapter's documented separate-send mechanism when an additional exact candidate message is required. Verify the returned message ID, keep the final report separate, and do not alter the candidate body.

## Common pitfalls

- Reusing a full-replacement PUT/POST for field-level skip semantics.
- Sending only `code` or partial objects to an upsert that normalizes omitted fields to `''`.
- Letting the model choose candidates or fetch authoritative data, causing non-reproducible scope.
- Treating confidence as a substitute for human confirmation when the user explicitly wants a review step.
- Storing recommendations in the canonical metrics table, making audit and rollback ambiguous.
- Applying all entities in one transaction after the user selected entity-level continuation.
- Applying a proposal by `code` alone without a run hash, expiry, or snapshot identity.
- Assuming cron expressions use local time without checking the scheduler's timezone.
- Claiming a review passed based only on a child process exit code; verify the actual model identity, structured verdict, and target revision.

## Verification checklist

Before implementation approval, verify:

- [ ] Candidate selection is deterministic and bounded.
- [ ] Source values, source timestamps, and snapshot identity are persisted.
- [ ] Prepare and apply are separate API operations.
- [ ] Proposal state, hash, expiry, and idempotency are defined.
- [ ] Structured model output is schema-validated.
- [ ] Human confirmation is required before side effects.
- [ ] `skip` means no change, never empty-string overwrite.
- [ ] Recommendation state is separated from canonical metrics where appropriate.
- [ ] Transaction scope matches the user's partial-failure decision.
- [ ] Authentication is consistent on all write paths.
- [ ] Cron timezone and ordering are verified.
- [ ] Tests cover stale proposals, duplicate apply, invalid decisions, source failure, one-entity failure, and retry after partial success.

## References

- See `references/portfolio-research-run-example.md` for a condensed example of a daily ranked-data workflow with a human-gated apply phase.
- For specification-first questioning and adversarial review, use the existing `spec-drilldown` skill.
- For editing existing scheduled jobs, use the applicable runtime/job-maintenance skill; this skill supplies the domain design contract, not the job-editing procedure.
