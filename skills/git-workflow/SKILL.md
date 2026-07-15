---
name: git-workflow
description: 'TRIGGER when: git repository で状態確認、branch 作成、差分確認、commit、rebase、push、worktree 作成、cleanup などの git 操作全般を行うとき。コード変更では既存の linked worktree を再利用し、root checkout にいる場合だけ repository root 配下の `.worktree/` に専用 worktree を作成して、編集・test・lint・build・commit を完結させる。'
---

## General Guidelines

- 最初に repository root、Git dir、common Git dir、branch、working tree、worktree 一覧を確認する
- repository root checkout を feature / fix / refactor / chore の継続的な作業場所として利用しない
- コード変更を伴う作業では、現在地が linked worktree ならその worktree を再利用し、root checkout なら専用 worktree を作成する
- linked worktree 内で新しい worktree を入れ子に作成しない
- `git status`, `git diff`, branch 名を確認せずに commit / rebase / push / cleanup を行わない
- destructive な git 操作は、対象 path と復元手段を確認してから実行する
- main checkout に feature 変更を残したまま完了扱いにしない

## Worktree Context Detection

Git 操作や編集を始める前に、以下を実行する。

```bash
repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
git branch --show-current
git status --short
git worktree list
```

- `git_dir != common_dir`: linked worktree 内にいる。agent、IDE、automation、または手動の Git 操作で作成された worktree を含む。作成元にかかわらず現在の worktree を専用作業場所として再利用し、新しい worktree を作成しない
- `git_dir == common_dir`: root checkout にいる。コード変更なら `.worktree/` 配下に専用 worktree を作成して移動する
- 判定結果と実際の `git worktree list` が矛盾する場合は編集を始めず、path 解決と Git 状態を再確認する

## Branch Guidelines

- branch 名は作業内容と一致させる
  - `feature/<short-name>`
  - `fix/<short-name>`
  - `chore/<short-name>`
- branch を切る前に現在 branch と working tree の状態を確認する
- dirty な root checkout を、そのまま正規の作業場所だとみなさない
- linked worktree が detached HEAD の場合、変更前に専用 branch を作ることを原則とする
- 利用中の agent やツールが detached HEAD のまま編集を開始する場合も、最初の commit より前に専用 branch を作る
- detached HEAD のまま commit / rebase / push を行わない

## Worktree Guidelines

- linked worktree 内にいる場合は、現在の worktree をそのタスクの専用作業場所として使う
- root checkout にいる場合だけ、repository root に `.worktree/` ディレクトリを配置し、その配下に専用 worktree を作る
- worktree 名と branch 名は作業内容に揃える
  - 例: `.worktree/feature-api-cache` = `feature/api-cache`
  - 例: `.worktree/fix-login-timeout` = `fix/login-timeout`
- test / lint / build / commit は作業中の worktree 内で実行する
- root checkout の `git status` に `.worktree/` が出る場合は、放置せず local exclude などで隠す
- 誤って root checkout で変更を始めた場合も、そのまま続けず worktree へ移植して root checkout を戻す

## Existing Linked Worktree Guidelines

- `git_dir != common_dir` なら `git worktree add` を実行しない
- 現在の worktree の path、branch、status を確認し、そのタスク専用として安全に利用できることを確認する
- 既に適切な専用 branch にいる場合は、その branch と worktree をそのまま使う
- detached HEAD で未変更なら、原則として編集前に専用 branch を作る
- detached HEAD で既に変更がある場合は変更を保持したまま専用 branch を作り、status と diff が維持されていることを確認する

```bash
git switch -c feature/short-name
git branch --show-current
git status --short
```

## Worktree Creation Guidelines

- この手順は `git_dir == common_dir` の root checkout にいる場合だけ実行する
- コード変更を伴う作業では、`git worktree list` と `git status --short` を確認してから worktree を作る
- repository root に `.worktree/` がなければ作る
- worktreeはremoteの最新 `main` ブランチから開始する
- `.worktree/` 配下へ専用 worktree を作る
- 新しい worktree に移動してから編集を始める

```bash
git worktree list
git status --short
mkdir -p .worktree
git worktree add .worktree/feature-short-name -b feature/short-name
cd .worktree/feature-short-name
git rev-parse --show-toplevel
git branch --show-current
```

## Root Checkout Recovery Guidelines

- root checkout での追加編集を止める
- 正しい branch / worktree を作る
- 変更を新しい worktree に移す
- root checkout 側の重複変更を除去する
- root checkout は feature 完了まで作業場所として使わない

移植手順（stash は worktree 間で共有されるためこの順で安全に移せる）:

```bash
# root checkout で（untracked も含めて退避）
git stash push --include-untracked -m 'move to worktree'
git worktree add .worktree/feature-short-name -b feature/short-name
cd .worktree/feature-short-name
git stash pop
# pop が成功したことと root checkout が clean になったことを両方確認する
git status --short
git -C ../.. status --short
```

## Commit / Rebase / Push Guidelines

- status を見ずに commit しない
- staged diff を見ずに commit しない
- commit 前に `git diff --cached` で commit 対象を最終確認する
- branch 名を見ずに push しない
- push / PR 前に公開したい commit SHA を確認する
- push 前に意図しない file が含まれていないか再確認する
- conflict の解消は `git pull --rebase origin main` を利用し、`git rebase --continue` を繰り返し conflict が全て解消するまで行う

## Cleanup Guidelines

- cleanup は root checkout と worktree のどちらに対して行うか明確にしてから実行する
- `.worktree/` 自体を誤って消さない
- `git clean` は対象に untracked で残したい file がないか確認してから実行する
- root checkout の status に `.worktree/` が出る場合は、repository の local exclude で隠すことを優先する
  - `.gitignore` を変更せずに隠すには root checkout で `echo '.worktree/' >> .git/info/exclude`
- merge 済みの worktree を片付ける場合は、worktree 内に未 commit / 未 push の変更がないことを確認してから以下を実行する

```bash
git -C .worktree/feature-short-name status --short   # 空であることを確認
git worktree remove .worktree/feature-short-name
git branch -d feature/short-name                     # 未mergeなら失敗する(-D で強制しない)
```

## Common Pitfalls

- dirty な root checkout を安全な作業場所だと誤認する
- `.worktree/` が存在するだけで、既に専用 worktree 内にいると思い込む
- linked worktree 内でさらに `.worktree/` を作り、worktree を入れ子にする
- agent やツールが作成した linked worktree の detached HEAD を見落としたまま commit する
- root checkout にいるのに `.worktree/` を optional な慣習扱いして feature 作業を続ける
- tracked file だけ戻して untracked file を置き去りにする
- `git diff --cached` を見ずに commit する
- branch 名や commit SHA を確認せず push / PR を作成する
- cleanup 系コマンドを対象確認なしで実行する
- feature 作業後も main checkout に変更を残す

## Mandatory Skill Enforcement

- この skill が load されたら、git 操作を始める前に repository root / Git dir / common Git dir / branch / worktree / working tree 状態を必ず確認すること
- `git_dir != common_dir` なら現在の linked worktree を再利用し、新しい worktree を作成しないこと
- `git_dir == common_dir` でコード変更を行うなら、root checkout ではなく `.worktree/` 配下の専用 worktree を作成して移動すること
- detached HEAD のまま commit / rebase / push しないこと
- コード変更を伴う作業では、専用 worktree 内にいることと適切な専用 branch にいることを完了前に必ず再確認すること
- commit / push を行う場合、完了報告前に `git diff --cached` と対象 branch / commit SHA を必ず確認すること
- main checkout に feature 変更が残っている場合、その時点で未完了として扱い、cleanup を優先すること
- root checkout で変更を続けていた、または `.worktree/` guideline に違反していた場合、その時点で未完了として扱い、worktree への移植と root の復元を優先すること
