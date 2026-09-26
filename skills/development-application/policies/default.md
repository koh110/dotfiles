# Development policy

このpolicyは `development-application` skillに紐づくworking agreementです。

## Scope and implementation choices

- 明示されたPR target/baseがある場合はそれを起点にし、未指定の場合だけauthoritative remote metadataからdefault branchを解決する。
- 目的・acceptance criteriaに不要な変更を混ぜない。
- speculativeな将来互換性のためのcompatibility layerやfallbackを追加しない。
- 既存実装の維持自体を目的にせず、現在の要件に対して単純で保守しやすい設計を優先する。
- ただし「作り直し」を理由にscope外の変更を増やさない。採用した設計を実現するための最小diffにする。

## Decision boundary

- repository調査、公式資料、schema、実データ確認で決められる事項はユーザーへ質問せず調査する。
- reversibleで局所的な実装判断はagentが進めてよい。
- product semantics、公開API、data migration、破壊的変更、security boundaryなど、複数案が成立し結果が長く残る判断はユーザー決定として扱う。
- 観測事実と推論を分離し、未観測の原因を確定事項として扱わない。

## Change completeness

- 1箇所の修正がpattern由来なら、同一patternがrepo内に残っていないか確認する。
- 対称性のある兄弟概念がある場合、片側だけ修正してよいか確認する。
- 別approachへ置き換えた場合、旧approachの生成物・config・docsが不要になっていないか棚卸しする。

## Completion

- 「実装を書いた」ではなく、依頼のDefinition of Doneとacceptance criteriaを満たした時点を完了とする。
- 変更に影響するlint/typecheck/build/testを実行し、今回の変更が原因のfailureは修正して再検証する。
- 変更種別に応じたdomain-specific verificationを実行し、適用対象外の場合はN/A理由を独立reviewのinputsへ記録する。
- taskに無関係な重い検証を儀式的に全実行すること自体を目的にしない。repositoryが必須gateを定義している場合はそれを優先する。
- 完了報告では、確認したことと確認していないことを区別する。
