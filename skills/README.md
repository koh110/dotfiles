# Skills policy

`skills/` is the source of truth for reusable skills that should work across multiple agent runtimes.

## Format

Use the open [Agent Skills](https://agentskills.io/) `SKILL.md` format as the portability baseline.

For shared skills:

- keep `name` and `description` portable and runtime-neutral;
- prefer standard Agent Skills frontmatter fields only;
- do not add Hermes-, Codex-, Claude Code-, Copilot-, or other runtime-specific frontmatter namespaces or syntax;
- keep runtime-specific delivery, scheduler, tool, transport, and installation details outside the shared semantic core;
- put runtime-specific behavior in the relevant adapter/configuration layer when it cannot be expressed portably;
- keep references and scripts relative to the skill directory so consumers can install the directory as a self-contained bundle.

A minimal portable skill looks like this:

```markdown
---
name: example-skill
description: Describe what this skill does and when an agent should use it.
---

# Example Skill

Instructions shared by all supported agents go here.
```

Optional standard fields such as `license` may be used when needed. Avoid adding metadata merely because one runtime understands it.

## Runtime boundary

The shared skill defines the reusable workflow, invariants, and domain knowledge. Runtime adapters are responsible for details such as:

- where skills are installed or discovered;
- scheduler/job configuration;
- chat/thread delivery semantics;
- runtime-specific tool names and permission syntax;
- model/provider pinning mechanisms;
- platform-specific commands or APIs.

When a shared skill needs to mention a runtime capability, describe the capability generically (for example, "when the runtime supports per-job model selection") rather than requiring one product's syntax.
