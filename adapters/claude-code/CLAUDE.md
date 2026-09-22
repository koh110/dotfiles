# Global agent guidance

このファイルはClaude Code向けの薄いdiscovery routerです。taskと無関係なskill packageを先読みしないでください。

## Skill package loading

taskに該当する `~/.claude/skills/<skill>/SKILL.md` を使います。

そのskill directoryに以下が存在する場合:

- `policies/default.md`: このskillを使うときのworking agreementとして読む。
- `profiles/<provider>/<exact-model>.md`: runtimeからexact active model identityが分かり、完全一致するfileがある場合だけ読む。
- `adapters/claude-code.md`: Claude Code固有差分として読む。

exact model profileが無い場合は近いmodelのprofileを推測適用しません。

## Common activation

- application/code変更: `development-application`
- git操作・repository内の編集: `git-workflow`
- code review gateの判定/実行: `code-review`
- 新規機能・architectureの仕様化: `spec-drilldown`

## Boundary

Claude Code固有のpermission/tool/worktree/discoveryだけをadapterで扱い、portable `SKILL.md` へ書き戻しません。
