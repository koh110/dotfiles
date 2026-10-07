# PR targeting harness

Use this when more than one repo or PR is active in the same session.

## Safe mutation loop

1. Restate the target as `owner/repo#number` or a full PR URL.
2. Verify the target with `gh pr view -R owner/repo number` before making changes.
3. Apply the mutation.
4. Re-fetch the same PR and confirm the URL, repo, branch, and body.

## Rules of thumb

- Never rely on the current checkout alone when repo context matters.
- Never reuse a PR number from another repository without `-R`.
- If the user names a repository, treat that repo as the only valid target until done.
- For body rewrites, use a file and `gh pr edit --body-file`.

## Typical failure modes this catches

- Editing the wrong repo's PR because two PRs were open in the same session.
- Assuming the current branch implies the current GitHub repository.
- Incremental body edits drifting from the real request.
