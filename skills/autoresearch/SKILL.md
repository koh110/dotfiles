---
compatibility: Requires git. The project must be a git repository. Requires terminal access to run commands.
description: 'Autonomous iterative experimentation loop for any programming task. Guides the user through defining goals, measurable metrics, and scope constraints, then runs an autonomous loop of code changes, testing, measuring, and keeping/discarding results. Inspired by Karpathy''s autoresearch. USE FOR: autonomous improvement, iterative optimization, experiment loop, auto research, performance tuning, automated experimentation, hill climbing, try things automatically, optimize code, run experiments, autonomous coding loop. DO NOT USE FOR: one-shot tasks, simple bug fixes, code review, or tasks without a measurable metric.'
license: MIT
metadata:
    author: luiscantero
    github-path: skills/autoresearch
    github-ref: refs/heads/main
    github-repo: https://github.com/github/awesome-copilot
    github-tree-sha: a89e8007dc84571d21ad6717d96ccdc3d94d3039
    inspired-by: https://github.com/karpathy/autoresearch
name: autoresearch
---
# Autoresearch: Autonomous Iterative Experimentation

An autonomous experimentation loop for any programming task. You define the goal and how to measure it; the agent iterates autonomously -- modifying code, running experiments, measuring results, and keeping or discarding changes -- until interrupted.

This skill is inspired by [Karpathy's autoresearch](https://github.com/karpathy/autoresearch), generalized from ML training to **any programming task with a measurable outcome**.

---

## Agent Behavior Rules

1. **DO** guide the user through the Setup phase interactively before starting the loop.
2. **DO** establish a baseline measurement before making any changes.
3. **DO** commit every experiment attempt before running it (so it can be reverted cleanly).
4. **DO** keep a results log (TSV) tracking every experiment.
5. **DO** revert changes that do not improve the metric (git reset to last known good).
6. **DO** run autonomously once the loop starts -- never pause to ask "should I continue?".
7. **DO NOT** modify files the user marked as out-of-scope.
8. **DO NOT** skip the measurement step -- every experiment must be measured.
9. **DO NOT** keep changes that regress the metric unless the user explicitly allowed trade-offs.
10. **DO NOT** install new dependencies or make environment changes unless the user approved it.

---

## Phase 1: Setup (Interactive)

Before any experimentation begins, work with the user to establish these parameters.
Ask the user directly for each item. Do not assume or skip any.

### 1.1 Define the Goal

Ask the user:

> **What are you trying to improve or optimize?**
>
> Examples: execution time, memory usage, binary size, test pass rate, code coverage,
> API response latency, throughput, error rate, benchmark score, build time, bundle size,
> lines of code, cyclomatic complexity, etc.

Record the user's answer as the **goal**.

### 1.2 Define the Metric

Ask the user:

> **How do we measure success? What exact command produces the metric?**
>
> I need:
> 1. **The command** to run (e.g., `dotnet test`, `npm run benchmark`, `time ./build.sh`, `pytest --tb=short`)
> 2. **How to extract the metric** from the output (e.g., a regex pattern, a specific line, a JSON field)
> 3. **Direction**: Is lower better or higher better?
>
> Example: "Run `dotnet test --logger trx`, count passing tests. Higher is better."
> Example: "Run `hyperfine './my-program'`, extract mean time. Lower is better."

Record:
- `METRIC_COMMAND`: the command to run
- `METRIC_EXTRACTION`: how to extract the numeric metric from output
- `METRIC_DIRECTION`: `lower_is_better` or `higher_is_better`

### 1.3 Define the Scope

Ask the user:

> **Which files or directories am I allowed to modify?**
>
> And which files are OFF LIMITS (read-only)?

Record:
- `IN_SCOPE_FILES`: files/dirs the agent may edit
- `OUT_OF_SCOPE_FILES`: files/dirs that must not be modified

### 1.4 Define Constraints

Ask the user:

> **Are there any constraints I should respect?**
>
> Examples:
> - Time budget per experiment (e.g., "each run should take < 2 minutes")
> - No new dependencies
> - Must keep all existing tests passing
> - Must not change the public API
> - Must maintain backward compatibility
> - VRAM/memory limit
> - Code complexity limits (prefer simpler solutions)

Record as `CONSTRAINTS`.

### 1.5 Define the Experiment Budget (Optional)

Ask the user:

> **How many experiments should I run, or should I just keep going until you stop me?**
>
> You can say a number (e.g., "try 20 experiments") or "unlimited" (I'll run until you interrupt).

Record as `MAX_EXPERIMENTS` (number or `unlimited`).

### 1.6 Simplicity Criterion

Inform the user of the default simplicity policy:

> **Simplicity policy (default):** All else being equal, simpler is better. A small improvement
> that adds ugly complexity is not worth it. Removing code while maintaining or improving
> the metric is a great outcome. I'll weigh the complexity cost against the improvement
> magnitude. Does this policy work for you, or do you want to adjust it?

Record any adjustments as `SIMPLICITY_POLICY`.

### 1.7 Confirm Setup

Summarize all parameters back to the user in a clear table:

| Parameter          | Value                        |
| ------------------ | ---------------------------- |
| Goal               | ...                          |
| Metric command     | ...                          |
| Metric extraction  | ...                          |
| Direction          | lower is better / higher ... |
| In-scope files     | ...                          |
| Out-of-scope files | ...                          |
| Constraints        | ...                          |
| Max experiments    | ...                          |
| Simplicity policy  | ...                          |

Ask the user to confirm. Do not proceed until confirmed.

---

## Phase 2: Branch & Baseline

Once the user confirms:

0. **Check the working tree is clean**: Run `git status --short`. If there is any tracked
   or untracked change already present, **stop and ask the user** whether to commit,
   stash, or abandon those changes before starting. The loop later reverts failed
   experiments with `git reset --hard HEAD~1`, which would destroy any pre-existing
   uncommitted work if it were left in place.

1. **Create a branch**: Check whether the current directory is the repo's root checkout
   or an existing linked worktree (`git rev-parse --path-format=absolute --git-dir` vs
   `--git-common-dir`; equal means root checkout). If this repo follows a convention of
   doing branch work in a dedicated linked worktree (e.g. a `.worktree/` subdirectory)
   rather than the root checkout, create the experiment worktree there and `cd` into it
   before branching, instead of running the loop directly in the root checkout. If
   already in a linked worktree, just create the branch there. Propose a tag based on
   today's date (e.g., `autoresearch/mar17`). Create the branch:
   `git checkout -b autoresearch/<tag>`.

2. **Read in-scope files**: Read all files that are in scope to build full context of the current state.

3. **Initialize results.tsv**: Create `results.tsv` in the repo root with the header row:
   ```
   experiment	commit	metric	status	description
   ```
   Add `results.tsv` and `run.log` to the repo's exclude file (append if not already
   present) so they stay untracked without modifying any tracked files. Resolve the
   correct path with `git rev-parse --git-path info/exclude` rather than assuming
   `.git/info/exclude` — in a linked worktree, `.git` is a file pointing elsewhere, so
   the fixed path does not exist there.

4. **Run the baseline**: Execute the metric command on the current unmodified code.
   Record the result as experiment `0` with status `baseline` in `results.tsv`.

5. **Report baseline** to the user:
   > Baseline established: **[metric_name] = [value]**
   > Starting autonomous experimentation loop.

---

## Phase 3: Experiment Loop

Run this loop continuously. Do not stop to ask the user. Run until:
- `MAX_EXPERIMENTS` is reached, OR
- The user manually interrupts

### For each experiment:

```
LOOP:
  1. THINK   - Analyze previous results and the current code.
               Generate an experiment hypothesis.
               Consider: what worked, what didn't, what hasn't been tried.

  2. EDIT    - Modify the in-scope file(s) to implement the idea.
               Keep changes focused and minimal per experiment.

  3. COMMIT  - Before committing, record the current `git rev-parse HEAD` as
               `parent_sha` (this is the last known-good state -- either the
               baseline or the previous kept experiment).
               git add + git commit with a short descriptive message.
               Format: "experiment: <short description of what changed>"
               **Verify the commit actually succeeded** (commit command exited
               0 AND `git rev-parse HEAD` now differs from `parent_sha`).
               If the commit failed (hook rejection, signing failure, nothing
               to commit, etc.), HEAD has not advanced -- do NOT proceed to
               RUN/MEASURE/DECIDE for this experiment, since step 6's revert
               assumes HEAD is one commit ahead of `parent_sha` and would
               otherwise destroy `parent_sha` itself. Instead, log this
               experiment as `status = "crash"` with the commit error, leave
               the working tree as-is for inspection, and stop the loop to
               report the failure to the user rather than guessing at a fix.
               Record the resulting commit SHA (`git rev-parse HEAD`) as this
               experiment's expected commit -- it is needed to safely verify
               the revert in step 6.

  4. RUN     - Execute the metric command.
               Redirect output to run.log so it does not flood the context window.
               Use shell-appropriate redirection:
               - Bash/Zsh: `<command> > run.log 2>&1`
               - PowerShell: `<command> *> run.log`

  5. MEASURE - Extract the metric from run.log.
               If extraction fails (crash/error), read the last 50 lines
               of run.log for the error.

  6. DECIDE  - Compare metric to the current best:
               - IMPROVED: Keep the commit. Update the "best" baseline.
                 Log status = "keep".
               - SAME, but the change simplifies the code (per the Simplicity Criterion
                 / SIMPLICITY_POLICY agreed in Setup, e.g. removes code without
                 regressing the metric): Keep the commit. Log status = "keep"
                 (description should note the simplification).
               - WORSE, but within an explicitly allowed trade-off (per SIMPLICITY_POLICY
                 or CONSTRAINTS agreed in Setup): Keep the commit. Log status = "keep"
                 (description should note the accepted trade-off).
               - SAME OR WORSE, and not covered by the above: **Before reverting, verify
                 `git rev-parse HEAD` still equals this experiment's recorded commit SHA,
                 `git rev-parse HEAD~1` equals `parent_sha` from step 3, AND
                 `git status --short` is empty (no tracked or untracked changes beyond
                 what is already committed).** The metric command itself may have written
                 to tracked files as a side effect without committing them (e.g. a
                 benchmark that updates a checked-in snapshot); `git reset --hard` would
                 silently discard that. If any of these checks fail, stop and report to
                 the user instead of resetting -- do not guess. Otherwise revert:
                 `git reset --hard HEAD~1`. Log status = "discard".
               - CRASH: Attempt a quick fix (typo, import, simple error).
                 Amend the experiment commit (`git commit --amend`) with the fix
                 and rerun. The experiment keeps its original number.
                 **`git commit --amend` produces a new SHA -- re-record
                 `git rev-parse HEAD` as this experiment's expected commit after every
                 amend**, so that whichever branch (IMPROVED / SAME-OR-WORSE / CRASH
                 again) this retry ends up in, its "recorded commit SHA" check compares
                 against the current amended commit, not the pre-amend one. `parent_sha`
                 itself does not change across amends (amend does not move `HEAD~1`).
                 If unfixable after 2 attempts, revert the entire experiment. Apply the
                 same pre-revert verification as the SAME OR WORSE case above (current
                 recorded commit SHA, `HEAD~1` must equal `parent_sha`, and
                 `git status --short` empty) before running `git reset --hard HEAD~1`,
                 then log status = "crash".

  7. LOG     - Append a row to results.tsv:
               experiment_number  commit_hash  metric_value  status  description

  8. CONTINUE - Go to step 1.
```

### Experiment Strategy

When generating experiment ideas, follow this priority order:

1. **Low-hanging fruit first**: Simple parameter tweaks, obvious inefficiencies.
2. **Informed by results**: If a direction showed promise, explore further in that direction.
3. **Diversify after plateaus**: If the last 3-5 experiments all failed, try a different approach entirely.
4. **Combine winners**: If experiments A and B each improved independently, try combining them.
5. **Simplification passes**: Periodically try removing code/complexity to see if the metric holds.
6. **Radical changes**: After exhausting incremental ideas, try larger architectural changes.

### Handling Constraints

- **Time budget**: If a run exceeds 2x the expected duration, kill it and treat as a crash.
- **Existing tests**: If constraints require tests to pass, run them before/after and revert if they break.
- **Memory/resources**: Monitor and revert if resource usage exceeds stated limits.

---

## Phase 4: Reporting

When the loop ends (budget reached or user interrupts):

1. **Print the full results.tsv** as a formatted table.
2. **Summarize**:
   - Total experiments run
   - Experiments kept / discarded / crashed
   - Starting metric (baseline) vs. final metric
   - Improvement percentage
   - Top 3 most impactful changes
3. **Show the cumulative git log** of kept experiments:
   `git log --oneline <start_commit>..HEAD`
4. **Recommend next steps**: Based on the results, suggest what a human researcher might try next (ideas that were too risky/complex for automated experimentation).

---

## Quick Reference

### Results TSV Format

Tab-separated, 5 columns:

```
experiment	commit	metric	status	description
0	a1b2c3d	0.997900	baseline	unmodified code
1	b2c3d4e	0.993200	keep	increase learning rate to 0.04
2	c3d4e5f	1.005000	discard	switch to GeLU activation
3	d4e5f6g	0.000000	crash	double model width (OOM)
```

### Git Workflow

- All experiments happen on the `autoresearch/<tag>` branch
- Each experiment is committed before running
- Failed experiments are reverted with `git reset --hard HEAD~1`
- Successful experiments advance the branch
- `results.tsv` and `run.log` stay untracked (added to the repo's exclude file, resolved
  via `git rev-parse --git-path info/exclude` -- not the fixed path, see Phase 2 step 3)

### Key Principles

1. **Measure everything**: No experiment without a measurement.
2. **Revert failures**: The branch only advances on improvements.
3. **Stay autonomous**: Never stop to ask. Think harder if stuck.
4. **Keep it simple**: Complexity is a cost. Weigh it against gains.
5. **Log everything**: The TSV is the research journal.
