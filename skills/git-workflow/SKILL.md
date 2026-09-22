---
name: git-workflow
description: 'Git repositoryでcontext確認、branch/worktree、commit/rebase/push、conflict、cleanupを安全に行うときに使う。'
---

# Git Workflow

このskillはGit操作そのもののportableな安全contractを定義します。

次はこのskillの責務ではありません。

- root checkoutを作業場所にしてよいか
- worktreeを必須にするか、どのdirectoryへ置くか
- branch naming convention
- commit署名失敗時にunsigned commitを許可するか
- 既存PRを別branchへ分割してよいか

それらはrepository/user policyまたはruntime adapterで決めます。

## Inspect context

Git操作の前に、少なくとも次を確認します。

```bash
repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
git branch --show-current
git status --short
git worktree list
```

- `git_dir != common_dir`: linked worktree内にいる。
- `git_dir == common_dir`: primary/root checkoutにいる。
- worktreeのpathや作成元（human、IDE、agent harness）から状態を推測せず、Git metadataをauthoritativeにする。
- 判定と `git worktree list` が矛盾する場合はwrite operationを止め、path/Git stateを再確認する。

## Resolve the target base

branch/worktreeを新規作成する場合、PR target/baseが明示されていればそれを使います。未指定の場合だけremote defaultをauthoritative metadataから解決します。

```bash
set -euo pipefail
target_branch="${PR_TARGET_BRANCH:-}"
if test -z "$target_branch"; then
  remote_meta=$(git ls-remote --symref origin HEAD)
  target_full_ref=$(printf '%s\n' "$remote_meta" | awk '$1 == "ref:" && $3 == "HEAD" { print $2 }')
else
  target_full_ref="refs/heads/$target_branch"
fi
case "$target_full_ref" in refs/heads/*) ;; *) exit 1 ;; esac
target_branch=${target_full_ref#refs/heads/}
target_oid=$(git ls-remote origin "$target_full_ref" | awk 'NR == 1 { print $1 }')
test -n "$target_oid"
git fetch --no-tags origin "$target_full_ref"
test "$(git rev-parse FETCH_HEAD)" = "$target_oid"
```

`main` / `master` をguessしてbaseにしません。

## Linked worktree semantics

linked worktreeはpathやruntimeに関係なく同じGit semanticsとして扱います。

- current worktreeを使う場合はpath、branch、statusを確認する。
- detached HEADでcommitが必要なら、commit前に明示的なbranchを作る。
- linked worktree内から別worktreeを作る必要がある場合、shared common Git dirへ変更が入ることを理解した上で行う。policyが現在のworktree再利用を要求する場合はそちらに従う。
- `git worktree add` の作成先pathはpolicy/runtimeが決める。skillでは固定directory名を要求しない。

新規worktreeを作るportableな形:

```bash
set -euo pipefail
test -n "$target_oid"
test -n "$worktree_path"
test -n "$new_branch"
git worktree add "$worktree_path" -b "$new_branch" "$target_oid"
git -C "$worktree_path" status --short
git -C "$worktree_path" branch --show-current
```

## Detached HEAD

変更前またはcommit前にbranchが必要なら:

```bash
git switch -c <branch-name>
git branch --show-current
git status --short
```

既存変更がある場合、branch作成後にstatus/diffが保持されていることを確認します。

## Recover edits from the wrong checkout

shared stash stackは複数worktree/processで共有されるため、移植元を特定せず `git stash pop` しません。

tracked変更は一時patchへ保存し、targetでcheckしてからapplyします。

```bash
set -euo pipefail
umask 077
patch_file=$(mktemp)
untracked_file=$(mktemp)
git diff --binary HEAD > "$patch_file"
git ls-files -z --others --exclude-standard > "$untracked_file"

git -C "$worktree_path" apply --check "$patch_file"
git -C "$worktree_path" apply "$patch_file"
git -C "$worktree_path" status --short
git status --short
```

- untracked filesはNUL-safeに列挙し、targetに同名pathがないことを確認して個別に移す。
- target側のdiffを確認するまでsource側の変更を削除しない。
- cleanupは移植成功の確認後に別stepとして行う。

## Commit

commit前に:

```bash
git status --short
git diff
git diff --cached
git branch --show-current
```

- staged diffを見ずにcommitしない。
- detached HEADのままcommitしない。
- commit messageが決まっているautomationではeditorを起動しない。

commit signingのfallback可否はpolicyで決めます。このskillは署名failureを自動的にunsigned commitへ変換しません。

## Rebase / merge conflict

conflict時はzero-guessingを優先します。

1. `git status --short` とconflicted pathsを取得する。
2. conflict marker、rename/delete、generated artifact等で意味判断が必要なら自動解決を続けない。
3. 機械的に解決できる場合でも `git diff --check`、conflict marker検索、statusを確認する。
4. `rebase --skip` をfailure recoveryのdefaultにしない。
5. `rebase --continue` / merge continuationで別errorが出た場合、分類せずskipせず状態を保存して停止する。

## History rewrite and push

既存remote branchのhistoryを書き換える前にremote OIDとrollback refを記録します。

```bash
set -euo pipefail
branch=$(git branch --show-current)
test -n "$branch"
recorded_oid=$(git ls-remote origin "refs/heads/$branch" | awk 'NR == 1 { print $1 }')
test -n "$recorded_oid"
backup_ref="refs/backup/${branch//\//-}-$(date +%s)"
git update-ref "$backup_ref" HEAD
printf 'branch=%s\nremote_oid=%s\nbackup_ref=%s\n' "$branch" "$recorded_oid" "$backup_ref"
```

- protected/default branchへforce pushしない。
- history rewriteが明示的に許可された場合も `--force` ではなくexact OIDを使った `--force-with-lease` を使う。
- lease rejectionをblind retryしない。

push後はremote refを再取得してexpected HEADと一致することを確認します。

```bash
expected_oid=$(git rev-parse HEAD)
git push origin "$branch" --force-with-lease="refs/heads/$branch:$recorded_oid"
git fetch --no-tags origin "refs/heads/$branch"
actual_oid=$(git rev-parse FETCH_HEAD)
test "$actual_oid" = "$expected_oid"
```

通常のfast-forward pushではforce optionを付けません。

## Cleanup

destructive cleanupでは、read-only snapshotだけを根拠に即削除しません。

最低限確認するもの:

- tracked changes
- untracked files
- ignored files
- worktree registration
- current branch / HEAD
- remote target/ref
- merge evidence
- 別worktreeが同branchを使用していないこと

`git clean` や `git branch -D` をdefault cleanupにしません。

worktreeを削除する場合は、可能なら一度 `git worktree move` でquarantineし、移動後にもstatusとidentityを再確認してからremoveします。local branch削除はsafe delete (`git branch -d`) を使い、失敗したらforceへ自動昇格しません。

remote branch削除は明示されたworkflowでのみ行います。

## Completion evidence

操作の種類に応じて、完了前に次を再確認します。

- repository/worktree identity
- current branch
- working tree / staged diff
- commit SHA
- push後のremote OID
- cleanup後のworktree registration

commandが成功したというexit codeだけで、別ref・別worktreeへ意図した変更が反映されたと推測しません。
