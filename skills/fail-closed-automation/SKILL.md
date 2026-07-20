---
name: fail-closed-automation
description: Design or review destructive, unattended, or external-tool-driven automation so uncertainty causes a safe refusal rather than mutation. Use for filesystem cleanup, Git/worktree cleanup, subprocess runners, generated artifacts, config/baseline auditors, external review gates, symlink-sensitive traversal, TOCTOU-sensitive operations, or any CLI/cron/CI task that can delete, overwrite, publish, or accept evidence.
---

# Fail-Closed Automation

## Core rule

Define the mutation as the final step of a proof, not the default branch of the program. Missing, stale, ambiguous, unreadable, malformed, timed-out, or conflicting evidence must refuse the mutation and identify the failed predicate.

Keep product/runtime-specific resolution in an adapter. Keep the safety core independent of one scheduler, model provider, repository host, or config schema. Each adapter must define its authoritative freshness clock, active-writer/lease contract, identity granularity, and evidence re-read point; missing domain contracts are refusal conditions, not defaults to infer.

## Workflow

1. Enumerate assets, mutation boundaries, external evidence, and rollback limits.
2. Write every safety predicate before implementing the mutation.
3. Separate pure discovery/validation from side effects.
4. Validate lexical paths and resolved filesystem identity.
5. Re-read volatile evidence immediately before mutation.
6. Move destructive targets to an in-boundary random quarantine when reversible staging is possible.
7. Re-run safety predicates after quarantine and before irreversible removal.
8. Emit a structured reason for every refusal; never silently downgrade an error to a skip.
9. Test both the happy path and each refusal/race path.

For implementation patterns, read [references/safety-patterns.md](references/safety-patterns.md).

## Filesystem and artifact rules

- Validate both `path.resolve()` containment and `realpath()` containment as discovery checks; they are not mutation-time race protection.
- For mutation, prefer descriptor-relative/no-follow operations and compare `lstat()` or opened-handle `(dev, ino)` identity at the last possible point. Refuse adversarial-filesystem use cases when the platform cannot provide the required primitive.
- Treat `relative === '..'` and `relative.startsWith('..' + path.sep)` as escapes; do not reject harmless names such as `..cache`.
- Detect broken symlinks, symlink cycles, unreadable files/directories, and root-external symlink exposure separately.
- Before writing any output, reject every input/output and output/output same-path, symlink-target, or hardlink alias using canonical paths plus `(dev, ino)` when entries exist.
- Acquire exclusive locks only in a trusted, non-adversarial directory on a filesystem with reliable atomic exclusive-create semantics; otherwise use a platform-specific atomic protocol or refuse. Record opened lock identity, release in reverse order, and unlink a lock path only when its current identity still matches; preserve and fail if missing or replaced.
- Create outputs under per-run random temporary names using exclusive, no-follow creation. Refuse a pre-existing name, record creation/publication `(dev, ino)`, preserve pre-existing targets, and clean up only current names whose identity still matches this run.
- Never perform failure cleanup after releasing the lock. Treat stale-lock recovery as its own atomic fail-closed protocol.
- Use cryptographically random quarantine/temporary names and keep them on the same filesystem when relying on atomic move. Quarantine and rollback require atomic no-clobber/CAS semantics with recorded identity. A registration-aware tool that cannot provide that primitive is allowed only when source/destination parents are trusted and non-adversarial and the threat model explicitly excludes concurrent destination creation/replacement; otherwise refuse.

## Subprocess rules

- Set a finite timeout and an explicit upper bound for user-configurable timeouts.
- Bound stdout and stderr independently or with a documented combined cap.
- Decode evidence streams with fatal streaming UTF-8 validation and reject invalid bytes or incomplete final sequences. Non-evidence diagnostic logs may use a replacement decoder if explicitly separated.
- Spawn a process group only on platforms where the runtime provides defined group/session semantics; use a platform-specific containment strategy elsewhere.
- On timeout or overflow, escalate termination and guarantee the parent promise settles even if `close` never arrives. Treat missing termination confirmation as a hard failure: do not publish/remove artifacts or release isolation that a surviving child can still mutate.
- Distinguish launch failure, timeout, output overflow, signal exit, non-zero exit, malformed output, and semantic rejection.
- Treat startup banners, invocation arguments, and self-reported model/provider names as corroborative, untrusted evidence. An identity-sensitive gate requires authenticated observed identity from the provider/runtime response and refuses when unavailable or mismatched; a requested identity does not prove what executed.

## Baseline and verdict rules

- Version baseline and input schemas, require the exact allowed key set at every validated object level, and reject unsupported versions or unknown/misspelled fields instead of guessing migrations.
- Preserve sequence where order is semantically meaningful.
- Distinguish absent fields, `null`, empty strings, empty arrays, and `false`.
- Compare only explicitly allowlisted fields; reject new IDs, duplicate IDs, missing IDs, and unapproved field changes.
- Refuse to write or bless a baseline while validation errors exist.
- Validate external verdicts against a strict schema, reject duplicate JSON keys, unknown keys, non-string findings, and model identity mismatches.
- Define an explicit, versioned acceptance policy listing every blocking finding field. Reject unknown or renamed severity fields; a gate passes only when every policy-listed blocking field is empty.

## TOCTOU and external evidence

- Record the first observation, then re-query the authoritative source immediately before mutation.
- Compare identity and value: path identity, object ID, ref name, commit/OID, generation/version, or equivalent.
- If the source changed, refuse and restart discovery rather than continuing from mixed snapshots.
- Do not accept indirect evidence when an exact identifier is available.
- State the threat model explicitly. Quarantine blocks ordinary path-based writers but not an adversarial same-user process retaining an old cwd/dirfd.

## Verification matrix

At minimum cover:

- valid operation
- dirty/untracked/ignored/unreadable input
- missing and malformed evidence
- symlink escape, hardlink alias, and symlink cycle
- stale snapshot / value changed between checks
- timeout, output overflow, invalid UTF-8, and incomplete final UTF-8 sequence
- launch failure, non-zero exit, signal exit, and descendant that survives parent exit
- concurrent run contending for the same artifacts
- pre-existing output preservation; lock-path replacement/loss; stale-lock takeover refusal
- per-run temporary/publication collision, quarantine-name collision, rollback-destination race, and cleanup identity mismatch
- rollback success and rollback refusal
- worktree removed after validation while the branch is concurrently checked out elsewhere
- unsupported baseline schema and unapproved field drift
- malformed/duplicated verdict JSON, nested unknown keys, non-string findings, and identity mismatch

Run the real executable or fixture. A code review without execution is not sufficient evidence.

## Reporting

Report:

- exact commands executed
- mutation count and refusal/error counts
- each safety refusal reason
- artifacts or transcripts used as evidence
- accepted residual risks

Do not report “nothing changed” as success when discovery itself failed.
