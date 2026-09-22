# Codex adapter

Trigger this skill for Git operations and for repository edits that may later be committed or reviewed.

When triggered:
- load `../SKILL.md`
- load `../policies/default.md`
- determine worktree state from Git metadata rather than directory naming

Codex-specific permission behavior belongs to runtime configuration, not to the portable Git contract.
