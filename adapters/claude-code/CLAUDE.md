# Global agent guidance

このファイルはClaude Code向けの薄いrouterです。taskと無関係なpolicyやskillを先読みしないでください。

## Policies

必要な場合だけ次を読む:

- application/code変更: `~/.claude/policies/development.md`
- 独立reviewの要否・reviewer条件: `~/.claude/policies/review.md`
- 新規機能・architectureの仕様化: `~/.claude/policies/specification.md`

## Skills

task-specificなdomain knowledge/workflowは `~/.claude/skills/` の該当skillを使う。Skillはpolicyやmodel behaviorの代替ではない。

## Model profile

runtimeからexactなactive model identityが分かり、`~/.claude/profiles/` に完全一致するprofileがある場合だけ、そのprofileを追加overlayとして読む。完全一致しない場合はprofileを推測して適用しない。

## Boundary

Claude Code固有のworktree/tool/permission挙動はこのadapter/runtime設定で扱い、portable skillへ書き戻さない。
