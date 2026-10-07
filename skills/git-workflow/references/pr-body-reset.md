# PR body reset pattern

When a PR body needs to be rewritten from scratch, prefer a temporary file and `gh pr edit --body-file`.

## Why
- Markdown backticks, code fences, and shell metacharacters can break inline `--body` quoting.
- Rewriting the entire body is safer than patching the old one in place when the user asks to "start over".
- Re-fetching the PR body after editing confirms the change landed exactly as intended.

## Recipe
1. Write the new body to a temp file.
2. Edit the PR with `gh pr edit <number> --body-file <tempfile>`.
3. Re-read the PR body with `gh pr view <number> --json body`.

## Related pitfalls
- Do not incremental-patch a stale body when the user asked for a fresh rewrite.
- Do not paste Markdown bodies directly into shell-quoted command strings unless necessary.
- If the body includes code or backticks, always prefer the file-based path.
