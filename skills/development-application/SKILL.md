---
name: development-application
description: 'アプリケーションの作成/開発時に参照する全般に適用される方針。互換性より最適な実装を優先する。実装完了時にlint/format/build/testの実行と結果報告を行い、再利用可能な学びはskillへ反映する。'
---

## General Guidelines

- 互換性を考慮した実装をしない。課題に対して0ベースで最適な実装を選択する
- 既存実装の延命より作り直しを優先する
- 移行コストより新規実装の保守性と単純性を優先する
- 互換レイヤーやフォールバック実装を禁止する
- O(N) となる処理を避け、O(1) となるように処理を記述する
- ループ処理の内部でSQLのINSERT/UPDATE/DELETEを繰り返し実行することを禁じる

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

## Error Response Guidelines

- APIエラーの設計は下記RFCに従う
  - [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457)
  - [RFC 9205: Building Protocols with HTTP](https://www.rfc-editor.org/rfc/rfc9205)
