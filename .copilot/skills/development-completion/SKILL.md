---
name: development-completion
description: '実装完了時に実行する検証手順。lint/build/testの実行と結果報告を行う。'
---

- 実装完了後に必ずlint/build/testを実行し、エラーが発生しなくなるまで修正を行う
  - testやlintの実行はciのコマンドを参照して実行する
  - lintのエラーの場合まずは自動修正を試みる
- 実現した仕様を最後に簡潔に説明する
