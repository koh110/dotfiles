# Git workflow policy

このpolicyはGit skillの上に適用する個人のworking agreementです。Git mechanicsと安全contractは `skills/git-workflow` を使います。

## Dedicated worktree

source codeだけでなく、後でcommit/review対象になるdocsや設計書の編集も「変更作業」として扱います。

- current directoryが既存linked worktreeなら、そのworktreeを再利用する。
- linked worktree内で別worktreeを入れ子に作らない。
- primary/root checkoutで変更作業を始める場合は、repository rootの `.worktree/<task>` に専用worktreeを作る。
- root checkoutをfeature/fix/refactor/choreの継続作業場所にしない。
- test/lint/build/commitは作業worktree内で行う。
- root checkoutへfeature変更を残したまま完了扱いにしない。

runtime/harnessが独自pathでlinked worktreeを用意した場合はpath namingよりGit metadataを優先し、既存linked worktreeをそのまま使います。

## Branch naming

新規branchは作業内容に合わせて、原則次を使います。

- `feature/<short-name>`
- `fix/<short-name>`
- `chore/<short-name>`

detached HEADのままcommit/rebase/pushしません。

## Existing PR continuity

「このPRの続きを進めて」という依頼では、そのPRとhead branchをtask制約として維持します。別branch/PRへの分割が必要なら、その変更自体をユーザーdecisionとして扱います。

## Commit signing

commitが `error: gpg failed to sign the data` で失敗し、署名keyのlockが原因と判断できる場合は、`git commit --no-gpg-sign` で1回だけ再試行してよいです。成功した場合はunsigned commitであることを報告します。同じ再試行でも失敗する場合は原因を推測して繰り返しません。

## PR and push

- PR作成前にrepositoryのPR templateと直近の運用形式を確認する。
- push前にtarget repositoryがpublic/privateのどちらかを確認し、公開できないcontextをpublic remoteへpushしない。
- push/PR前にbranchと公開予定commit SHAを確認する。

## Cleanup

- `.worktree/` directory自体を一括削除しない。
- root checkoutから `.worktree/` がuntracked表示される場合、repository policyに反しない限りlocal excludeを優先する。
- merged後のcleanupでもtracked/untracked/ignored、remote merge evidence、worktree identityを削除直前に再検証する。
- local branchは `git branch -d` のsafe deleteのみを使い、失敗時に `-D` へ自動昇格しない。
- remote branchは明示依頼なしに削除しない。
