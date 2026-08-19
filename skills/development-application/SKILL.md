---
name: development-application
description: 'アプリケーションの作成/開発時に参照する全般に適用される方針。互換性より最適な実装を優先する。実装完了時にlint/format/build/testの実行と結果報告を行い、再利用可能な学びはskillへ反映する。'
---

## Independent Review Gate

- コードを変更する実装・リファクタリング・bugfixでは、実装開始前に共有の`code-review` skillをロードして従う
- `code-review`が利用できない環境では、portableなレビュー契約を満たす独立reviewer（fresh context）へadapterし、特定runtimeのskill名を仮定しない
- ローカルの実装品質ゲートは`code-review`、仕様書の質問・仕様reviewは`spec-drilldown`、GitHub PRへの取得・コメント・判定投稿はplatform adapterの責務とする
- 2ファイル以上を変更する場合、またはcommit/pushを伴う場合は、`code-review`の独立reviewer判定を得るまで完了扱い・commit・pushをしてはならない
- test、build、lint、生成コード検証は自己検証であり、独立reviewの代替にはならない
- documentation-only / pure config-onlyでユーザーが明示的にverificationをskipした場合は品質ゲートを省略できる。ただし、仕様・契約上qualified reviewが必須の場合は、skipの対象外として理由を記録する

## Specification First

- アプリケーション・新機能の作成依頼で仕様が曖昧な場合、実装や plan 作成に着手する前に `spec-drilldown` skill を実行し、仕様を磨き込んでから実装する
- 承認された仕様書なしに新規作成の実装を始めない（明確な bugfix や仕様の自由度がない作業は除く）

## General Guidelines

- **明示的な指定がない限り、PRのtarget/base branchとの差分を最小にして着手する**。PR target/base branchが明示されている場合はそれを優先し、未指定の場合だけ`git ls-remote --symref origin HEAD`等のauthoritative remote metadataからdefault branchを解決する。通常は`main`、存在しなければ`master`等だが、branch名を推測しない。開始前に目的・受け入れ条件・変更対象を列挙し、各変更が目的達成に必要かを確認する。既存の未マージbranch、作業途中のworktree、関連機能の実装をそのまま土台にしない
- **スコープ外の機能を依存扱いしない**。対象機能が実際にimport・route・schema・runtimeで参照している証拠がない限り、関連しそうな機能（例: engagement）を追加・復活させない。必要に見える場合は、まず確定したPR target/base branch起点の最小構成で検証し、失敗ログと依存箇所を示してから拡張する
- 作業報告をする際に何が保証され、特に **何を保証していないか** を説明する
- 互換性を考慮した実装をしない。課題に対して0ベースで最適な実装を選択する
- 既存実装の延命より作り直しを優先する
- 移行コストより新規実装の保守性と単純性を優先する
- 互換レイヤーやフォールバック実装を禁止する
- 「diff最小」と「作り直し優先」が衝突する場合の優先順位: まず設計として最適な方（作り直しを含む）を選び、その設計の実現に不要な変更を diff に含めない。「diff最小」を理由に劣った設計へ妥協しない
- データアクセス（SQL query / API call / file I/O）を件数 N に比例して繰り返す実装を避け、一括取得・一括書き込み（バルク操作・JOIN・IN句等）で件数に依存しない回数に抑える
- ループ処理の内部でSQLのINSERT/UPDATE/DELETEを繰り返し実行することを禁じる
- 外部システムの実データ（本番スプレッドシート・外部API・DBの実レコード等）の状態が前提になる原因調査では、コード差分や git 履歴からの推論だけで仮説を確定して修正しない。**修正前に実データを直接確認する**（例: spreadsheet なら `google-spreadsheet` skill で該当セルを実際に読む）。独立レビュー（finish-review 等）は diff とコードベースの内部整合性しか検証できず、外部データ前提の正しさは保証しないため、レビュー通過を仮説の裏付けとして扱わない
- **モノレポで package 間の設定・utility を共通化する設計をデフォルトにしない**。context が異なる package は一見同型でも分離を優先する（`tsconfig.base` のような共通化は、後から差分が出たときに全 package を巻き込む）。logger や fetcher のような「共通に見える」実装も同じで、共通化するのは変更理由が同一であることを説明できる場合だけにする
- プロジェクト内の agent 向け knowledge（規約・手順のドキュメント）は、特定の agent ツールに依存しないツール中立な単一実体として置く。ツールごとにディレクトリを複製しない（実体は1つ、各ツールからは薄いポインタで参照する）

## Change Scope and Completeness

- **1箇所を直したら、同一パターンが repo 内に他にないかを grep で確認し、残件の有無を完了報告に含める**。lint の ignore 解消・エラー契約の統一・型注釈の追加など「パターンで書かれたもの」は特に漏れやすい。残件が多くスコープを超える場合は、着手前にスコープを確認する
- あるステータスやエラー型に適用した設計は、**対称性のある兄弟概念にも適用すべきかを完了報告の前に検討する**（400 に対する 500、BadRequestError に対する InternalServerError など）。片側だけ直して報告すると、ほぼ必ずもう片側を指摘される
- **アプローチを別案へ置き換えたら、旧アプローチの生成物の棚卸しを行う**。lint ルール・設定ファイル・生成コード・ドキュメントが不要になっていないかを確認し、削除要否を報告する
- **当初の依頼から作業スコープが2段階以上拡大したら、セッション / PR の分割をユーザーへ提案する**。1セッションに詰め込むと context 枯渇と API エラーで手戻りが増える（実測: lint plugin 開発 + 契約追加 + 全面リファクタを1セッションに入れて transcript が 11MB に達し、auto-compact と接続断が多発した）

## Test Infrastructure Preservation

- test setup、global setup/teardown、CI script、worker設定を変更するときは、並列性・実行順序・診断logを既存のbehavior contractとして扱う
- 「整理」「cleanup」「安定化」だけを理由に、独立処理の逐次化、worker数の削減、意図的な`console.log`や進捗logの削除を行わない
- 変更前に、通常worker数、同時に用意されるDB/service数、test件数、運用で参照されるlogをbaseline化する
- 独立したsetup/teardown処理は並列性を維持し、resource closeや次段階への遷移は全処理完了後に行う
- test infrastructure変更後は、同じtest集合をsingle-worker経路と通常のparallel-worker経路で実行する
- 性能改善または性能維持が目的なら、pass/failだけでなくworker数・test件数・所要時間または同等の並列性evidenceを報告する
- 診断logを削除・変更する場合は、利用者と代替観測手段を確認し、その意図をtestまたはコメントへ残す

## Monorepo Guidelines

- 複数パッケージ(api/bin/client/shared)の実装がたまたま似ていても、それだけを理由に共通化しない(ルートに tsconfig.base.json を作って extends させる、logger/fetcher のような実装コードを shared に抽出する、など)
- 各パッケージは実行コンテキストが異なる(Node ESM バックエンド、Next.js フロントエンド、dev専用CLI 等)。今の実装が偶然似ている・フレームワーク非依存に書けているとしても、それは本質的な共通性の証明にはならない。重複を許容し、各パッケージを自己完結させる
- shared に置いてよいのは、API契約やDBスキーマのようにフレームワーク・実装に関わらず常に同一であるべきもの(生成された OpenAPI schema 型、Prisma client、Result 型など)に限る
- 共通化を提案する前に「client パッケージが全く別のフレームワークで書き直されたら、この共通化は成立するか?」と自問する

## Design Decision Escalation

- **どちらにも筋が通る設計分岐は単独で決めず、選択肢と影響範囲を提示して確認する**。例: 既存の宣言(型・契約・設定)と実装の実態が食い違っている場合、宣言を実態へ合わせるか実態を宣言へ合わせるかはどちらも成立し得る設計判断であり、確認なしに一方へ倒さない
- **新しい共有抽象（helper / util / 共通型）を作る前に、既存の同種実装パターンを repo 内で検索する**。既存の型・パターンで表現できる場合はそれに従い、独自の新規抽象を発明しない
- **観測事実と推論を分離して報告する**。影響（壊れる / drift している等）や原因を主張する前に再現観測で裏取りし、未観測の主張には「推定」と明記する。CLI 出力の欠落は `--json` 等の機械可読形式で裏取りしてから結論する

## Platform Constraint Guidelines

- クラウド/プラットフォームの制約に当たって回避策を設計する前に、**その制約自体を持たない代替サービス・後継機能がないかを必ず調査する**。制約は「所与の事実」ではなく「そのサービス世代の制約」であることが多い（例: classic EventBridge Rules はスケジュールをデフォルトバスにしか置けないが、後継の EventBridge Scheduler は Universal Target で任意のバス/API へ直接配信できる）
- **「1回のAPI呼び出しを仲介するだけの Lambda/Functions/コンテナ/スクリプト」を追加する設計は、ネイティブ統合の見落としシグナルとして扱う**。採用前に直接統合の存在を確認し、見つからなかった場合のみグルーコードを採用してその調査結果を設計コメントに残す
- 回避策を含む plan をレビューに出すときは、依拠している制約に出典（公式ドキュメント/検証結果）を添える。出典を示せない制約は思い込みの可能性があるため、その場で再調査する

## Database Schema Design Guidelines

- **DB カラムに boolean / tinyint 型を原則使用しない**
  - boolean は 2 値しか表現できず拡張性がない。tinyint は数値に意味を持たせるため可読性が低く、拡張時に既存値との対応管理が困難になる。どちらも要件が増えた際に enum へのカラム変更が必要になり、データ移行コストと整合性リスクが発生する。
  - 代わりに enum 型を使用する。新しい状態は enum 値の追加だけで対応でき、型安全性と可読性も保たれる。
  - 例外: 本質的に 2 値しか存在しないドメイン知識がある場合（将来的にも 3 値目が考えられないケース）に限り boolean を許容するが、その場合もコメントで理由を明記すること。

```sql
-- NG: boolean / tinyint はステータス管理に使わない
enabled   BOOLEAN  NOT NULL DEFAULT TRUE
status_cd TINYINT  NOT NULL DEFAULT 1  -- 1=active, 2=disabled ... 意味が不明確

-- OK: enum で拡張可能なステータスとして定義する
CREATE TYPE import_config_status AS ENUM ('active', 'disabled');
-- 将来: ALTER TYPE import_config_status ADD VALUE 'archived'; で無停止追加可能
status import_config_status NOT NULL DEFAULT 'active'
```

## Skill Feedback

- 作業中に再利用可能な修正・不足手順・新しい pitfall・変更された運用ルール・より良い完了条件を見つけたら、関連 skill の更新をユーザーに提案することを作業完了条件に含める
- 既存 skill の修正で足りるなら patch し、既存の受け皿がない再利用可能な手順なら新しい skill を作る
- 判断に迷う場合は `skill-feedback-criteria` を参照し、skill に反映すべきでない場合でも durable な記録へ残すべきかを判断する
- skill を更新できなかった場合は、その理由と暫定的に残した記録先を完了報告に明記する

## Completion

- 実装完了後に必ずlint/build/testを実行し、エラーが発生しなくなるまで繰り返し修正を行う
  - testやlintの実行はciのコマンドを参照して実行する
  - lintのエラーの場合まずは自動修正を試みる
- 実現した仕様を最後に簡潔に説明する
- 他のskillが同時にloadされている場合、そのskillの **禁止事項** を完了前チェックに含めること
- skill違反を見つけた状態で「完了」扱いすることを禁じる。違反がある場合は必ず修正を優先すること
- 「skillは読んだが実装では逸脱した」という失敗を防ぐため、変更したファイルに対して skill違反の再読チェックを完了前に必ず行うこと

## API / Interface Design Guidelines

- **危険度が非対称な操作を、同一エンドポイントのオプショナルパラメータで切り替えない**
  - 例: 更新 API の対象IDパラメータを null 許容にし「未指定なら組織内の全レコードを一括更新」とする設計は、実装ミス・UI バグ・パラメータ欠落で意図せず全件実行される事故を生む。パラメータの省略が「より広範囲で危険な動作」へ静かにフォールバックしてはならない
  - 影響範囲が桁違いに広がる操作（単一対象 vs 全件/一括）は、別エンドポイント・別コマンド・別インターフェースとして構造的に分離し、危険な側は明示的な指定（例: 専用パス、確認用パラメータ）なしに到達できない設計にする

## Error Response Guidelines

- APIエラーの設計は下記RFCに従う
  - [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
  - [RFC 9205: Building Protocols with HTTP](https://www.rfc-editor.org/rfc/rfc9205)
