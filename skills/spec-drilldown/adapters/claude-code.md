# Claude Code adapter

For new applications, features, APIs, CLIs, major UI flows, or architecture changes, evaluate `../policies/default.md` before implementation.

If specification is required:
- load `../SKILL.md`
- load the policy
- load an exact matching model profile under `../profiles/` only when the active model identity is known

Use references progressively; do not preload all specification references for unrelated tasks.
