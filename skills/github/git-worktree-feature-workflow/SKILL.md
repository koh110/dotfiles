---
name: git-worktree-feature-workflow
description: Use when starting new feature or bug-fix work in a repo that uses `.worktree/`. Creates a dedicated worktree first and keeps feature edits out of the main checkout.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [github, git, worktree, feature-branch, workflow]
    related_skills: [github-pr-workflow, github-repo-management]
---

# Git worktree feature workflow

Use this workflow whenever a task is a new feature, bug fix, or refactor in a repo that follows a `.worktree/` convention.

## When to Use
- The user asks for new code or a non-trivial fix
- The repository already has a `.worktree/` directory or team convention for worktrees
- You are about to edit tracked files in the main checkout

## Workflow

### 1) Inspect the current workspace first

Before editing anything, check:

```bash
git worktree list
git status --short
```

Confirm whether you are already in a dedicated worktree.

### 2) Create a dedicated worktree before editing

If this is feature work, create a new branch and worktree under `.worktree/`.

```bash
git worktree add -b feature/<short-name> .worktree/<short-name> HEAD
```

Keep the branch name aligned with the task.

### 3) If edits already started in the wrong checkout

If you accidentally started editing the root checkout:

1. Stop editing the root checkout.
2. Create the proper worktree.
3. Transplant the changes into the new worktree.
4. Leave the root checkout alone until the feature work is done.

### 4) Work only inside the dedicated worktree

Use the worktree for:
- code edits
- tests, lint, and builds
- follow-up fixes

Do not continue feature edits in the repository root checkout.

### 5) Verify isolation

Before finishing, verify:

```bash
git status --short
git worktree list
```

The worktree should contain only the intended task changes, and the main checkout should not be the place where the feature was developed.

## Common Pitfalls
1. **Treating a dirty root checkout as acceptable.**
   - Always confirm where you are before editing.

2. **Assuming `.worktree/` means you are already using it.**
   - You still need to create and switch to the dedicated worktree.

3. **Forgetting untracked files when transplanting changes.**
   - Move both tracked and untracked files.

4. **Accidentally mixing root-checkout changes with feature work.**
   - Keep the root checkout untouched after the worktree is created.

## Verification Checklist
- [ ] `git worktree list` shows the dedicated worktree
- [ ] `git status --short` in the worktree shows only intended changes
- [ ] Feature edits live inside `.worktree/`
- [ ] The main checkout is not used for feature implementation
