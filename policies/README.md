# Policies

`policies/` は、modelやruntimeに依存しない **個人・repositoryのworking agreement** を置く場所です。

Skillとの違い:

- Skill: 特定taskで必要になる知識・workflow
- Policy: taskをまたいで守らせたい選好・品質基準・decision boundary

Policyにはmodel固有の癖を補う指示を入れません。model差は `profiles/` へ分離します。

現在のpolicy:

- `development.md`: 実装方針、scope、completion、decision boundary
- `review.md`: 独立reviewを必須にする条件とreviewer qualification
- `specification.md`: 仕様化を必須にする条件とユーザー決定の扱い
- `git-workflow.md`: dedicated worktree、branch、commit/push/cleanupの個人運用
