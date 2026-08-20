---
name: wait-for-ci
description: 'TRIGGER when: 開発作業で PR ブランチへ push した直後に CI (GitHub Actions) の結果を見届けるとき（自動トリガーしてよい）、またはユーザーが「CIを待つ」「CI結果を確認」と指示したとき。push 後の CI 成否確認を定型化する。コードの編集中や commit 単体（push 前）では発火させず、push 後の CI 確認フェーズでのみ使う。gh pr checks を polling し、全チェック完了まで待機して pass/fail を報告、失敗時はログを抽出する。'
---

## 目的

push 後の CI チェックが出揃うまで待ち、結果（pass / fail）を報告する。手動で
`gh pr checks` を繰り返し叩く作業を定型化する。

## 手順

1. **対象ブランチの確認**
   - `git branch --show-current` で現在のブランチを取得する
   - PR が存在することを前提とする（なければ作成を促す）
   - **取得したbranch名は、以降のコマンドへ使う前に安全な文字集合のみで構成されているか
     検証する**: 英数字・`/`・`-`・`_`・`.` 以外の文字（`$`、`` ` ``、`(`、`)`、`;`、`|`、
     `&`、空白等）を含む場合は、以降のコマンドへ展開せずに処理を中断してユーザーへ報告する。
     **ダブルクオートで囲むだけでは不十分**: シェルのダブルクオート内でも `$(...)` や
     バッククオートによるcommand substitutionは抑止されない。gitのref名規則は`$`や`(`
     `)`を許容するため、`ci$(touch pwned)` のようなbranch名を無検証でコマンド文字列へ
     展開すると、たとえダブルクオートで囲んでいても任意コマンドが実行される。以下の
     コマンド例の `<branch>` は、この検証を通過した値だけを充てる
   - **push直後は必ずlocal HEADとPRのremote head(server側で記録されているcommit)が
     一致していることを確認する**: `git rev-parse HEAD` と
     `gh pr view "<branch>" --json headRefOid -q .headRefOid` を比較する。
     一致しない場合、`gh pr checks` はローカルより古いcommitのCI結果を返している
     可能性がある(pushが完了していない、または別のcommitがさらに積まれた等)。
     一致するまでpushし直すか、状況をユーザーに報告する。一致を確認しないまま
     チェック結果を「今のコードに対する結果」として報告しない

2. **現状確認**
   - `gh pr checks "<branch>"` で現在のチェック状態を一覧する
   - すべて完了済みなら手順4へ
   - **push 直後は CI がまだ登録されておらず `no checks reported on the '<branch>' branch`
     (exit 1)を返すことがある。これは失敗ではなく登録待ちなので、30秒あけて3回程度
     リトライする。pending 中に返る exit 8 も同様に正常系**として扱い、どちらも
     ツールエラーとしてユーザーへ報告しない(実測でこの2種が計6回、無用なエラー扱いに
     なっていた)。3回リトライしても checks が現れない場合だけ、PR や workflow 設定の
     問題として報告する

3. **完了まで待機（Monitor ツールで外部プロセス化する。最優先）**
   - **polling ループそのものを Monitor ツールで外部プロセスとして起動する。**
     Monitor はシェルスクリプトをバックグラウンドの別プロセスとして実行し、
     stdout に出た行だけが通知としてエージェントに届く方式のため、完了を待つ間
     エージェントのターンが一切発生せず、routine-ops への委譲より待機コストが低い
     （sub agent の起動・保持コストすらかからない）。
     command には状態変化ごとに差分行を出し、全チェック完了で exit するループを渡す:
     ```bash
     prev=""
     prev_names=""
     stable=0
     errors=0
     while true; do
       s=$(gh pr checks "<branch>" --json name,bucket 2>&1)
       # gh pr checks は fail が1件でもあればexit 1、pending中はexit 8を返すが、
       # どちらの場合も$sには有効なJSONが入っている。exit codeで分岐して$sの
       # 解析をスキップすると、fail/pendingを一切検知できず沈黙したままtimeoutまで
       # ハングする(実測で発生)。$sがJSONとして妥当かどうかだけで実エラーを判定する。
       # ただしauth切れ・権限不足・rate limit等の恒久的なgh失敗も同じ経路に落ちるため、
       # 連続失敗回数を数え、一定回数(5回=約2.5分)を超えたら登録待ちと決めつけず
       # エラーとして報告して終了する。exit 1で終了し、正常完了と同じ
       # "ALL CHECKS DONE" 経路には絶対に合流させない(合流させると呼び出し側が
       # エラー時にも完了と誤認する)
       if ! jq -e . >/dev/null 2>&1 <<<"$s"; then
         errors=$((errors + 1))
         if [ "$errors" -ge 5 ]; then
           echo "ERROR: gh pr checks failed repeatedly: $s"
           exit 1
         fi
         sleep 30
         continue
       fi
       errors=0
       names=$(jq -r '.[].name' <<<"$s" | sort)
       cur=$(jq -r '.[] | select(.bucket!="pending") | "\(.name): \(.bucket)"' <<<"$s" | sort)
       comm -13 <(echo "$prev") <(echo "$cur")
       prev=$cur
       # push直後はchecksが遅れて登録されるため、その時点の配列が全てpending以外だと
       # いうだけでは完了と確定できない(後から追加registerされるチェックを待たずに
       # 完了扱いしてしまう)。check名の集合が連続3回のpollで変化していない
       # (=90秒以上新しいチェックが登録されていない)ことも合わせて要求する。
       # **これは経験則であり、絶対の保証ではない**(3回目の直後に新規チェックが
       # 登録される可能性は原理的に残る)。この理由により、手順4の最終確認で
       # pendingが残っていた場合はこの手順3へ戻ること(下記手順4参照)。
       # stableのカウントはpending中も進めない: 「pendingのcheckが1つ残ったまま
       # 30秒間名前が変わらない」ことは完了に近づいた証拠にならないため、pendingが
       # 1つでもある間はカウントをリセットし、全てpendingでなくなってから安定回数を
       # 数え始める
       if jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null 2>&1 && [ -n "$names" ]; then
         if [ "$names" = "$prev_names" ]; then
           stable=$((stable + 1))
         else
           stable=1
         fi
       else
         stable=0
       fi
       prev_names=$names
       if [ "$stable" -ge 3 ]; then
         break
       fi
       sleep 30
     done
     echo "ALL CHECKS DONE"
     ```
     ```
     Monitor({
       description: "PR <branch> の CI checks",
       command: "<上記スクリプト>",
       timeout_ms: 1800000
     })
     ```
     - CI が 30 分を超えることが分かっている場合は `timeout_ms` を伸ばすか
       `persistent: true` にする
     - 通知（各チェックの完了行、または `ALL CHECKS DONE`）が届いたら手順4へ進む。
       polling 間隔は 30 秒以上にする（CI は通常 1〜3 分かかり、短いと無駄になる）。
       pending が 10 分を超えて続くチェック（例: 外部レビュー系）は間隔を 60〜120 秒へ
       広げる（実測: exit 8 を短間隔で3連発して無駄打ちしたケースがある）
     - 特定ジョブ名（例: `^test \(2\)`）で条件を絞るのは、そのジョブ名が実際に存在することを
       手順2の出力で確認できた場合のみにする
   - **`Monitor` と `Agent`/`subagent_type` はいずれもClaude Code固有のtool呼び出しである**。
     このskillが配布される他ランタイム(Codex等)にはどちらも存在しない。それらの
     ランタイムに同等の非同期/sub agent委譲機構があればそれを使い、無ければ
     以下の「さらにその…」に示すポータブルなbash loopへ直接進んでよい
     (foreground実行になるためメインの処理をその間占有するが、shellが実行できる
     ランタイムであれば動作する)
   - **Monitor が使えない環境でのフォールバック**として、routine-ops(haiku) sub agent に
     polling を委譲してもよい（[[delegate-routine-ops]] の対象操作5。待ち時間中の出力を
     メイン文脈に溜めない点は同じだが、sub agent 分の起動コストがかかる分 Monitor より高い）。
     **必ず `run_in_background: true` で起動し、完了通知で結果を受け取る**。foreground 起動は
     CI 完了までセッション全体を占有する（実測: foreground polling が23分セッションを占有し、
     ユーザーが待ちきれず割り込みで中断した）:
     ```
     Agent({
       description: "Poll CI checks until done",
       subagent_type: "routine-ops",
       run_in_background: true,
       prompt: "作業ディレクトリ /path/to/repo で `gh pr checks "<branch>" --watch --interval 30`
         を実行し（完了までブロックする）、終了後に `gh pr checks "<branch>"` の全チェックの
         合否一覧と、失敗がある場合は失敗したジョブ名・run-id を報告して。"
     })
     ```
     さらにその `--watch` すら使えない・timeout した場合は、ジョブ名に依存しない条件の
     ループで待つ。foreground の単発 `sleep` は harness にブロックされるため、必ず
     ループ条件付きで待機する:
     ```bash
     while gh pr checks "<branch>" 2>&1 | grep -qiE '\b(pending|queued|in_progress)\b'; do sleep 30; done
     ```

4. **結果の一覧**
   - `gh pr checks "<branch>"` で pass / fail を確認する
   - **この時点でまだ `pending`/`queued`/`in_progress` の check が残っている場合、
     それは手順3の完了判定(経験則であり保証ではない)をすり抜けて後から登録された
     checkである可能性が高い。pass/failとして扱わず、手順3の待機へ戻る**
     (手順3のMonitorスクリプト・`--watch`・ジョブ名非依存loopのいずれで待った場合も、
     終了直後は必ずこの手順4で最終確認し、pendingが残っていれば戻ること)
   - **`cancel`（cancelled）状態のcheckをpassとして扱わない**。`bucket`には
     `pass`/`fail`/`pending`/`skipping`/`cancel`があり、`cancel`は「実行されたが
     成否が確定していない」状態(例: 同じPRへの後続pushでの自動キャンセル)なので、
     成功扱いにも失敗扱いにもしない。cancelされたcheckがある場合は、対象commitに
     対して再実行が必要か(`gh run rerun <run-id>` 等)を確認するか、ユーザーに報告する

5. **失敗時は修正ループを回す（最重要）**
   - **CI の失敗は「手元のコードが間違っている」ことを意味する。** CI 環境のせいにせず、
     コードを直す前提で対応する。「CI が不安定」「flaky」等と安易に結論づけて放置しない。
   - 該当 run の `gh run view <run-id> --log-failed` で失敗ログを抽出する（ログ抽出・
     該当箇所の抜粋までは routine-ops に委譲してよい。原因の特定と修正方針はメインモデル）
   - 手元のコードを修正し、ローカルで該当範囲の lint / tsc / build / test を再確認する
   - 修正を commit / push する。**この skill はCI確認・修正の定型化が目的であり、
     commit / push の許可規則([[git-workflow]] の「明示的許可がある場合のみ」)を
     上書きしない**。既存PRへの追加commitとして許可の射程内かを確認し、射程外なら
     このskillの手順を理由に無許可でcommit / pushしない
   - **手順3ではなく手順1のHEAD/PR head確認からやり直す**。pushのたびにlocal HEADが
     進むため、手順1の「`git rev-parse HEAD` と PR の `headRefOid` が一致するか」の
     確認を再度行ってから手順3の待機に入る。ここを飛ばして手順3へ直接戻ると、
     ずっとbranch名だけでpollingし続けることになり、途中で別のcommitがさらに
     積まれるような並行pushがあった場合に、どのcommitに対する結果を見ているかを
     取り違える。CI が全 pass になるまでこのループを繰り返す
   - 同一原因の修正試行が3回を超えても解決しない場合、ループを続けず状況(試した対応・
     残った失敗)をユーザーに報告して判断を仰ぐ
   - ローカルで通るのに CI で落ちる場合は、base ブランチ取り込み漏れ・環境差・生成物
     （schema 等）の再生成漏れを疑い、原因を突き止めて直す（下記「注意」参照）

6. **報告**
   - 最終的に全 pass した旨、または（修正を試みても解決しない場合）残った失敗と
     判明した原因・試した対応をユーザーに報告する

## 注意

- `gh pr view "<branch>" --json mergeable,mergeStateStatus` の `UNSTABLE` は
  「CI 実行中 / 一部失敗」を意味し、conflict ではない。`mergeable: MERGEABLE` なら
  conflict なし。CI の成否とマージ可否は別軸なので混同しない
- PR が merge コミット（PR base との merge）でビルドされる場合、ローカルの
  `tsc`/`build` が通っても base 側の新規ファイルとの組み合わせで CI が落ちることがある。
  その場合は base ブランチを取り込んでから再確認する
- polling 中にユーザーから割り込みがあれば中断してよい
