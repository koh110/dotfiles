# Technical investigation

仕様書に採用する外部service、API、runtime capabilityは、実装フェーズへ渡す前に実現可能性を確認します。

## Sources

優先順:

1. currentな公式documentation
2. installed SDK/type definition/schema
3. side effectを起こさない検証command/probe
4. verified repository implementation

training knowledgeだけを根拠にcurrentな外部contractを固定しません。

## Procedure

- 必要なAPI/capabilityが現在存在するか確認する。
- 見つかった制約に後継service/new featureがないか確認する。
- authentication、quota、runtime、region、delivery semantics等、設計を分岐させる制約を記録する。
- 検証結果とsource URL/path/commandをspecへ残す。
- 実装時判断へ保留する場合は、候補・判断基準・調査方法をspecへ残す。

技術制約を未検証のまま回避architectureへ固定しないでください。
