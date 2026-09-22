---
name: development-application
description: 'アプリケーション実装で、実装手段の選択、I/O、test infrastructure、monorepo、platform制約、DB/API設計を検討するときに使う。'
---

# Development Application

このskillはmodel/runtimeをまたいで再利用できるengineering knowledgeを定義します。reviewを必須にする条件、仕様書を必須にする条件、compatibility方針、質問/停止条件、完了時の検証範囲などのworking agreementはこのskillでは定義しません。

## Implementation Selection

実装方法を決める前に、以下を上から順に検討し、要求を正しく満たす最初の選択肢を採用する。下位の選択肢へ進むのは、上位の選択肢では要求を満たせない場合だけとする。

1. **変更自体が必要か**
   - speculativeな将来要件、依頼されていない拡張性、想定だけの互換性のための実装は行わない
   - 承認済みの仕様・acceptance criteria・安全性要件を「不要」と判断して削らない
2. **既存コード・型・patternで適切に表現できるか**
   - 新しいhelper / util / abstraction / 共通型を作る前にrepo内を検索する
   - 既存実装が現在の設計として適切なら再利用する。ただし、既存という理由だけで不適切な設計や互換レイヤーを延命しない
3. **言語の標準機能・標準ライブラリで解決できるか**
4. **platform / framework / database等のnative機能で解決できるか**
5. **既に導入済みのdependencyで解決できるか**
6. **それでも必要なら、要求を満たす最小の新規実装を行う**

- 新しいdependency、abstraction、wrapper、service、config、compatibility layerを追加する場合は、上位の選択肢で解決できない理由を説明できること
- コード行数の少なさ自体を目的にしない。可読性、保守性、型安全性、既存の言語別skillのstyleを優先する
- この順序を理由に、必要なvalidation、authorization、error handling、transaction、data integrity、accessibility等を削らない

## General Guidelines

- データアクセス（SQL query / API call / file I/O）を件数 N に比例して繰り返す実装を避け、一括取得・一括書き込み（bulk操作・JOIN・IN句等）で件数に依存しない回数へ抑える。
- loop内部でSQLのINSERT/UPDATE/DELETEを繰り返す前に、set-based operationやbulk writeで表現できないか確認する。
- 外部システムの実データ状態が原因調査の前提になる場合、コード差分やgit履歴だけで仮説を確定せず、利用可能なら実データまたはauthoritative responseを確認する。
- project内のagent向けknowledgeは、特定agent用に内容を複製するのではなく、portableなsemantic coreとruntime adapterを分離する。

## Telemetry and Privacy Contract

- user-facingのtelemetry/privacy説明を変更する場合は、表示文言を実装されたevent schemaへイベント単位で照合する。各eventの許可parameter、値の意味、送信条件を一覧化し、UIの説明が別eventのparameterまで送信するように読めないことを確認する
- 自動収集型analytics SDK（GA4など）による自動収集と、診断・操作に紐づく明示的なevent送信を区別して説明する。未送信の情報を送信すると読める表現や、送信される情報を過小申告する表現を残さない
- schema/API/実装側でparameterのキー集合を取得できる場合は、テストでeventごとのキー集合をexactに検証する。文言だけのテストにせず、実装契約の変更を検出できるようにする
- telemetry/privacy変更がない作業では、この検証をN/Aとして扱い、N/A理由を独立reviewのinputsへ記録する

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

## Platform Constraint Guidelines

- クラウド/プラットフォームの制約に当たって回避策を設計する前に、**その制約自体を持たない代替サービス・後継機能がないかを必ず調査する**。制約は「所与の事実」ではなく「そのサービス世代の制約」であることが多い（例: classic EventBridge Rules はスケジュールをデフォルトバスにしか置けないが、後継の EventBridge Scheduler は Universal Target で任意のバス/API へ直接配信できる）
- **「1回のAPI呼び出しを仲介するだけの Lambda/Functions/コンテナ/スクリプト」を追加する場合は、Implementation Selection の native 機能確認を必ず実施する**。直接統合が見つからなかった場合のみグルーコードを採用し、その調査結果を設計コメントに残す
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


## API / Interface Design Guidelines

- **危険度が非対称な操作を、同一エンドポイントのオプショナルパラメータで切り替えない**
  - 例: 更新 API の対象IDパラメータを null 許容にし「未指定なら組織内の全レコードを一括更新」とする設計は、実装ミス・UI バグ・パラメータ欠落で意図せず全件実行される事故を生む。パラメータの省略が「より広範囲で危険な動作」へ静かにフォールバックしてはならない
  - 影響範囲が桁違いに広がる操作（単一対象 vs 全件/一括）は、別エンドポイント・別コマンド・別インターフェースとして構造的に分離し、危険な側は明示的な指定（例: 専用パス、確認用パラメータ）なしに到達できない設計にする

## Error Response Guidelines

- APIエラーの設計は下記RFCに従う
  - [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
  - [RFC 9205: Building Protocols with HTTP](https://www.rfc-editor.org/rfc/rfc9205)
