# Global agent guidance

このファイルはCodex向けの薄いrouterです。taskと無関係なpolicyやskillを先読みしないでください。

## Policies

必要な場合だけ次を読む:

- application/code変更: `~/.codex/policies/development.md`
- 独立reviewの要否・reviewer条件: `~/.codex/policies/review.md`
- 新規機能・architectureの仕様化: `~/.codex/policies/specification.md`

## Skills

task-specificなdomain knowledge/workflowは `~/.codex/skills/` の該当skillを使う。Skillはpolicyやmodel behaviorの代替ではない。

## Model profile

runtimeからexactなactive model identityが分かり、`~/.codex/profiles/` に完全一致するprofileがある場合だけ、そのprofileを追加overlayとして読む。完全一致しない場合はprofileを推測して適用しない。

## Boundary

Codex固有のpermission/tool挙動はこのadapter/runtime設定で扱い、portable skillへ書き戻さない。
