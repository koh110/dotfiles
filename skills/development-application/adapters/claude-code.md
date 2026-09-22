# Claude Code adapter

Trigger this skill for application/code implementation, refactoring, and bugfix work.

When triggered:
- load `../SKILL.md`
- load `../policies/default.md`
- if the exact active model has a matching file under `../profiles/`, load only that exact profile

Do not apply a nearby model profile by family/provider guess.
