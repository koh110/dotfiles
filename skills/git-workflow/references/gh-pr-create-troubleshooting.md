# gh pr create troubleshooting

Observed in this session:

- `gh pr create` can fail with `Head sha can't be blank, Base sha can't be blank, No commits between main and feature/...` when gh resolves the wrong repository context.
- In that case, specify both the repository and head branch explicitly:

```bash
gh pr create \
  -R OWNER/REPOSITORY \
  --draft \
  --base main \
  --head feature/example-change \
  --title "feat: improve 4xx observability" \
  --body "..."
```

Verification checklist:

1. `git branch --show-current` is the feature branch.
2. `git rev-parse HEAD` is the commit you pushed.
3. `git push -u origin HEAD` succeeded before creating the PR.
4. Use `-R owner/repo` whenever the gh default repo lookup is ambiguous.
