---
name: development-application
description: 'アプリケーションの作成/開発時に参照する全般に適用される方針。互換性より最適な実装を優先する。実装完了時にlint/format/build/testの実行と結果報告を行う。'
---

## General Guidelines

- 互換性を考慮した実装をしない。課題に対して0ベースで最適な実装を選択する
- 既存実装の延命より作り直しを優先する
- 移行コストより新規実装の保守性と単純性を優先する
- 互換レイヤーや段階的フォールバックを追加しない
- O(N) となる処理を避け、O(1) となるように処理を記述する
- ループ処理の内部でSQLのINSERT/UPDATE/DELETEを繰り返し実行することを禁じる

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
