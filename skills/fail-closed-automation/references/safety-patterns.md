# Safety patterns

## Contents

- [1. Containment without `..foo` false positives](#1-containment-without-foo-false-positives)
- [2. Existing-entry identity](#2-existing-entry-identity)
- [3. Exclusive artifact ownership](#3-exclusive-artifact-ownership)
- [4. Bounded subprocess lifecycle](#4-bounded-subprocess-lifecycle)
- [5. Safe destructive sequence](#5-safe-destructive-sequence)
- [6. Git worktree cleanup predicates](#6-git-worktree-cleanup-predicates)
- [7. Snapshot/baseline comparison](#7-snapshotbaseline-comparison)
- [8. Strict JSON verdicts](#8-strict-json-verdicts)

## 1. Containment without `..foo` false positives

```js
import path from 'node:path'

function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}
```

Apply this independently to lexical absolute paths and `realpath()` results. Decide explicitly whether equality with the root is allowed.

## 2. Existing-entry identity

For every output/input pair:

1. compare normalized absolute paths
2. resolve existing ancestors and compare canonical paths
3. when both entries exist, compare `lstat` and opened-handle `stat` identities using `dev` and `ino`
4. revalidate the opened identity at the mutation boundary and prefer descriptor-relative/no-follow operations

Reject on any match or identity change. `realpath()` alone does not detect different hardlinks to the same inode and cannot close a later ancestor-replacement race. If the platform lacks the required mutation primitive, refuse use on an adversarially writable filesystem.

## 3. Exclusive artifact ownership

```js
const handle = await fs.open(`${artifact}.lock`, 'wx', 0o600)
```

Acquire locks in deterministic sorted order only inside a trusted local directory with reliable atomic exclusive-create semantics. Network filesystems or adversarially writable lock directories require a platform-specific atomic protocol; otherwise refuse. Record each opened handle's `(dev, ino)`. Before reverse-order unlink, revalidate that each lock pathname still has the recorded identity; if missing or replaced, preserve it and fail for manual recovery. Treat pathname revalidation as defense in depth, not as a way to make unlink safe in an adversarial directory. Keep locks until all failure cleanup is complete.

Create each output under a per-run random temporary name with exclusive/no-follow creation; any pre-existing temporary path is a refusal, never an overwrite. Record the created handle's identity. Preserve any pre-existing target. Publish with a platform-appropriate atomic no-clobber/CAS protocol, record the published identity, and clean up only when the current name still matches that identity. A top-level catch that removes a shared artifact name can delete another run's output.

Record a random run ID in lock metadata when stale-lock recovery is required. Stale-lock recovery itself must atomically claim the exact observed lock using a trusted-filesystem protocol; PID existence alone is insufficient across hosts or PID reuse.

## 4. Bounded subprocess lifecycle

Use `spawn()` rather than buffered convenience APIs when output must be capped precisely.

- create a process group only where the runtime/OS defines usable descendant-group semantics; use a platform-specific job/container strategy elsewhere
- consume stdout/stderr as buffers
- feed evidence bytes through `new TextDecoder('utf-8', { fatal: true })` with `{ stream: true }`; reject decode errors and an incomplete final sequence
- stop capture at a configured byte count
- on timeout/overflow, signal the process group, then escalate to `SIGKILL`
- keep a final abandonment path that destroys stdio listeners/streams and settles the controlling promise if `close` never arrives; report termination as unconfirmed, preserve locks/quarantine, and prohibit artifact publication or removal
- finalize each fatal decoder deterministically on every terminal path (normal close, timeout, overflow, launch error, abandonment) while retaining the byte cap; decoder failure rejects evidence

Use a one-shot `settle()` guard so `error`, `exit`, `close`, timeout, and overflow cannot resolve the operation twice.

## 5. Safe destructive sequence

```text
DISCOVER
  -> VALIDATE snapshot A
  -> REQUERY authoritative source
  -> compare snapshot A/B
  -> registration-aware quarantine move (for registered resources)
  -> VALIDATE quarantined target again
  -> MUTATE registration/index
  -> verify mutation result
  -> REMOVE quarantine
```

For Git worktrees, use `git worktree move <candidate> <random-quarantine>` so Git's administrative path remains synchronized; do not use raw filesystem `rename()`. Refuse cleanup when `git worktree move` is unsupported or fails (including unsupported submodule cases). For ordinary directories, use an atomic same-filesystem rename when available.

If a post-quarantine check fails, restore through the same registration-aware operation only when the original path is free and identity still matches. Otherwise preserve quarantine and emit a manual-recovery path.

## 6. Git worktree cleanup predicates

Before cleanup require all of the following:

- candidate is a registered, unlocked linked worktree under the allowlisted root
- candidate is not the main/default-branch worktree
- tracked, untracked, and ignored-file checks are all empty
- candidate `HEAD`, local branch ref, and expected branch identity agree
- default branch is explicit or obtained from authoritative remote metadata; never guess `main`/`master`
- remote default name and OID are re-queried just before mutation
- merge evidence is exact and current

For an ordinary merge, require candidate `HEAD` to be an ancestor of the re-queried authoritative remote-default OID. For squash/rebase merge evidence, require candidate `HEAD` to equal the merged PR's exact head OID and require the merge commit/result to be reachable from that same re-queried default OID. Unattended cleanup must preserve the local branch because branch checkout occupancy and ref deletion cannot be atomically coordinated with ordinary Git CLI operations. Report the preserved branch for explicit follow-up; never use branch-name-only forced deletion in automation.

## 7. Snapshot/baseline comparison

Represent each field with both presence and value when the source language can erase distinctions:

```json
{
  "field": {
    "present": true,
    "value": ""
  }
}
```

Store IDs and sequence separately. Reject duplicate IDs and validate the exact input key set before building maps. Compare field-by-field against an allowlist and include before/after values in findings; unknown or misspelled fields are errors, not ignored drift. Never overwrite the input config or alias the baseline output to it.

## 8. Strict JSON verdicts

Ordinary `JSON.parse()` accepts duplicate keys by keeping the last value. For security/quality gates, use a duplicate-aware parser or a formally JSON-tokenizing pass that detects duplicate decoded keys at every object depth; textual regex pre-scans are insufficient for escapes and nesting. Then require:

- exact top-level key set
- exact array/string/object types
- no unknown properties
- exact runtime identity evidence
- blocking arrays empty

Write transcripts and verdict candidates under per-run names so malformed output remains diagnosable. A lock proves exclusion, not ownership of a pre-existing shared verdict: delete or invalidate only a current run's name whose recorded identity still matches. Preserve or registration-aware-quarantine an unowned stale artifact; otherwise refuse and require manual recovery.
