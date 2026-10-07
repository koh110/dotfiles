# GitHub PR Lifecycle Reference

このreferenceは、`git-workflow` に統合されたGitHub PR操作の詳細手順です。repository root / worktree / branch / target base / commit候補の確認は親skillが所有するため、ここでは重複して扱いません。

PR操作はGit操作から独立した作業ではありません。親skillで確定したcandidate、base、head、worktreeを維持したまま、PRの作成・更新・CI確認・merge判断へ進みます。`github-pr-workflow`を別の完全な手順として併用し、branchやcommit手順を二重適用しないでください。

詳細な補助資料:

- [CI troubleshooting](ci-troubleshooting.md)
- [PR create troubleshooting](gh-pr-create-troubleshooting.md)
- [Conventional Commits](conventional-commits.md)

## Prerequisites

- 親skillのrepository/worktree/branch preflightが完了している
- 対象を`owner/repo#number`またはfull PR URLで固定している。新規PRの場合もowner/repo、base、head branchを明示する
- `gh auth status`が成功している、または承認済みのGitHub API credential pathを使える。tokenを平文ファイルから推測・表示・ログ出力しない
- base branchがGitHub上に存在し、作業開始時に確認したbase ref/OIDと整合している
- PRを作成・更新・comment・mergeする外部mutationは、依頼された操作だけを実行する。PR作成やCI PASSからmerge承認を推測しない

## Target and state rules

- 複数repository、worktree、PRが存在する場合、mutation直前に対象を再読込する
- pushしたbranch、remote branch、PR `headRefOid`は別々にread-backし、同じOIDであることを確認する
- `OPEN`でないPRへpushしても、既存PRが再open・再targetされるとは限らない。`CLOSED`/`MERGED`のPRは状態を確認してから新規PRが必要か判断する
- PR baseが進み、候補の変更範囲に影響する場合は、親skillのbase/OID検証、rebaseまたはmerge、全local gate、fresh review、再pushをやり直す
- `mergeable`、`mergeStateStatus`、CI、review、deployは別の状態として報告する。`pending`、`skipping`、`no checks reported`をPASSへ読み替えない

## 1. Creating or Updating a PR

### PR-facing language

- Follow the user-requested language and the repository convention for PR-facing text.
- When rewriting an existing PR body, keep the selected language consistent throughout the new body.
- Commit messages still follow the repository convention; do not change their language merely to match the PR body.

### PR body reset rule

When the user asks to "adjust the PR body" or "start over from the beginning," do **not** try to incrementally patch the old body in place.

Instead:
1. Read the current PR body only as context.
2. Rewrite the entire body from scratch with a clean structure.
3. Use a temporary file plus `--body-file` when editing with `gh pr edit` to avoid shell-quoting problems from backticks, Markdown, and code fences.
4. Re-fetch the PR body afterward to confirm the update landed exactly as intended.
5. If a PR body is likely to contain code, backticks, or long Markdown sections, default to the file-based path even when inline editing would fit.

See [`pr-body-reset.md`](pr-body-reset.md) for the reusable command pattern.

This avoids drift, stale wording, and accidental shell parsing errors.

### Base branch existence check

Before creating or retargeting a PR, verify that the intended base branch currently exists on GitHub, not only as a stale local `origin/<branch>` remote-tracking ref. Use `git ls-remote --heads origin <branch>` and/or `gh api repos/<owner>/<repo>/branches/<branch>`. If GitHub reports the base branch is missing, do not create a replacement branch or retarget the PR without explicit user direction; report that the dependency branch was deleted and that the dependent changes must wait for the dependency to reach an existing base branch.

### Base divergence and mergeability gate

Before creating or updating a PR, compare the candidate head with the current remote base. If the branches have diverged, check the GitHub PR mergeability instead of assuming the old branch point is still clean. When base changes touch the candidate's files, merge or rebase the current `origin/<base>` into the PR head, resolve conflicts while preserving both the base feature and the requested change, rerun the full local gates, push the updated head, and re-read `mergeable`, `mergeStateStatus`, `headRefOid`, and checks. Do not report a PR as ready while it remains `DIRTY`/`CONFLICTING`; do not claim the updated PR head was live-deployed unless that exact SHA was deployed.

### Repo targeting rule

When `gh` appears to be pointing at the wrong repository context, do not assume the current checkout is enough.

- Verify the intended repo with `gh repo view <owner>/<repo>` or by checking the remote explicitly. (`gh repo view` takes the repository as a positional argument; it does not support `-R`.)
- Pass `--repo <owner>/<repo>` (or `-R <owner>/<repo>` where that specific `gh` subcommand supports it) to `gh pr create`, `gh pr edit`, `gh pr view`, and similar commands when the repo context is ambiguous or a sibling repo/default branch is involved.
- Treat "No commits between <base> and <branch>" or a surprising default repo name as a signal to re-run the command with an explicit repo target.
- For broader repository operations such as cloning, remote setup, branch/worktree management, or moving between checkouts, prefer `github-repo-management`.

### Multi-PR / multi-repo safety harness

When the session contains more than one active PR or more than one repository, the default failure mode is to act on the wrong target. Make the target explicit before every mutation.

- Before creating, editing, merging, or commenting on a PR, restate the exact target as `owner/repo#number` or the full PR URL in your own working notes.
- Re-read the target with `gh pr view -R <owner/repo> <number>` immediately before mutation.
- After mutation, re-fetch the same PR and confirm the URL, repo, branch, and body match the intended target.
- Never reuse a PR number from another repository without an explicit `-R` flag.
- If the user says "fix the dotfiles PR" or names a repository, treat that repository as the only valid target until the task is complete.
- If you have both a feature repo and a backup repo open in the same session, note the active target repo in the very first line of your working notes before any `gh` write operation.
- Reusable command pattern and review checklist: [`pr-targeting-harness.md`](pr-targeting-harness.md)

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

For PR title and body, follow the user-requested language and the repository convention. Apply the same rule when creating a PR or rewriting its body.

If `gh pr create` reports missing head/base SHAs or says there are no commits, or if gh seems to resolve the wrong repository, specify the repository and head branch explicitly. See the troubleshooting section below.

### PR-facing language

For PR-facing text, follow the user-requested language and the repository convention.

- Write the PR title and body in the selected language.
- Keep commit messages in the project's existing convention unless the user asks to change that too.
- When editing an existing PR body, preserve the selected language unless the target PR intentionally uses another language.

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
BASE_BRANCH=<resolved-base-branch>

curl -s -X POST \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/$OWNER/$REPO/pulls \
  -d "{
    \"title\": \"feat: add JWT-based user authentication\",
    \"body\": \"## Summary\nAdds login and register API endpoints.\n\nCloses #42\",
    \"head\": \"$BRANCH\",
    \"base\": \"$BASE_BRANCH\"
  }"
```

The response JSON includes the PR `number` — save it for later commands.

To create as a draft, add `"draft": true` to the JSON body.

## 2. Monitoring CI Status

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

## 3. Diagnosing and Fixing CI Failures

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

Re-check CI status using the commands from Section 2 above.

### Auto-Fix Loop Pattern

When asked to auto-fix CI, follow this loop:

1. Check CI status → identify failures
2. Read failure logs → understand the error
3. Use `read_file` + `patch`/`write_file` → fix the code
4. `git add . && git commit -m "fix: ..." && git push`
5. Wait for CI → re-check status
6. Repeat if still failing (up to 3 attempts, then ask the user)

### CI pitfall: rebasing onto a newer workspace can activate a base-branch lint failure

When a rebase brings a newly added workspace or base-branch path into a PR's shared lint override, a previously green PR can fail on pre-existing code that is outside the PR's original diff. Confirm the failure on the rebased head, inspect which config change activated the path, and prefer the smallest contract-preserving fix: scope the rule to packages that implement the relevant convention, or add the missing implementation only when the repository's architecture requires it. Do not silently weaken the rule for all packages or claim the old CI result still covers the rebased head. Run the affected workspace's exact CI commands locally, then push and verify the new remote checks.

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
4. Re-run the relevant local compile/test command that does **not** depend on unavailable infrastructure (for example `go test ./tools/...` or `go vet ./...`). Use `go test -run '^$' ./...` as a compile check only after confirming that package `TestMain` functions do not require the unavailable infrastructure; `-run` does not skip `TestMain`.
5. Push and confirm the rerun CI on GitHub goes green.

This is a good fix when the root cause is package layout, not application logic.

### CI pitfall: Go `@latest` tools can outrun the build image

A Docker build command such as `go run golang.org/x/tools/cmd/goimports@latest` resolves the newest tool module, which may require a newer Go version than the image provides. Reproduce the build with the image's exact Go version, inspect the failure's `requires go >=` message, and either pin a compatible tool version or update the image as a separately scoped change. Do not treat a local toolchain mismatch as a PR-specific application failure.

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

### Verification pitfall: local generation can dirty tracked artifacts

CI commands that generate registries, sitemaps, manifests, or verification metadata may leave tracked files changed even when tests pass. Before committing or pushing, inspect `git status --short` and `git diff`; distinguish intended PR changes from test-generated output, restore only known generated files that are not part of the PR, and require a clean worktree. Never push unreviewed generator output.

### CI pitfall: `gh run list --branch` が空でも check run が存在する

PRの `statusCheckRollup` や `gh pr checks` にcheckが表示されるのに `gh run list --branch <head>` が空の場合、CI未実行とは判定しない。CLIのbranch/event filterとPR checkの表示対象が一致しないことがある。

1. `gh pr checks` のdetails URL、または `statusCheckRollup` のdetails URL / REST check-runから対象run IDを確定する。
2. `gh run view <RUN_ID> --log-failed` と `gh api repos/<owner>/<repo>/actions/runs/<RUN_ID>/jobs` で実行状態・job・step開始有無を確認する。
3. push後のPR `headRefOid` が一時的に旧SHAや `UNKNOWN` を返す場合があるため、remote ref SHAとPR head SHAが一致し、mergeabilityを再計算できるまでread-backする。

### CI pitfall: self-hosted runner待ちでstep未開始のcancelled run

dynamicなself-hosted runnerのlabelを `runs-on` に使うworkflowで、jobが長時間 `queued` のまま、または `steps: []`・`runner_name: ""` のままcancelledになった場合、source failureのログが存在しないrunner provisioning/availability問題として扱う。失敗stepがない状態でアプリケーションコードを推測修正しない。

1. exact head SHAを確認してから、対象runを一度だけ安全にrerunする。
2. rerun後もrunnerが割り当てられずpendingなら、job label、runner APIの利用可能数、`gh run view` の状態を記録する。
3. code fix成功とは報告せず、CIは再実行待ち／外部runner障害として報告する。

### Verification pitfall: local infra unavailable, remote CI still required

If the root cause is clear and the code fix is complete, but local Docker/service access is blocked by the execution environment, do not stop at "could not verify locally" if you can still safely progress.

Instead:

1. Verify the highest-signal local subset that does not require the missing infra.
2. Push the fix to the PR head branch when permitted.
3. Re-check the GitHub PR checks and wait for the new run.
4. Report both facts clearly: what you verified locally, and that final validation came from real GitHub CI.

This keeps the workflow grounded in real execution without inventing local success.

## 4. Merging

**Explicit approval gate:** Creating a PR, passing review, or being asked to release/deploy does not authorize merging. Do not run any merge command unless the user explicitly approves merging the named PR (for example, “PR #30をmergeして”). If the user asks only to release/deploy, keep the PR state unchanged and use the repository's approved post-merge release path only after an explicit merge approval or an already-merged commit is confirmed. After any merge mutation, re-read the PR state and report the exact merge commit.

**With gh (only after explicit approval for the named PR):**

```bash
# Re-read the exact target immediately before mutation.
gh pr view -R <owner/repo> <number> --json url,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus

# Use the approved merge method; do not infer approval from review or CI.
gh pr merge -R <owner/repo> <number> --squash
```

`--auto` is also a merge mutation and requires the same explicit approval. Remote branch deletion and local worktree cleanup are separate operations; follow the parent skill's cleanup predicates rather than chaining them blindly.

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

# Remote branch deletion and local cleanup are separate, explicit operations.
# Do not infer permission to delete either branch from the merge response.
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

## 5. Scheduled PR Maintenance / Conflict-Rebase Automation

When setting up recurring automation for PR maintenance (for example, nightly checks that rebase conflicting PR branches), bake the safety constraints into the cron prompt instead of relying on implicit judgment:

1. Scope PR discovery narrowly: list only open PRs by the intended author (for the authenticated user). Treat any pre-run summary, cached target list, or prior-run count as advisory only; re-run the live search in the current run and hydrate every result before acting or reporting totals. Start with a minimal `gh search prs --json repository,number,title,url,isDraft --limit 100` query because `gh search prs --json` field support varies by CLI version. In particular, some builds reject fields such as `headRepositoryOwner`, `headRefName`, `baseRefName`, `mergeStateStatus`, or `merged` with `Unknown JSON field`. Treat that as a version-compatibility signal, not a fatal error: re-run the search with the minimal field set, then hydrate each candidate with `gh pr view -R <owner/repo> <number> --json headRefName,baseRefName,mergeStateStatus,maintainerCanModify,headRepositoryOwner,...` and only act on PRs whose merge state clearly indicates conflicts (for GitHub, `mergeStateStatus` such as `DIRTY`; follow up on `UNKNOWN` before acting). If `gh pr view` fails with a transient GraphQL/API 503, do not classify the PR as failed yet: hydrate it through REST with `gh api repos/<owner>/<repo>/pulls/<number>` and inspect `mergeable`, `mergeable_state`, `head.sha`, and `base.ref`; use the corresponding REST commit `check-runs` and `status` endpoints for CI classification.
2. Confirm `gh auth status` and git availability at the start of each run.
3. Only modify head branches where the authenticated user has push rights. Never push to, rebase, or merge the base branch.
4. If rewriting history, use `git push --force-with-lease` and only to the PR head branch.
5. If a conflict cannot be resolved confidently, or auth/permissions/test setup are unexpected, stop for that PR, leave a concise PR comment, and include the reason in the final cron report.
6. Keep temporary checkouts, logs, downloads, and generated intermediates under a temporary directory. Put only artifacts intended for later human resumption in the repository's designated artifact directory. For parallel development, use the parent skill's `.worktree/` procedure and do not work in the root checkout.
7. If `gh`/git are configured for SSH and cloning fails with `Permission denied (publickey)` despite valid `gh auth status`, use an approved HTTPS credential helper or the repository's documented transport fallback. Do not embed tokens in remote URLs, shell history, logs, or committed files; keep the configured `origin` unchanged unless explicitly requested.
8. Cron jobs should report: checked PR count, conflict target count, successful PR URLs + verification, skipped/failed PR URLs + reasons, and important error excerpts.

## 6. Useful PR Commands Reference

| Action | gh | git + curl |
|--------|-----|-----------|
| List my PRs | `gh pr list --author @me` | `curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$OWNER/$REPO/pulls?state=open"` |
| View PR diff | `gh pr diff` | `git diff <resolved-base-ref>...HEAD` (local) or `curl -H "Accept: application/vnd.github.diff" ...` |
| Add comment | `gh pr comment N --body "..."` | `curl -X POST .../issues/N/comments -d '{"body":"..."}'` |
| Request review | `gh pr edit N --add-reviewer user` | `curl -X POST .../pulls/N/requested_reviewers -d '{"reviewers":["user"]}'` |
| Close PR | `gh pr close N` | `curl -X PATCH .../pulls/N -d '{"state":"closed"}'` |
| Check out someone's PR | `gh pr checkout N` | `git fetch origin pull/N/head:pr-N && git worktree add .worktree/pr-N pr-N` |
