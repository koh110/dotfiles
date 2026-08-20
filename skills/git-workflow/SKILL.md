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

- sessionが `.worktree/<name>/` 以下から起動されている場合も、repository root ではなく起動中の linked worktree を作業場所として扱う。`git_dir != common_dir` であることを確認できたら、共有 `.git` への書き込みを要する `git worktree add` は実行しない
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
- **harness(Claude Code)が事前に用意した worktree(`.claude/worktrees/<name>/` 等)も、手動・agent作成の worktree と同様に既存の linked worktree として扱う**。「規約に沿っていないのでは」と疑って独自の `.worktree/` を新設しない。harness提供のworktreeか手動作成かで扱いを変える必要はなく、`git_dir != common_dir` である以上は現在の worktree をそのまま再利用する
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
- PRを作成する場合は、先にPRのtarget/base branchを確定する。明示された既存branchを優先し、未指定ならremoteのdefault branchをauthoritative metadataから解決する（通常は`main`、存在しなければ`master`等。名前を推測しない）
- 確定したtarget branchがremoteに存在することを確認し、そのexact refとOIDをfetchしてstart pointにする。作業branchを`main`へ固定したり、targetと異なるbranchから切ったりしない
- `.worktree/` 配下へ専用 worktree を作り、移動してから編集を始める

```bash
set -euo pipefail
git worktree list
git status --short
# PRのtarget/baseが明示されている場合はそれを設定する。
# 未指定の場合だけremote defaultを解決する。
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
printf 'PR target: %s (%s)\n' "$target_branch" "$target_oid"
mkdir -p .worktree
git worktree add .worktree/feature-short-name -b feature/short-name "$target_oid"
cd .worktree/feature-short-name
git rev-parse --show-toplevel
git branch --show-current
```

## Root Checkout Recovery Guidelines

- root checkout での追加編集を止める
- 上記のauthoritative remote HEAD解決手順で正しいbranch/worktreeを作る
- shared stash stackは全worktree/processで共有されるため、無条件の`git stash pop`による移植は禁止する
- tracked変更は権限を制限した一時patchへ書き、target側で`git apply --check`後に適用する
- untracked fileはNUL区切り一覧を確認し、targetに既存pathがないものだけ明示的に移す
- targetで差分を検証するまでroot checkout側の変更を削除しない。移植後もroot側cleanupは別の明示的手順として行う
- root checkoutはfeature完了まで作業場所として使わない

```bash
set -euo pipefail
# 上の手順でtarget_oidを確定済みのroot checkoutから
umask 077
patch_file=$(mktemp)
untracked_file=$(mktemp)
git diff --binary HEAD > "$patch_file"
git ls-files -z --others --exclude-standard > "$untracked_file"
git worktree add .worktree/feature-short-name -b feature/short-name "$target_oid"
git -C .worktree/feature-short-name apply --check "$patch_file"
git -C .worktree/feature-short-name apply "$patch_file"
# untracked_fileをNUL対応toolでレビューし、衝突しないfileだけ個別にcopyする
git -C .worktree/feature-short-name status --short
git status --short  # まだ原本を保持していることを確認
```

一時fileはtargetとrootの検証完了後に削除する。自動移植が必要なら`fail-closed-automation`を適用し、artifact ownershipとconcurrent writerを別途扱う。

## Minimum-Diff and Scope Gate

明示的なPR target/base branchがある場合はそれを起点にし、ない場合だけauthoritative remote metadataからdefault branchを解決する。通常は`main`、存在しなければ`master`等だが、branch名を推測しない。

作業開始前に、以下を確認する。

- 目的、受け入れ条件、変更対象、PR target/base branchを列挙する
- 現在のbranch、worktree、確定したtarget branchとの差分を確認する
- target branchがremoteに存在し、取得したOIDと一致することを確認する
- 各変更が目的達成に必要かを確認する
- 未マージbranch、作業途中worktree、関連機能の実装を暗黙の土台にしない
- 関連機能を含める場合は、import、route、schema、runtime call、再現可能な失敗ログなどの具体的な依存を確認する

実装後は、作業開始時に確定したPR target/base branchとの差分を再確認し、目的外の変更を除去する。依存関係を実証できない関連機能はスコープ外として扱う。

## Portable Change-Target Gate

repositoryやagentをまたいで変更を展開する場合、Hermes/Codex等のagent固有機能や、ロード済みskillの記憶だけでtargetを決めない。リポジトリ非依存の`skills/change-target-gate/scripts/change-target-gate.mjs`を実行し、manifestで宣言したrepository・base・artifact・pathだけを変更対象にする。

```bash
# 既存artifactを先に探索する
node skills/change-target-gate/scripts/change-target-gate.mjs discover --repo . --query "git workflow"

# 作業前後に、repository ownership・patch/create・実際のdiffを検証する
node skills/change-target-gate/scripts/change-target-gate.mjs verify \
  --policy /path/to/change-target-policy.json \
  --manifest /path/to/change-target-manifest.json \
  --base <resolved-pr-target>
```

`--base`には作業開始時に確定したPR target/base branch（例: `origin/main`、`origin/master`、`origin/release/1.x`）を渡す。`main`を固定値として渡したり、targetと異なるbranchを暗黙に使用したりしない。

- `patch`対象がbase refに存在しない場合、`create`対象が既に存在する場合は停止する
- originのrepository、manifestのrepository、target repositoryが一致しない場合は停止する
- manifestにないchanged path、base ref不在、target未宣言を成功扱いにしない
- 複数repositoryへ展開する場合は、repositoryごとにsource of truthとmanifestを解決し、各repositoryで独立してgateを実行する。Hermesを特別扱いして禁止するのではなく、未計画targetだけを拒否する
- `skills/change-target-gate/config/`には公開可能なschema例だけを置き、repository固有のpolicy・manifestはrepository外またはignore対象で管理する。このskillはrepositoryごとのadapterであり、共通の判定ロジックを複製して他agentへ埋め込まない。各repositoryは自分のcanonical repositoryとallowlistを定義する
- gateが失敗した状態で編集、commit、push、issue/PR作成を続行しない

## Commit / Rebase / Push Guidelines

- この skill の記述(description の「commit を完結させる」を含む)は commit / push をどの worktree で行うかの作法を定めるものであり、commit / push 実行の許可を与えるものではない
- 「commit はユーザーの明示的許可がある場合のみ」というシステム / ユーザー指示を、この skill の手順が上書きすることはない。許可が確認できない場合は commit せず、変更内容を報告して停止する
- AskUserQuestion の timeout 自動応答(「No response — proceed using your best judgment」等)を commit / push などの destructive 操作への明示的同意として扱わない
- status を見ずに commit しない
- staged diff を見ずに commit しない
- commit 前に `git diff --cached` で commit 対象を最終確認する
- commitが `error: gpg failed to sign the data` で失敗した場合、署名鍵(1Password等)がロック中で使用できない可能性がある。diffの内容やstage漏れが原因と誤認せず、`git commit --no-gpg-sign` で1回だけ再試行してよい(fail-open)。再試行で成功した場合は無署名commitになった旨を完了報告に明記する。同じ引数の再試行でも失敗する場合は署名以外の原因を疑い、原因を報告して停止する
- branch 名を見ずに push しない
- push / PR 前に公開したい commit SHA を確認する
- PR を独自フォーマットで書き始めない。作成前に対象 repository の `.github/PULL_REQUEST_TEMPLATE.md` と直近の merge 済み PR を確認し、実運用の body 形式(見出し構成等)に合わせる
- push 前に意図しない file が含まれていないか再確認する
- **「この PR の続きを進めて」と指示された場合、その PR と branch をタスク全体の制約として固定する**。作業途中の設計判断で「commit・push してよいか」と尋ねて「ok」を得ても、それは既存 PR へ積む許可であって、**新規 PR を立てる許可ではない**。branch を分ける / PR を分割する場合は、その逸脱自体を明示して個別に確認を取る(実測: 局所的な「ok」を新規 PR 作成の許可と解釈して誤って PR を立て、close と cherry-pick の後始末に約20分を費やした)
- **push 先 repository が公開かどうかを push 前に必ず確認する**。業務コンテキストや社内情報など公開できない内容を含む branch は、push 自体がデータの持ち出しになるため、push せずローカル commit(必要なら deploy)に留める。対象 branch に remote 追跡が無い場合は「まだ push していない」ではなく「push しない運用」の可能性を先に疑い、ユーザーへ確認する
- conflict解消前にも、作業開始時に確定したPR target/base branchを再照会し、exact refをfetchしてOID一致を検証する。そのtarget branchへrebaseする。`main`/`master`へguessしたり、remote default branchへ勝手にrebaseしたりしない
- **検証・実験目的で作成した worktree(review gate や hook の動作確認、再現手順の検証など、成果物を残すこと自体が目的でない作業)での変更は、目的を達成したらデフォルトで commit せず破棄する**。finish-review 等の通常フローに引きずられて commit へ向かわない。成果物として残す必要があると判断した場合は、その旨と target branch を明示してユーザーに確認してから commit する(実測: gate動作検証用の worktree で修正をそのまま commit しようとしたが、AskUserQuestion で「検証用なので commit しなくていい、削除してよい」と訂正された)

## Cleanup Guidelines

- cleanup は root checkout と worktree のどちらに対して行うか明確にしてから実行する
- `.worktree/` 自体を誤って消さない
- `git clean`はquarantine・identity再検証・rollbackがないためcleanup手段として使わない
- root checkout の status に `.worktree/` が出る場合は、repository の local exclude で隠すことを優先する
  - `.gitignore` を変更せずに隠すには root checkout で `echo '.worktree/' >> .git/info/exclude`
- 手動cleanupでもtrackedだけでなくuntracked・ignored fileを個別に検査し、1つでもあれば削除しない
- 手動・自動を問わず破壊的cleanupでは`fail-closed-automation` skillを併用し、そのGit worktree cleanup predicatesをauthoritativeな安全要件として適用する
- 最低限、tracked・untracked・ignoredが空であること、authoritative remote default名/OIDとexact merge evidenceが削除直前にも一致すること、quarantineをraw renameではなく`git worktree move`で行えることを要求する
- worktree登録の削除を確認したら、続けてlocal branchも`git branch -d`(safe deleteのみ)で削除してよいが、これはworktree削除からbranch削除まで同一のexclusive cleanup authority/fencing lease(`fail-closed-automation`要件)を保持したまま連続して行う場合に限る。`git branch -d`は対象branchが他worktreeでcheckout中の場合に拒否する(実測確認済み: `error: cannot delete branch ... used by worktree at ...`)が、このcheckとref削除の間には別プロセスが新規worktreeを登録し得るTOCTOU窓があるため、この拒否挙動単体を安全の根拠にしてauthority/leaseの保持を省略しない。`-D`による強制削除は行わない。remote branchは明示依頼なしに削除しない
- 手動cleanupでも以下のread-only検査だけを根拠に削除してはいけない。検査後に上記のauthoritative remote/OID、merge evidence、`git worktree move` quarantine、削除直前再検証をすべて実施する

```bash
git -C .worktree/feature-short-name status --short
git -C .worktree/feature-short-name ls-files --others --exclude-standard
git -C .worktree/feature-short-name ls-files --others --ignored --exclude-standard
```

`git worktree remove`や`git branch -d`をこのsnapshotだけに続けるshortcutは禁止する。無人・手動を問わず、削除直前に全predicateと別worktreeで未使用であることを再検証してから実行する。

### Post-Merge Cleanup Routine

ユーザーから「マージしたのでcleanupして」等、PRがmergeされた直後のcleanupを明示的に依頼された場合の定型手順。安全要件そのもの(quarantine経由の削除を含む、上記Cleanup Guidelines)は省略せず適用し、以下はその手順に加えて確認すべき点を補う。

1. `gh pr view <number-or-branch> --json state,mergedAt` でmerge済みであることを確認する(mergeされていない、または確認できない場合は中止する)
2. 上記Cleanup Guidelinesの安全要件(tracked/untracked/ignoredが空、authoritative remote default名/OIDとexact merge evidenceの一致)を先に確認する。満たさない場合はここで中止し、以降のteardown・quarantine・削除には進まない
3. 安全要件を満たすことを確認できたら、対象worktreeでdocker compose等のプロセス・コンテナを起動していた場合に限り `docker compose down`(または同等のteardownコマンド)を実行する。この時点ではまだ`git worktree move`でquarantineしていないためCompose定義はまだ存在する。**この順序が重要**: 安全性検証より前にteardownすると、誤って別worktreeやdirtyなworktreeのコンテナ・プロセスを停止してしまう。逆にquarantine・削除の後でteardownしようとすると、対象のCompose定義ごと消えており実行不能になる
4. 上記Cleanup Guidelinesの手順どおり `git worktree move` でquarantineし、quarantine後に安全要件を再検証してから `git worktree remove` する。read-only検査だけを根拠に直接削除しない
5. local branchを削除する(`git branch -d`。safe deleteのみ、`-D`は使わない)。squash/rebase mergeの場合、branchの先端commitがdefault branchの祖先にならず`git branch -d`が「not fully merged」で失敗することがある。この場合`-D`で強制削除せず、branchを保持したまま明示的なfollow-up対象として報告する(手順1で確認したPRのmerge自体は正当なので、削除の失敗はcleanup対象の見落としではない)
6. remote branchは明示依頼がない限り削除しない(GitHubのauto-delete設定に委ねるか、別途確認する)

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
- `.worktree/` 以下で起動した場合、既存の linked worktree を再利用し、共有 `.git` へ書き込む `git worktree add` を試行しないこと
- `git_dir == common_dir` でコード変更を行うなら、root checkout ではなく `.worktree/` 配下の専用 worktree を作成して移動すること
- detached HEAD のまま commit / rebase / push しないこと
- コード変更を伴う作業では、専用 worktree 内にいることと適切な専用 branch にいることを完了前に必ず再確認すること
- commit / push への明示的許可が確認できない場合、この skill を根拠に commit / push を実行しないこと。timeout による自動応答は明示的許可ではない
- commit / push を行う場合、完了報告前に `git diff --cached` と対象 branch / commit SHA を必ず確認すること
- main checkout に feature 変更が残っている場合、その時点で未完了として扱い、cleanup を優先すること
- root checkout で変更を続けていた、または `.worktree/` guideline に違反していた場合、その時点で未完了として扱い、worktree への移植と root の復元を優先すること
