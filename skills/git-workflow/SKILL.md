---
name: git-workflow
description: 'TRIGGER when: git repository で状態確認、branch 作成、差分確認、commit、rebase、push、worktree 作成、cleanup などの git 操作全般を行うとき。特にコード変更を伴う作業では repository root checkout を作業場所にせず、repository root 配下の `.worktree/` に専用 worktree を作って編集・test・lint・build・commit を完結させる。'
---

## General Guidelines

- 最初に `git rev-parse --show-toplevel`, `git branch --show-current`, `git status --short`, `git worktree list` を確認する
- repository root checkout を feature / fix / refactor / chore の継続的な作業場所として利用しない
- コード変更を伴う作業は、編集を始める前に専用 branch と専用 worktree を作成してから行う
- `git status`, `git diff`, branch 名を確認せずに commit / rebase / push / cleanup を行わない
- destructive な git 操作は、対象 path と復元手段を確認してから実行する
- main checkout に feature 変更を残したまま完了扱いにしない

## Branch Guidelines

- branch 名は作業内容と一致させる
  - `feature/<short-name>`
  - `fix/<short-name>`
  - `chore/<short-name>`
- branch を切る前に現在 branch と working tree の状態を確認する
- dirty な root checkout を、そのまま正規の作業場所だとみなさない

## Worktree Guidelines

- repository root に `.worktree/` ディレクトリを配置する
- コード変更作業は、その都度 `.worktree/` 配下に専用 worktree を作る
- worktree 名と branch 名は作業内容に揃える
  - 例: `.worktree/feature-api-cache` = `feature/api-cache`
  - 例: `.worktree/fix-login-timeout` = `fix/login-timeout`
- test / lint / build / commit は作業中の worktree 内で実行する
- root checkout の `git status` に `.worktree/` が出る場合は、放置せず local exclude などで隠す
- 誤って root checkout で変更を始めた場合も、そのまま続けず worktree へ移植して root checkout を戻す

## Worktree Creation Guidelines

- コード変更を伴う作業では、`git worktree list` と `git status --short` を確認してから worktree を作る
- repository root に `.worktree/` がなければ作る
- `.worktree/` 配下へ専用 worktree を作る
- 新しい worktree に移動してから編集を始める

```bash
git worktree list
git status --short
mkdir -p .worktree
git worktree add .worktree/feature-short-name -b feature/short-name
cd .worktree/feature-short-name
```

## Root Checkout Recovery Guidelines

- root checkout での追加編集を止める
- 正しい branch / worktree を作る
- 変更を新しい worktree に移す
- root checkout 側の重複変更を除去する
- root checkout は feature 完了まで作業場所として使わない

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

## Common Pitfalls

- dirty な root checkout を安全な作業場所だと誤認する
- `.worktree/` が存在するだけで、既に専用 worktree 内にいると思い込む
- `.worktree/` を optional な慣習扱いして root checkout で feature 作業を続ける
- tracked file だけ戻して untracked file を置き去りにする
- `git diff --cached` を見ずに commit する
- branch 名や commit SHA を確認せず push / PR を作成する
- cleanup 系コマンドを対象確認なしで実行する
- feature 作業後も main checkout に変更を残す

## Mandatory Skill Enforcement

- この skill が load されたら、git 操作を始める前に現在の repository root / branch / worktree / working tree 状態を必ず確認すること
- コード変更を伴う作業では、root checkout ではなく `.worktree/` 配下の専用 worktree を使っているかを完了前に必ず再確認すること
- commit / push を行う場合、完了報告前に `git diff --cached` と対象 branch / commit SHA を必ず確認すること
- main checkout に feature 変更が残っている場合、その時点で未完了として扱い、cleanup を優先すること
- root checkout で変更を続けていた、または `.worktree/` guideline に違反していた場合、その時点で未完了として扱い、worktree への移植と root の復元を優先すること
