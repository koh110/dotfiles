---
name: delegate-routine-ops
description: 'TRIGGER when: git commit/push/PR作成、npm install等の依存関係更新、build/test/lint/tscの実行と結果集約、コードやログのgrep調査・バージョン確認などの読み取り専用調査、docker composeの起動確認、CI pollingといった、手順が固定的で判断の余地が小さい定型作業を実行する直前。ユーザーの許可条件（例: 明示的なcommit許可）を満たした上で、実行自体を最安価モデル(haiku)のroutine-ops sub agentに委譲し、メインモデルのコストを節約する。コード修正・設計判断・レビュー・原因分析・destructive操作など思考や慎重さを要する作業では使わない。'
---

## 目的

手順が固定的で判断の余地が小さい定型作業は、メインモデル（高コスト）で直接実行する
必要がない。これらを最安価モデル（haiku）で動く `routine-ops` sub agentに委譲し、
メインモデルのトークンコストを節約する。「実行そのもの」を委譲するだけで、
「何を実行すべきか」「結果をどう解釈するか」の判断はメインモデルに残す。

実行の作法（報告形式、destructive拒否、失敗時の即時終了）はagent定義
（`~/.claude/agents/routine-ops.md`）側に組み込まれている。このskillは
「いつ・何を委譲するか」「許可条件」「検証責任」を定めるポリシー層である。

## バックストップ hook（発火漏れ対策）

このskillは記述的トリガーなので発火はメインモデルの裁量に依存する。実測で
「調査ロジックを詰めながら逐次コマンドを組む流れ」では委譲判断を飛ばしやすい。
これを補うため PreToolUse(Bash) hook `routine-ops-gate.sh`（settings.jsonで配線）が、
メインスレッドが手順の確定した読み取り専用の重い調査/集約（`grep -r`/`rg`、`find`、
`jq`/`awk`集約、ループ読み取り等）を実行する場面で、委譲を促すリマインダーを
`additionalContext` で注入する（**初回、以降は委譲対象コマンドが約10回積み重なるごと**。
旧設計の「1セッション1回」は長時間セッションで実質無効だったため緩和した。
ブロックしない・subagentの実行には `agent_id` 判定で介入しない）。hookは思い出させるだけで、実際に委譲するか・
何を委譲するかの判断はこのskillとメインモデルに委ねられる。委譲の主目的は探索出力を
メイン文脈に溜めず cache_read コスト（実測で全体コストの約半分）を抑えることにある。

**姉妹hook（Explore委譲漏れ対策）:** `routine-ops-gate.sh` は「1つのBashコマンドの形」
から委譲漏れを検知するため、「まだ探索方針が決まっていない状態で、単発では正当に見える
読み取り呼び出し（`ls`/個別の`Read`等）を連発してしまう」というExplore委譲漏れの形は
検知できない（複数呼び出しにまたがる進め方の癖であり、単一コマンドの形では判別不能）。
これを補うのが PreToolUse hook `investigation-streak-gate.sh`（matcher:
`Bash|Read|Grep|Glob|Agent|Task|Edit|Write|NotebookEdit`）で、メインスレッドが読み取り系
ツール（Bash/Read/Grep/Glob）を6回連続実行した時点で `additionalContext` にリマインダーを
注入する（transcript再解析ではなく`/tmp`のカウンタファイルで判定、O(1)）。`Agent`呼び出し
（=委譲した）や `Edit`/`Write`/`NotebookEdit`（=実装フェーズに入った）でカウンタをリセット
し、以降は6回進むごとに再通知する。subagent自身の呼び出しは `agent_id` 判定で対象外。
サブエージェント起動tool名は本環境では実測で `Agent`（`Task`ではない）と確認済みだが、
将来のバージョン差異やmachine移行に備えて両方をリセット対象に含めている。

## 対象操作（委譲してよい）

過去セッションログの実測で頻度の高い順:

### 1. ビルド/テスト/lint/型チェックの実行と結果集約
- `npm run tsc` / `lint` / `build` / `test` / `test:ci` / `format` の実行
  （実測: 全Bashコマンドの約1/6を占める最頻の定型作業）
- 出力ログを要約し、**合否と失敗箇所の抜粋のみ**を報告させる
  （失敗原因の特定・修正方針の決定はメインモデルが行う）

### 2. 読み取り専用の調査
- コード横断のgrep・find（実測: grep/find/cat/ls/head/tail系で全体の約4割）
- ログファイルのgrep・抽出、依存パッケージのバージョン確認
- 環境変数一覧・設定ファイル内容の整形
- 複数ファイルに同一パターンが存在するかの確認
- **大容量の外部ドキュメント・Webページからの情報抽出**: `curl` で取得した巨大ページ
  （例: 1MB超の単一ページAPIリファレンス）から特定の仕様値・記述を探す作業は、URL と
  「何を探すか」を prompt に書いて委譲し、**該当箇所の抜粋だけ**を報告させる
  （実測: 外部SaaSの1.7MB規模のAPIリファレンスページに対するcurl+検索の試行錯誤を
  メイン文脈で5回以上繰り返し、探していた仕様値1行に到達するまで大量のtool往復を
  消費した。WebFetch が使えないページ・要点が深いページほど委譲の効果が大きい）
- ※ 「何を探すべきかの探索自体に判断が要る」広い調査はExplore agentの領分。
  routine-opsに投げるのは検索パターン・対象path（またはURL）まで確定している調査のみ

### 3. git状態確認
- `git status` / `git diff` / `git log` / `git show` / `gh pr view` / `gh pr checks`
  などの読み取り専用確認

### 4. VCS書き込み操作
- `git add` / `git commit`（commit message生成を含む）
- `git push`
- `gh pr create`（title/body生成を含む）

### 5. CI polling
- `gh pr checks` のpollingと完了時の合否・失敗ログ抽出
- push後のCI確認フローそのものは [[wait-for-ci]] skillに従い、その中の
  polling実行をroutine-opsに委譲する

### 6. 依存関係管理
- `npm install` / `npm ci` の実行と結果報告（失敗の有無、警告の要約）
- lockfileの差分確認（読み取り専用）

### 7. docker compose起動・状態確認
- `docker compose up -d <service>` と `docker compose ps` による起動確認polling

## 対象外（委譲しない・メインモデルが直接行う）

- コードの修正・設計判断を伴う作業
- destructive操作（`reset --hard`, `push --force`, `branch -D`, `rebase -i`, `clean -f`,
  使用中の依存の`npm uninstall`, DBのtruncate/drop等）
- conflict解消（rebase/merge conflictは判断を要する作業として必ずメインが引き取る）
- テスト/ビルド失敗ログから**原因を特定し修正する**判断
  - 境界線: 「実行して失敗ログの該当箇所を抜粋する」まではroutine-ops、
    「なぜ失敗したか」を考え始めた時点からメインモデル
- レビュー指摘の解釈やplan作成など、思考が必要な作業
- ユーザーからの明示的な許可がまだ得られていない commit / push / PR作成 / 依存追加
  - CLAUDE.mdやmemoryに「commit前に許可が必要」等のルールがある場合、そのルールは
    このskillを使っても変わらず適用される。sub agentへの委譲は「誰が実行するか」を
    変えるだけで、「許可が必要かどうか」は変えない

## 手順

1. **許可条件を先に満たす**
   - commit / push / PR作成 / 依存追加など、通常ガードレール（CLAUDE.md、ユーザーへの
     確認等）が必要な操作は、メインセッション側で先にクリアしてから委譲する
   - build/test実行やログ確認など読み取り専用の作業には通常この確認は不要

2. **ランタイムのsub agent委譲機構で `routine-ops` を起動する**
   - **Claude Code**: Agent toolで `subagent_type: "routine-ops"` を指定する
     （モデル・tool制限・報告規則はagent定義側で設定済み。`model` の個別指定は不要）。
     agent一覧に `routine-ops` が見当たらない環境では、fallbackとして
     `subagent_type: "claude"` + `model: "haiku"` を使い、agent定義相当の
     実行規則（事実のみ報告・destructive拒否・失敗時即終了）をpromptに含める
   - **Codex 等の他ランタイム**: `Agent`/`subagent_type` はClaude Code固有のtool
     呼び出しであり存在しない。そのランタイムが持つ同等のsub agent委譲機構
     （例: Codexの `.codex/agents/routine-ops.toml` で定義されたagent profile）
     があればそれを使う。委譲機構自体が存在しないランタイムでは、このskillの
     「実行そのものをコスト最適化のため他プロセスへ渡す」という部分は適用対象外とし、
     メインモデルが直接実行してよい(手順3・4の検証・失敗時引き取りの責務は変わらない)
   - promptには実行すべき正確なコマンド、対象path、期待する報告形式
     （commit SHA、push結果、PR URL、合否、失敗ログの抜粋等）を過不足なく書く。
     sub agentには会話履歴が見えないため、repo path・branch名・対象ファイルなど
     必要な情報を自己完結的に含める
   - 判断の余地を残さない。「良い感じにやって」のような曖昧な指示にしない
   - 複数の定型操作（add + commit + push、lint + test 等）はsub agent起動
     オーバーヘッドを避けるため1回のAgent呼び出しにまとめる
   - 結果を待ってから次の作業に進む必要がある場合は `run_in_background: false`
   - 例1（VCS）:
     ```
     Agent({
       description: "Commit and push review fixes",
       subagent_type: "routine-ops",
       run_in_background: false,
       prompt: "作業ディレクトリ /path/to/repo (branch: feature/foo) で以下を実行:
         1. 次のファイルをgit addする: <file1> <file2>
         2. commit message styleに合わせて日本語のcommit messageを作成しcommitする
         3. origin feature/foo にpushする
         4. commit SHAとpush結果を報告する"
     })
     ```
   - 例2（build/test実行と要約）:
     ```
     Agent({
       description: "Run lint and test, summarize",
       subagent_type: "routine-ops",
       run_in_background: false,
       prompt: "作業ディレクトリ /path/to/repo で `npm run lint -w <pkg>` と
         `npm run test -w <pkg>` を実行し、各コマンドの終了コードと、
         失敗した場合は失敗箇所のログ抜粋のみを報告して。"
     })
     ```

3. **結果を検証する（委譲しても検証責任は残る）**
   - sub agentの報告を鵜呑みにせず、`git log -1` / `gh pr view` / 実際の出力等で
     意図した結果になっているか必ず確認する（この確認自体も読み取り専用なので
     次のroutine-ops呼び出しに相乗りさせてよい）
   - build/testが失敗している場合、原因分析と修正方針の決定はメインモデルが行う

4. **失敗時はメインモデルが引き取る**
   - conflict、pre-commit hook失敗、インストール失敗、権限エラー等が発生した場合、
     sub agentに再試行や原因調査をさせず、メインモデルが状況を確認して判断する
   - destructive操作が必要になった場合の判断はhaikuに委ねない

## 注意

- 委譲は「実行者の変更」であり「承認プロセスの省略」ではない。ユーザーが明示的に
  許可していないcommitやforce push、依存追加等をsub agentに実行させることは禁止
- 「結果の解釈・原因分析・修正方針の決定」はhaikuに担わせない。routine-opsは実行と
  生の結果報告に徹し、判断が必要な時点でメインモデルに戻す
- [[git-workflow]] skill（worktree運用・branch戦略）とは役割が異なる。こちらは
  「誰が実行するか（コスト最適化）」、git-workflowは「どこでどう作業するか」を扱う。
  委譲する場合もgit-workflowの規律（worktree内で実行、diff確認後にcommit等）は
  promptに反映してメインモデルが担保する
