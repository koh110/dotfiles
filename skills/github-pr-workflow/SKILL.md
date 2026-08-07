---
name: github-pr-workflow
description: "GitHub PR lifecycle: branch, commit, open, CI, merge."
version: 1.1.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [GitHub, Pull-Requests, CI/CD, Git, Automation, Merge]
    related_skills: [github-auth, github-repo-management, github-code-review]
---

# GitHub Pull Request Workflow

Complete guide for managing the PR lifecycle. Each section shows the `gh` way first, then the `git` + `curl` fallback for machines without `gh`.

This skill assumes the repository is already cloned and the branch/worktree context is known. For repo setup, cloning, remotes, and branch/worktree housekeeping, use the Git-focused workflow in `github-repo-management`.

## Prerequisites

- Authenticated with GitHub (see `github-auth` skill)
- Inside a git repository with a GitHub remote
- For cloning, remotes, and worktree setup, see `github-repo-management`

### Quick Auth Detection

```bash
# Determine which method to use throughout this workflow
if command -v gh &>/dev/null && gh auth status &>/dev/null; then
  AUTH="gh"
else
  AUTH="git"
  # Ensure we have a token for API calls
  if [ -z "$GITHUB_TOKEN" ]; then
    if _hermes_env="${HERMES_HOME:-$HOME/.hermes}/.env"; [ -f "$_hermes_env" ] && grep -q "^GITHUB_TOKEN=" "$_hermes_env"; then
      GITHUB_TOKEN=$(grep "^GITHUB_TOKEN=" "$_hermes_env" | head -1 | cut -d= -f2 | tr -d '\n\r')
    elif grep -q "github.com" ~/.git-credentials 2>/dev/null; then
      GITHUB_TOKEN=$(grep "github.com" ~/.git-credentials 2>/dev/null | head -1 | sed 's|https://[^:]*:\([^@]*\)@.*|\1|')
    fi
  fi
fi
echo "Using: $AUTH"
```

### Extracting Owner/Repo from the Git Remote

Many `curl` commands need `owner/repo`. Extract it from the git remote:

```bash
# Works for both HTTPS and SSH remote URLs
REMOTE_URL=$(git remote get-url origin)
OWNER_REPO=$(echo "$REMOTE_URL" | sed -E 's|.*github\.com[:/]||; s|\.git$||')
OWNER=$(echo "$OWNER_REPO" | cut -d/ -f1)
REPO=$(echo "$OWNER_REPO" | cut -d/ -f2)
echo "Owner: $OWNER, Repo: $REPO"
```

---

## 1. Branch Creation

This part is pure `git` — identical either way:

### Minimum-diff gate

Unless the user explicitly requests another base or broader scope, start from the current remote `main` and keep the branch limited to the stated deliverable.

Before implementation:

1. Fetch and verify `origin/main`.
2. Create the worktree/branch from `origin/main`, not from an existing feature branch, backup branch, or worktree with unrelated changes.
3. Write down the requested outcome and the files/features that are actually required.
4. Check `git diff --stat origin/main...HEAD` and inspect any pre-existing commits before editing.
5. Treat related functionality as out of scope unless the task has a concrete dependency: an import, route, schema, runtime call, or failing verification that proves it is required.
6. If a broader change appears necessary, stop and report the evidence before adding it.

After implementation, review the final diff against `origin/main` and remove unrelated routes, fixtures, snapshots, generated artifacts, and feature code. A previous branch or backup containing related work is context, not an implicit dependency.

```bash
# Make sure you're up to date
git fetch origin
git checkout main && git pull origin main

# Create and switch to a new branch
git checkout -b feat/add-user-authentication
```

Branch naming conventions:
- `feat/description` — new features
- `fix/description` — bug fixes
- `refactor/description` — code restructuring
- `docs/description` — documentation
- `ci/description` — CI/CD changes

## 2. Making Commits

Use the agent's file tools (`write_file`, `patch`) to make changes, then commit:

```bash
# Stage specific files
git add src/auth.py src/models/user.py tests/test_auth.py

# Commit with a conventional commit message
git commit -m "feat: add JWT-based user authentication

- Add login/register endpoints
- Add User model with password hashing
- Add auth middleware for protected routes
- Add unit tests for auth flow"
```

Commit message format (Conventional Commits):
```
type(scope): short description

Longer explanation if needed. Wrap at 72 characters.
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `ci`, `chore`, `perf`

## 3. Pushing and Creating a PR

### Language rule for this user

- Default PR title and PR body to **Japanese** unless the user explicitly asks for another language.
- When editing an existing PR description, keep the rewritten body in Japanese as well unless instructed otherwise.
- Commit messages should still follow the repository convention; do not force Japanese commit messages if the repo convention differs.

### PR body reset rule

When the user asks to "adjust the PR body" or "start over from the beginning," do **not** try to incrementally patch the old body in place.

Instead:
1. Read the current PR body only as context.
2. Rewrite the entire body from scratch with a clean structure.
3. Use a temporary file plus `--body-file` when editing with `gh pr edit` to avoid shell-quoting problems from backticks, Markdown, and code fences.
4. Re-fetch the PR body afterward to confirm the update landed exactly as intended.
5. If a PR body is likely to contain code, backticks, or long Markdown sections, default to the file-based path even when inline editing would fit.

See `references/pr-body-reset.md` for the reusable command pattern.

This avoids drift, stale wording, and accidental shell parsing errors.

### Base branch existence check

Before creating or retargeting a PR, verify that the intended base branch currently exists on GitHub, not only as a stale local `origin/<branch>` remote-tracking ref. Use `git ls-remote --heads origin <branch>` and/or `gh api repos/<owner>/<repo>/branches/<branch>`. If GitHub reports the base branch is missing, do not create a replacement branch or retarget the PR without explicit user direction; report that the dependency branch was deleted and that the dependent changes must wait for the dependency to reach an existing base branch.

### Repo targeting rule

When `gh` appears to be pointing at the wrong repository context, do not assume the current checkout is enough.

- Verify the intended repo with `gh repo view <owner>/<repo>` or by checking the remote explicitly. (`gh repo view` takes the repository as a positional argument; it does not support `-R`.)
- Pass `--repo <owner>/<repo>` (or `-R <owner>/<repo>` where that specific `gh` subcommand supports it) to `gh pr create`, `gh pr edit`, `gh pr view`, and similar commands when the repo context is ambiguous or a sibling repo/default branch is involved.
- Treat "No commits between main and <branch>" or a surprising default repo name as a signal to re-run the command with an explicit repo target.
- For broader repository operations such as cloning, remote setup, branch/worktree management, or moving between checkouts, prefer `github-repo-management`.

### Multi-PR / multi-repo safety harness

When the session contains more than one active PR or more than one repository, the default failure mode is to act on the wrong target. Make the target explicit before every mutation.

- Before creating, editing, merging, or commenting on a PR, restate the exact target as `owner/repo#number` or the full PR URL in your own working notes.
- Re-read the target with `gh pr view -R <owner/repo> <number>` immediately before mutation.
- After mutation, re-fetch the same PR and confirm the URL, repo, branch, and body match the intended target.
- Never reuse a PR number from another repository without an explicit `-R` flag.
- If the user says "fix the dotfiles PR" or names a repository, treat that repository as the only valid target until the task is complete.
- If you have both a feature repo and a backup repo open in the same session, note the active target repo in the very first line of your working notes before any `gh` write operation.
- Reusable command pattern and review checklist: [references/pr-targeting-harness.md](references/pr-targeting-harness.md)

### Push the Branch (same either way)

```bash
git push -u origin HEAD
```

### Closed / merged PR branch reuse pitfall

If you push new commits to a branch name that already had a PR which is now closed or merged, GitHub does **not** reopen or retarget that old PR automatically.

Use this verification sequence before assuming a PR update landed:

1. Check the remote branch SHA after push (`git rev-parse HEAD` and `git ls-remote origin refs/heads/<branch>`).
2. Inspect the existing PR state explicitly (`gh pr view -R <owner/repo> <number> --json state,merged,headRefName,headRefOid` or REST equivalent).
3. If the prior PR is already `merged` or `closed`, create a **new** PR for the new commits even if you reused the same branch name.
4. After creating or editing a PR, re-fetch the PR and confirm its `headRefOid` matches the commit you just pushed.

Treat "branch pushed successfully" and "PR now points at that commit" as separate checks.

### Create the PR

For this user, default the PR title and body to Japanese unless the user explicitly asks for another language. This applies both when creating a new PR and when rewriting an existing PR body after additional commits.

If `gh pr create` reports missing head/base SHAs or says there are no commits, or if gh seems to resolve the wrong repository, specify the repository and head branch explicitly. See the troubleshooting section below.

### Language rule for this user

For this user, default PR-facing text to Japanese unless they explicitly ask for another language.

- Write the PR title in Japanese.
- Write the PR body in Japanese.
- Keep commit messages in the project's existing convention unless the user asks to change that too.
- When editing an existing PR body, preserve this Japanese-default rule unless the target PR is intentionally English.

Treat this as part of PR quality, not an optional style preference.

**With gh:**

```bash
gh pr create \
  --title "feat: add JWT-based user authentication" \
  --body "## Summary
- Adds login and register API endpoints
- JWT token generation and validation

## Test Plan
- [ ] Unit tests pass

Closes #42"
```

Options: `--draft`, `--reviewer user1,user2`, `--label "enhancement"`, `--base develop`

**With git + curl:**

```bash
BRANCH=$(git branch --show-current)

curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/$OWNER/$REPO/pulls \
  -d "{
    \"title\": \"feat: add JWT-based user authentication\",
    \"body\": \"## Summary\nAdds login and register API endpoints.\n\nCloses #42\",
    \"head\": \"$BRANCH\",
    \"base\": \"main\"
  }"
```

The response JSON includes the PR `number` — save it for later commands.

To create as a draft, add `"draft": true` to the JSON body.

## 4. Monitoring CI Status

### Check CI Status

**With gh:**

```bash
# One-shot check
gh pr checks

# Watch until all checks finish (polls every 10s)
gh pr checks --watch
```

**With git + curl:**

```bash
# Get the latest commit SHA on the current branch
SHA=$(git rev-parse HEAD)

# Query the combined status
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/status \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f\"Overall: {data['state']}\")
for s in data.get('statuses', []):
    print(f\"  {s['context']}: {s['state']} - {s.get('description', '')}\")"

# Also check GitHub Actions check runs (separate endpoint)
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/check-runs \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
for cr in data.get('check_runs', []):
    print(f\"  {cr['name']}: {cr['status']} / {cr['conclusion'] or 'pending'}\")"
```

### Poll Until Complete (git + curl)

```bash
# Simple polling loop — check every 30 seconds, up to 10 minutes
SHA=$(git rev-parse HEAD)
for i in $(seq 1 20); do
  STATUS=$(curl -s \
    -H "Authorization: token $GITHUB_TOKEN" \
    https://api.github.com/repos/$OWNER/$REPO/commits/$SHA/status \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['state'])")
  echo "Check $i: $STATUS"
  if [ "$STATUS" = "success" ] || [ "$STATUS" = "failure" ] || [ "$STATUS" = "error" ]; then
    break
  fi
  sleep 30
done
```

## 5. Auto-Fixing CI Failures

When CI fails, diagnose and fix. This loop works with either auth method.

### Step 1: Get Failure Details

**With gh:**

```bash
# List recent workflow runs on this branch
gh run list --branch $(git branch --show-current) --limit 5

# View failed logs
gh run view <RUN_ID> --log-failed
```

**With git + curl:**

```bash
BRANCH=$(git branch --show-current)

# List workflow runs on this branch
curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/$OWNER/$REPO/actions/runs?branch=$BRANCH&per_page=5" \
  | python3 -c "
import sys, json
runs = json.load(sys.stdin)['workflow_runs']
for r in runs:
    print(f\"Run {r['id']}: {r['name']} - {r['conclusion'] or r['status']}\")"

# Get failed job logs (download as zip, extract, read)
RUN_ID=<run_id>
curl -s -L \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/actions/runs/$RUN_ID/logs \
  -o /tmp/ci-logs.zip
cd /tmp && unzip -o ci-logs.zip -d ci-logs && cat ci-logs/*.txt
```

### Step 2: Fix and Push

After identifying the issue, use file tools (`patch`, `write_file`) to fix it:

```bash
git add <fixed_files>
git commit -m "fix: resolve CI failure in <check_name>"
git push
```

### Step 3: Verify

Re-check CI status using the commands from Section 4 above.

### Auto-Fix Loop Pattern

When asked to auto-fix CI, follow this loop:

1. Check CI status → identify failures
2. Read failure logs → understand the error
3. Use `read_file` + `patch`/`write_file` → fix the code
4. `git add . && git commit -m "fix: ..." && git push`
5. Wait for CI → re-check status
6. Repeat if still failing (up to 3 attempts, then ask the user)

### CI pitfall: Go monorepo helper CLIs breaking `go test ./...`

In Go monorepos, a PR may add multiple helper executables under a single directory such as `tools/`, each with its own `package main` and `func main()`. When CI runs `go test ./...`, Go treats one directory as one package, so multiple `main` functions in the same directory fail with errors like:

- `main redeclared in this block`
- `other declaration of main`

Safe fix pattern:

1. Move each executable into its own subdirectory package, for example:
   - `tools/init_db/main.go`
   - `tools/get_db_port/main.go`
2. Update every caller from file-based `go run ./tools/x.go` to package-based `go run ./tools/x`.
3. Search the repo for stale references before committing.
4. Re-run the relevant local compile/test command that does **not** depend on unavailable infrastructure (for example `go test ./tools/...` or `go test -run '^$' ./...`).
5. Push and confirm the rerun CI on GitHub goes green.

This is a good fix when the root cause is package layout, not application logic.

### CI pitfall: frontend E2Eがschema生成前提のworkspace importを解決できない

フロントエンドE2Eがworkspace内の生成済みschema（例: `schema/src/index`）をimportする場合、依存関係のinstallだけでは生成ファイルが存在せず、CIのVite起動時にimport解決エラーになることがある。ローカルで生成物が残っていると見落としやすい。

安全な修正パターン:

1. E2E jobをクリーンcheckout相当の状態で再現する。
2. `npm install`の後、E2E実行前にschema生成コマンド（例: `npm run build -w schema`）を明示的に実行する。
3. 生成後にPlaywrightを実行し、ローカルでも同じ順序で検証する。
4. schema生成が必要なfrontend CIのpath filterにschemaとworkflowを含め、生成漏れを別PRで見逃さないようにする。

### CI pitfall: dependency-bump PRs that accidentally tighten TypeScript frontend config

In JavaScript/TypeScript monorepos, a dependency-update PR may also change frontend `tsconfig.json` settings such as `strict`, `moduleResolution`, `rootDir`, or DOM libs. When CI starts failing with a very large wave of unrelated frontend type errors immediately after the bump, the safest fix is often to separate configuration tightening from package upgrades.

Safe fix pattern:

1. Inspect the diff for frontend `tsconfig.json` alongside the dependency updates.
2. If the PR intent is dependency refresh rather than a strictness migration, revert the newly tightened `tsconfig` options to the pre-bump settings first (for example removing newly added `strict`, restoring `dom.iterable`, or switching `moduleResolution` back to the previous value).
3. Re-run the exact frontend CI commands locally (for example `npm run build:tsc -w packages/frontend`, `npm run build -w packages/frontend`, `npm run lint -w packages/frontend`).
4. Only start touching application source files if errors remain after the config rollback.
5. Push the minimal config-only fix and confirm the rerun GitHub checks go green.

This avoids turning a package-maintenance PR into a risky cross-cutting type-migration.

### CI pitfall: a newly added `workflow_dispatch` file is not dispatchable before merge

GitHub only receives `workflow_dispatch` events for workflow files that exist on the default branch. A new manual bootstrap workflow added only on a PR/head branch therefore cannot be started with `gh workflow run`, even when passing `--ref <head-branch>`.

Safe pre-merge bootstrap pattern:

1. Reuse the path of an existing manual workflow that is already present on the default branch.
2. Add a temporary typed choice input such as `operation: [deploy, bootstrap]` on the PR branch.
3. Put bootstrap and deploy in separate jobs with explicit `github.ref`, input, and least-privilege job-level `permissions` conditions.
4. Dispatch the existing workflow path with `--ref <head-branch>` and select the bootstrap operation; GitHub resolves the workflow definition from that ref.
5. Remove the temporary key-based bootstrap input/job after the new authentication path is verified.

Do not merge an unverified bootstrap workflow merely to make it dispatchable, and do not leave a legacy credential path reusable after migration.

### Verification pitfall: local infra unavailable, remote CI still required

If the root cause is clear and the code fix is complete, but local Docker/service access is blocked by the execution environment, do not stop at "could not verify locally" if you can still safely progress.

Instead:

1. Verify the highest-signal local subset that does not require the missing infra.
2. Push the fix to the PR head branch when permitted.
3. Re-check the GitHub PR checks and wait for the new run.
4. Report both facts clearly: what you verified locally, and that final validation came from real GitHub CI.

This keeps the workflow grounded in real execution without inventing local success.

## 6. Merging

**With gh:**

```bash
# Squash merge + delete branch (cleanest for feature branches)
gh pr merge --squash --delete-branch

# Enable auto-merge (merges when all checks pass)
gh pr merge --auto --squash --delete-branch
```

**With git + curl:**

```bash
PR_NUMBER=<number>

# Merge the PR via API (squash)
curl -s -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUMBER/merge \
  -d "{
    \"merge_method\": \"squash\",
    \"commit_title\": \"feat: add user authentication (#$PR_NUMBER)\"
  }"

# Delete the remote branch after merge
BRANCH=$(git branch --show-current)
git push origin --delete $BRANCH

# Switch back to main locally
git checkout main && git pull origin main
git branch -d $BRANCH
```

Merge methods: `"merge"` (merge commit), `"squash"`, `"rebase"`

### Enable Auto-Merge (curl)

```bash
# Auto-merge requires the repo to have it enabled in settings.
# This uses the GraphQL API since REST doesn't support auto-merge.
PR_NODE_ID=$(curl -s \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUMBER \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['node_id'])")

curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/graphql \
  -d "{\"query\": \"mutation { enablePullRequestAutoMerge(input: {pullRequestId: \\\"$PR_NODE_ID\\\", mergeMethod: SQUASH}) { clientMutationId } }\"}"
```

## 7. Complete Workflow Example

```bash
# 1. Start from clean main
git checkout main && git pull origin main

# 2. Branch
git checkout -b fix/login-redirect-bug

# 3. (Agent makes code changes with file tools)

# 4. Commit
git add src/auth/login.py tests/test_login.py
git commit -m "fix: correct redirect URL after login

Preserves the ?next= parameter instead of always redirecting to /dashboard."

# 5. Push
git push -u origin HEAD

# 6. Create PR (picks gh or curl based on what's available)
# ... (see Section 3)

# 7. Monitor CI (see Section 4)

# 8. Merge when green (see Section 6)
```

## Scheduled PR Maintenance / Conflict-Rebase Automation

When setting up recurring automation for PR maintenance (for example, nightly checks that rebase conflicting PR branches), bake the safety constraints into the cron prompt instead of relying on implicit judgment:

1. Scope PR discovery narrowly: list only open PRs by the intended author (for this user, `author:koh110`). Start with a minimal `gh search prs --json repository,number,title,url,isDraft --limit 100` query because `gh search prs --json` field support varies by CLI version. In particular, some builds reject fields such as `headRepositoryOwner`, `headRefName`, `baseRefName`, `mergeStateStatus`, or `merged` with `Unknown JSON field`. Treat that as a version-compatibility signal, not a fatal error: re-run the search with the minimal field set, then hydrate each candidate with `gh pr view -R <owner/repo> <number> --json headRefName,baseRefName,mergeStateStatus,maintainerCanModify,headRepositoryOwner,...` and only act on PRs whose merge state clearly indicates conflicts (for GitHub, `mergeStateStatus` such as `DIRTY`; follow up on `UNKNOWN` before acting).
2. Confirm `gh auth status` and git availability at the start of each run.
3. Only modify head branches where the authenticated user has push rights. Never push to, rebase, or merge the base branch.
4. If rewriting history, use `git push --force-with-lease` and only to the PR head branch.
5. If a conflict cannot be resolved confidently, or auth/permissions/test setup are unexpected, stop for that PR, leave a concise PR comment, and include the reason in the final cron report.
6. For this user's development tasks, clone repositories under `~/dev`; put working caches and temporary checkouts under `~/dev/tmp` (for example `~/dev/tmp/_hermes_pr_rebase_cache`). For parallel development, create a `.worktree/` directory at the repository root and create isolated working directories inside it with `git worktree` (for example `git worktree add .worktree/<task-branch> -b <task-branch> origin/main`), then do implementation work from that worktree rather than the main checkout.
7. If `gh`/git are configured for SSH and `git clone` fails with `Permission denied (publickey)` despite valid `gh auth status`, fall back to HTTPS using the GitHub token (for example `TOKEN=$(gh auth token)` then `git clone "https://x-access-token:${TOKEN}@github.com/<owner>/<repo>.git" ...`) and set `origin` to the same HTTPS URL for subsequent fetch/push operations.
8. Cron jobs should report: checked PR count, conflict target count, successful PR URLs + verification, skipped/failed PR URLs + reasons, and important error excerpts.

## Useful PR Commands Reference

| Action | gh | git + curl |
|--------|-----|-----------|
| List my PRs | `gh pr list --author @me` | `curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open"` |
| View PR diff | `gh pr diff` | `git diff main...HEAD` (local) or `curl -H "Accept: application/vnd.github.diff" ...` |
| Add comment | `gh pr comment N --body "..."` | `curl -X POST .../issues/N/comments -d '{"body":"..."}'` |
| Request review | `gh pr edit N --add-reviewer user` | `curl -X POST .../pulls/N/requested_reviewers -d '{"reviewers":["user"]}'` |
| Close PR | `gh pr close N` | `curl -X PATCH .../pulls/N -d '{"state":"closed"}'` |
| Check out someone's PR | `gh pr checkout N` | `git fetch origin pull/N/head:pr-N && git checkout pr-N` |
