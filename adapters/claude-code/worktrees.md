# Claude Code worktree adapter

Claude Codeなどのharnessが事前にlinked worktreeを用意する場合、pathが個人policyの `.worktree/` conventionと異なっていても、それだけを理由に新しいworktreeを作りません。

例として `.claude/worktrees/<name>/` のようなruntime-owned pathが存在し得ます。

判定はpath文字列ではなくGit metadataで行います。

```bash
git_dir=$(git rev-parse --path-format=absolute --git-dir)
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
```

`git_dir != common_dir` なら既存linked worktreeとして扱い、user policyが「既存linked worktreeを再利用」と定める場合はそのまま使います。
