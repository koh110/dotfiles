# Claude Code adapter

Trigger this skill for Git operations and for repository edits that may later be committed or reviewed.

When triggered:
- load `../SKILL.md`
- load `../policies/default.md`
- determine worktree state from Git metadata rather than directory naming

Claude Code may create linked worktrees under runtime-owned paths such as `.claude/worktrees/<name>/`. If `git_dir != common_dir`, treat it as an existing linked worktree and follow the policy to reuse it instead of creating another worktree.
