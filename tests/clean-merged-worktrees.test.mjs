import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const entrypoint = path.join(root, 'bin', 'clean-merged-worktrees.sh')
const cronEntrypoint = path.join(root, 'bin', 'clean-merged-worktrees-cron.sh')

function run(command, args, options = {}) {
  const { env, clearEnv = [], ...spawnOptions } = options
  const childEnv = { ...process.env, ...env }
  for (const name of clearEnv) delete childEnv[name]
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...spawnOptions,
    env: childEnv,
  })
}

function must(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout || result.error || 'process did not start'}`)
  return result
}

function git(repo, args) {
  return must(run('git', ['-C', repo, ...args]), `git ${args.join(' ')}`)
}

async function makeCommittedRepo(parent, name = 'repo') {
  const repo = path.join(parent, name)
  await mkdir(repo, { recursive: true })
  must(run('git', ['init', '-q', repo]), 'git init')
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'cleanup-test'])
  await writeFile(path.join(repo, 'README'), 'fixture\n')
  git(repo, ['add', 'README'])
  git(repo, ['commit', '-qm', 'fixture'])
  return repo
}

async function addPrunableWorktree(repo) {
  const worktree = path.join(repo, '.worktree', 'stale')
  await mkdir(path.dirname(worktree), { recursive: true })
  git(repo, ['worktree', 'add', '-q', '-b', 'stale', worktree, 'HEAD'])
  await rm(worktree, { recursive: true, force: true })
  return worktree
}

async function makeRemoteCandidateRepo(parent, host = 'github.com') {
  const repo = await makeCommittedRepo(parent)
  const remote = path.join(parent, 'origin.git')
  const remoteUrl = `https://${host}/owner/repo.git`
  await mkdir(path.dirname(remote), { recursive: true })
  must(run('git', ['init', '-q', '--bare', remote]), 'git init bare remote')
  git(repo, ['branch', '-M', 'main'])
  git(repo, ['remote', 'add', 'origin', remoteUrl])
  git(repo, ['config', `url.${remote}.insteadOf`, remoteUrl])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const worktree = path.join(repo, '.worktree', 'feature')
  await mkdir(path.dirname(worktree), { recursive: true })
  git(repo, ['worktree', 'add', '-q', '-b', 'feature', worktree, 'main'])
  await writeFile(path.join(worktree, 'feature.txt'), 'feature\n')
  git(worktree, ['add', 'feature.txt'])
  git(worktree, ['commit', '-qm', 'feature'])
  return { repo, worktree }
}

function mergeCandidateIntoMain(repo) {
  git(repo, ['merge', '--no-ff', '-qm', 'merge feature', 'feature'])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['fetch', '-q', 'origin', 'main'])
}

function squashMergeCandidateIntoMain(repo) {
  git(repo, ['merge', '--squash', 'feature'])
  git(repo, ['commit', '-qm', 'squash merge feature'])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['fetch', '-q', 'origin', 'main'])
}

function mergeRemoteWithoutRefreshingLocalDefault(repo) {
  const base = git(repo, ['rev-parse', 'refs/heads/main']).stdout.trim()
  git(repo, ['merge', '--no-ff', '-qm', 'merge feature remotely', 'feature'])
  git(repo, ['push', '-q', 'origin', 'main'])
  git(repo, ['reset', '--hard', '-q', base])
  git(repo, ['update-ref', 'refs/remotes/origin/main', base])
  return { base }
}

test('removes a clean merged worktree and its local branch in apply mode', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-merged-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].action, 'deleted')
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.doesNotMatch(listing, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    const lockExists = await access(path.join(repo, '.git', 'clean-merged-worktrees.lock')).then(() => true).catch(() => false)
    assert.equal(lockExists, false)
    const headPath = path.resolve(repo, git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD']).stdout.trim())
    await assert.rejects(access(`${headPath}.lock`))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('refreshes a stale clean default branch before applying cleanup', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-refresh-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const { base } = mergeRemoteWithoutRefreshingLocalDefault(repo)
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), base)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].reason, 'merged')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), git(repo, ['ls-remote', 'origin', 'refs/heads/main']).stdout.split('\t', 1)[0])
    assert.equal(git(repo, ['rev-parse', 'refs/heads/main']).stdout.trim(), base)
    assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fetches a default branch when it is not checked out in a worktree', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-refresh-fetch-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    git(repo, ['switch', '-q', '-c', 'other'])
    git(repo, ['push', '-q', 'origin', 'feature:main'])
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/main'])
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--apply', '--json', '--default-branch', 'main'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].branch_delete_method, 'git-branch-d-in-authoritative-detached-worktree')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']).status, 0)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('warns and skips when unregistered content dirties the default branch', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-refresh-unregistered-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const unrelatedPath = path.join(repo, '.worktree', 'unregistered-note')
    await writeFile(unrelatedPath, 'do not ignore this\n')

    const result = run(entrypoint, ['--apply', '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 0)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.warnings, 1)
    assert.equal(summary.results[0].action, 'skip')
    assert.equal(summary.results[0].severity, 'warn')
    assert.equal(summary.results[0].reason, 'default-branch-dirty')
    assert.match(summary.results[0].detail, /default branch worktree is dirty/)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('warns and skips when the default branch worktree is dirty', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-refresh-dirty-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    await writeFile(path.join(repo, 'default-branch-dirty.txt'), 'do not overwrite\n')

    const result = run(entrypoint, ['--apply', '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 0)
    assert.equal(summary.skipped, 1)
    assert.equal(summary.warnings, 1)
    assert.equal(summary.results[0].action, 'skip')
    assert.equal(summary.results[0].severity, 'warn')
    assert.equal(summary.results[0].reason, 'default-branch-dirty')
    assert.match(summary.results[0].detail, /default branch worktree is dirty/)
    assert.match(summary.results[0].dirty_status, /未追跡 1件/)
    assert.equal(git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output explains which default-branch paths caused the dirty warning', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    await mkdir(path.join(repo, '.gocache', 'build'), { recursive: true })
    await writeFile(path.join(repo, '.gocache', 'build', 'cache-entry'), 'cache\n')

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /- warn: .* — default-branch-dirty/)
    assert.match(result.stdout, /検出: 未追跡 1件/)
    assert.match(result.stdout, /\.gocache\//)
    assert.match(result.stdout, /対応: .*変更内容を確認/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output counts tracked and deleted default-branch entries', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-tracked-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    await writeFile(path.join(repo, 'tracked.txt'), 'tracked\n')
    git(repo, ['add', 'tracked.txt'])
    git(repo, ['commit', '-qm', 'add tracked fixture'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin', 'main'])
    await writeFile(path.join(repo, 'README'), 'changed\n')
    git(repo, ['rm', '-q', 'tracked.txt'])

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /検出: .*変更 1件.*削除 1件/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output classifies both-added conflicts as conflicts', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-conflict-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const conflictPath = path.join(repo, 'both-added.txt')
    git(repo, ['switch', '-q', '-c', 'conflict-side'])
    await writeFile(conflictPath, 'side\n')
    git(repo, ['add', 'both-added.txt'])
    git(repo, ['commit', '-qm', 'add conflict file on side'])
    git(repo, ['switch', '-q', 'main'])
    await writeFile(conflictPath, 'main\n')
    git(repo, ['add', 'both-added.txt'])
    git(repo, ['commit', '-qm', 'add conflict file on main'])
    const merge = run('git', ['-C', repo, 'merge', 'conflict-side'])
    assert.notEqual(merge.status, 0, merge.stdout || merge.stderr || 'merge unexpectedly succeeded')

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /検出: 競合 1件/)
    assert.doesNotMatch(result.stdout, /検出: 追加 1件/)
    assert.match(result.stdout, /対応: 競合を解消するか/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output does not misclassify a failed status diagnostic as dirty state', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-status-error-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "status" ]; then
    printf '%s\\n' 'fatal: status diagnostic mentions worktree is dirty but status failed' >&2
    exit 97
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const result = run(cronEntrypoint, [], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /status diagnostic mentions worktree is dirty but status failed/)
    assert.doesNotMatch(result.stdout, /原因: default branchのworktreeに未コミットの変更または未追跡ファイルがあります/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps a dirty default-branch preflight error when remote metadata fails', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-remote-error-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    await writeFile(path.join(repo, 'remote-metadata-dirty.txt'), 'do not overwrite\n')
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
ls_remote_count='${fixtureRoot}/ls-remote-count'
if [ -f "$ls_remote_count" ]; then
  read ls_remote_calls <"$ls_remote_count"
else
  ls_remote_calls=0
fi
for argument in "$@"; do
  if [ "$argument" = "ls-remote" ]; then
    ls_remote_calls=$((ls_remote_calls + 1))
    printf '%s\\n' "$ls_remote_calls" >"$ls_remote_count"
    if [ "$ls_remote_calls" -ge 3 ]; then
      printf '%s\\n' 'simulated remote metadata failure' >&2
      exit 91
    fi
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.warnings, 0)
    assert.equal(summary.results[0].reason, 'remote-default-query-failed')
    assert.doesNotMatch(result.stdout, /default-branch-dirty/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps malformed successful status output on the error path', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-malformed-status-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "status" ]; then
    printf '%s\\n' 'not porcelain status output'
    exit 0
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.warnings, 0)
    assert.equal(summary.results[0].reason, 'default-branch-refresh-failed')
    assert.match(summary.results[0].detail, /unterminated|invalid porcelain record/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects semantically invalid, unterminated, and clean porcelain records', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-status-records-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "status" ]; then
    case "$STATUS_MODE" in
      invalid-code) printf '%s\\0' '?! bad' ;;
      missing-nul) printf '%s' '?? bad' ;;
      clean-record) printf '%s\\0' '   clean' ;;
    esac
    exit 0
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const cases = [
      ['invalid-code', /invalid status code/],
      ['missing-nul', /unterminated porcelain stream/],
      ['clean-record', /invalid status code/],
    ]
    for (const [mode, detailPattern] of cases) {
      const result = run(entrypoint, ['--apply', '--json'], {
        env: {
          GIT_REPOSITORIES_ROOT: fixtureRoot,
          PATH: `${fakeBin}:${process.env.PATH}`,
          STATUS_MODE: mode,
        },
      })
      assert.equal(result.status, 1, result.stderr || result.stdout || result.error || `process did not start for ${mode}`)
      const summary = JSON.parse(result.stdout)
      assert.equal(summary.errors, 1)
      assert.equal(summary.warnings, 0)
      assert.equal(summary.results[0].reason, 'default-branch-refresh-failed')
      assert.match(summary.results[0].detail, detailPattern)
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps a malformed default-worktree HEAD identity on the error path', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-missing-head-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    const listCount = path.join(fixtureRoot, 'worktree-list-count')
    await writeFile(fakeGit, `#!/bin/sh
count_file='${listCount}'
for argument in "$@"; do
  if [ "$argument" = "list" ]; then
    count=0
    [ -f "$count_file" ] && count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s\\n' "$count" >"$count_file"
    if [ "$count" -ge 3 ]; then
      printf 'worktree ${repo}\\0branch refs/heads/main\\0\\0'
      exit 0
    fi
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.warnings, 0)
    assert.equal(summary.results[0].reason, 'default-branch-refresh-failed')
    assert.match(summary.results[0].detail, /identity is malformed/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps a default-worktree branch switch race on the error path', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-dirty-race-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = must(run('which', ['git']), 'which git').stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "status" ]; then
    '${realGit}' -C '${repo}' switch -q -c other
    printf '%s\\n' 'race' >'${repo}/race.txt'
  fi
done
exec '${realGit}' \"$@\"
`)
    await chmod(fakeGit, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.warnings, 0)
    assert.equal(summary.results[0].reason, 'default-branch-refresh-failed')
    assert.match(summary.results[0].detail, /identity changed/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output counts a rename once in the default-branch dirty summary', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-rename-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    await writeFile(path.join(repo, 'aa old'), 'fixture\n')
    git(repo, ['add', 'aa old'])
    git(repo, ['commit', '-qm', 'add rename fixture'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin', 'main'])
    git(repo, ['mv', 'aa old', 'renamed'])

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /検出: 名前変更 1件/)
    assert.doesNotMatch(result.stdout, /検出: 名前変更 1件、変更 1件/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output counts a copy once in the default-branch dirty summary', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-copy-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    await writeFile(path.join(repo, 'aa old'), 'fixture\n')
    git(repo, ['add', 'aa old'])
    git(repo, ['commit', '-qm', 'add copy fixture'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin', 'main'])
    git(repo, ['config', 'status.renames', 'copies'])
    await writeFile(path.join(repo, 'aa old'), 'changed\n')
    git(repo, ['add', 'aa old'])
    await writeFile(path.join(repo, 'copy'), 'fixture\n')
    git(repo, ['add', 'copy'])

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /検出: (?:コピー 1件、変更 1件|変更 1件、コピー 1件)/)
    assert.match(result.stdout, /(?:主な場所: |、)aa old \(1件\)/)
    assert.doesNotMatch(result.stdout, /(?:主な場所: |、)old \(1件\)/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron output escapes and bounds dirty path locations', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-path-detail-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const dirtyName = `odd\nname${'x'.repeat(200)}`
    await writeFile(path.join(repo, dirtyName), 'untracked\n')

    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /検出: 未追跡 1件/)
    assert.match(result.stdout, /odd\\nname/)
    assert.match(result.stdout, /…/)
    assert.doesNotMatch(result.stdout, new RegExp(dirtyName.replace('\n', '\\n')))
    assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('  検出:')).length, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('does not refresh a stale default branch during dry-run', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-refresh-dry-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const { base } = mergeRemoteWithoutRefreshingLocalDefault(repo)

    const result = run(entrypoint, ['--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'local-default-stale')
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), base)
    assert.equal(git(repo, ['rev-parse', 'refs/heads/main']).stdout.trim(), base)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('removes the local branch after a GitHub-confirmed squash merge', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-squash-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    const mergeCommit = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, `#!/bin/sh
set -eu
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"commits":[{"oid":"${head}"}],"mergeCommit":{"oid":"${mergeCommit}"}}'
  exit 0
fi
exit 1
`)
    await chmod(fakeGh, 0o755)
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].reason, 'merged')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.doesNotMatch(listing, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('holds the branch ref transaction while fencing concurrent branch checkout', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-branch-race-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    const mergeCommit = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const racePath = path.join(repo, '.worktree', 'race')
    const raceStatus = path.join(fixtureRoot, 'race-status')
    const raceOutput = path.join(fixtureRoot, 'race-output')
    const transactionMarker = path.join(fixtureRoot, 'transaction-started')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -u
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
race_path=${JSON.stringify(racePath)}
race_status=${JSON.stringify(raceStatus)}
race_output=${JSON.stringify(raceOutput)}
transaction_marker=${JSON.stringify(transactionMarker)}
if [ "$1" = "-C" ]; then
  invoked_repo="$2"
  shift 2
else
  printf '%s\\n' 'unexpected git invocation' >&2
  exit 99
fi
if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ]; then
  touch "$transaction_marker"
  exec "$real_git" -C "$invoked_repo" "$@"
fi
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ -e "$transaction_marker" ]; then
  "$real_git" -C "$repo" worktree add --force "$race_path" feature >"$race_output" 2>&1
  printf '%s' "$?" >"$race_status"
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, `#!/bin/sh
set -eu
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"commits":[{"oid":"${head}"}],"mergeCommit":{"oid":"${mergeCommit}"}}'
  exit 0
fi
exit 1
`)
    await chmod(fakeGh, 0o755)
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    let raceStatusValue = null
    for (let attempt = 0; attempt < 100 && raceStatusValue === null; attempt += 1) {
      try {
        raceStatusValue = (await readFile(raceStatus, 'utf8')).trim()
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.notEqual(raceStatusValue, null)
    assert.notEqual(raceStatusValue, '0')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).stdout.includes(`${path.sep}race\n`), false)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('restores the branch when post-delete ref verification is indeterminate', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-branch-verify-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    const mergeCommit = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const verificationMarker = path.join(fixtureRoot, 'branch-delete-committed')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
marker=${JSON.stringify(verificationMarker)}
if [ "$1" = "-C" ]; then
  repo="$2"
  shift 2
else
  printf '%s\\n' 'unexpected git invocation' >&2
  exit 99
fi
if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ]; then
  "$real_git" -C "$repo" "$@"
  status=$?
  if [ "$status" -eq 0 ]; then touch "$marker"; fi
  exit "$status"
fi
if [ -f "$marker" ] && [ "$1" = "show-ref" ] && [ "$2" = "--verify" ] && [ "$3" = "--quiet" ] && [ "$4" = "refs/heads/feature" ]; then
  printf '%s\\n' 'injected post-delete verification failure' >&2
  exit 2
fi
exec "$real_git" -C "$repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, `#!/bin/sh
set -eu
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"commits":[{"oid":"${head}"}],"mergeCommit":{"oid":"${mergeCommit}"}}'
  exit 0
fi
exit 1
`)
    await chmod(fakeGh, 0o755)
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'branch-delete-unverified')
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/feature']).stdout.trim(), head)
    assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('removes ignored files from a disposable merged worktree', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-ignored-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    await writeFile(path.join(worktree, '.gitignore'), 'build/\n')
    git(worktree, ['add', '.gitignore'])
    git(worktree, ['commit', '-qm', 'ignore build output'])
    mergeCandidateIntoMain(repo)
    const ignoredPath = path.join(worktree, 'build', 'output.bin')
    await mkdir(path.dirname(ignoredPath), { recursive: true })
    await writeFile(ignoredPath, 'local build output\n')
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].action, 'deleted')
    assert.equal(summary.results[0].reason, 'merged')
    assert.deepEqual(summary.results[0].ignored_files_removed, {
      before_quarantine: '1 ignored path',
      after_quarantine: '1 ignored path',
    })
    assert.equal(await access(ignoredPath).then(() => true).catch(() => false), false)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron wrapper removes ignored files from a disposable merged worktree', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-ignored-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    await writeFile(path.join(worktree, '.gitignore'), 'node_modules/\n')
    git(worktree, ['add', '.gitignore'])
    git(worktree, ['commit', '-qm', 'ignore dependencies'])
    mergeCandidateIntoMain(repo)
    const ignoredPath = path.join(worktree, 'node_modules', 'fixture.txt')
    await mkdir(path.dirname(ignoredPath), { recursive: true })
    await writeFile(ignoredPath, 'rebuildable dependency\n')
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)
    const result = run(cronEntrypoint, [], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /- deleted: .* — merged/)
    assert.match(result.stdout, /ignored removed: 1 ignored path before quarantine, 1 ignored path after quarantine/)
    assert.doesNotMatch(result.stdout, /ignored-files-present/)
    assert.equal(await access(ignoredPath).then(() => true).catch(() => false), false)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fails closed when another cleanup process holds the repository lock', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-lock-'))
  try {
    const repo = await makeCommittedRepo(fixtureRoot)
    const lockPath = path.join(repo, '.git', 'clean-merged-worktrees.lock')
    await writeFile(lockPath, 'held by fixture\n')
    const result = run(entrypoint, ['--apply', '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'cleanup-lock-unavailable')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('accepts explicit paths and help when HOME-based defaults are unavailable', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-no-home-'))
  try {
    const options = {
      clearEnv: ['HOME', 'GIT_REPOSITORIES_ROOT', 'HERMES_DEV_ROOT'],
    }
    const help = run(entrypoint, ['--help'], options)
    assert.equal(help.status, 0, help.stderr || help.stdout || help.error || 'process did not start')
    const result = run(entrypoint, ['--root', fixtureRoot, '--json'], options)
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.equal(JSON.parse(result.stdout).root, fixtureRoot)
    const repo = await makeCommittedRepo(fixtureRoot, 'explicit-repo')
    const explicitRepo = run(entrypoint, ['--repo', repo, '--json'], options)
    assert.equal(explicitRepo.status, 0, explicitRepo.stderr || explicitRepo.stdout || explicitRepo.error || 'process did not start')
    assert.equal(JSON.parse(explicitRepo.stdout).repositories_checked, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('reports GitHub query failure as an error instead of a successful skip', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-gh-failure-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, '#!/bin/sh\nprintf "%s\\n" "simulated gh failure" >&2\nexit 42\n')
    await chmod(fakeGh, 0o755)
    const result = run(entrypoint, ['--repo', repo, '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].action, 'error')
    assert.equal(summary.results[0].reason, 'github-query-failed')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('reports schema-invalid GitHub JSON as a structured error', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-gh-invalid-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, '#!/bin/sh\nprintf "%s\\n" "{}"\n')
    await chmod(fakeGh, 0o755)
    const result = run(entrypoint, ['--repo', repo, '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].action, 'error')
    assert.equal(summary.results[0].reason, 'github-invalid-response')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects remote hostnames that only contain github.com as a substring', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-hostname-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot, 'evilgithub.com')
    const result = run(entrypoint, ['--repo', repo, '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'non-github-origin')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects a GitHub mergeCommit ref instead of treating it as an object ID', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-oid-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeGh = path.join(fakeBin, 'gh')
    await writeFile(fakeGh, `#!/bin/sh
set -eu
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"mergeCommit":{"oid":"refs/heads/main"},"commits":[{"oid":"${head}"}]}'
  exit 0
fi
exit 1
`)
    await chmod(fakeGh, 0o755)
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'github-invalid-response')
    assert.equal(git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fails closed when Docker CLI startup fails during apply', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-docker-missing-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const minimalBin = path.join(fixtureRoot, 'minimal-bin')
    await mkdir(minimalBin, { recursive: true })
    const gitPath = run('sh', ['-c', 'command -v git']).stdout.trim()
    const dirnamePath = run('sh', ['-c', 'command -v dirname']).stdout.trim()
    await symlink(process.execPath, path.join(minimalBin, 'node'))
    await symlink(gitPath, path.join(minimalBin, 'git'))
    await symlink(dirnamePath, path.join(minimalBin, 'dirname'))
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: minimalBin,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'compose-query-failed')
    assert.equal(git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('blocks Compose teardown when a project name is shared with another worktree', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-compose-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    mergeCandidateIntoMain(repo)
    const foreignWorktree = path.join(fixtureRoot, 'foreign', '.worktree', 'feature')
    const composeFile = path.join(worktree, 'compose.yml')
    const foreignComposeFile = path.join(foreignWorktree, 'compose.yml')
    const candidateInspect = JSON.stringify([{
      Config: {
        Labels: {
          'com.docker.compose.project': 'shared-project',
          'com.docker.compose.project.working_dir': worktree,
          'com.docker.compose.project.config_files': composeFile,
        },
      },
      Mounts: [],
    }])
    const foreignInspect = JSON.stringify([{
      Config: {
        Labels: {
          'com.docker.compose.project': 'shared-project',
          'com.docker.compose.project.working_dir': foreignWorktree,
          'com.docker.compose.project.config_files': foreignComposeFile,
        },
      },
      Mounts: [],
    }])
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, `#!/bin/sh
set -eu
if [ "$1" = "ps" ]; then
  printf '%s\\n' candidate-container foreign-container
  exit 0
fi
if [ "$1" = "inspect" ]; then
  case "$2" in
    candidate-container) printf '%s\\n' '${candidateInspect}' ;;
    foreign-container) printf '%s\\n' '${foreignInspect}' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
printf '%s\\n' 'unexpected compose teardown' >&2
exit 99
`)
    await chmod(fakeDocker, 0o755)
    const result = run(entrypoint, ['--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'compose-identity-mismatch')
    assert.equal(git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('prunes stale registrations through the portable apply entrypoint', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-apply-'))
  try {
    const repo = await makeCommittedRepo(fixtureRoot)
    const stalePath = await addPrunableWorktree(repo)
    const result = run(entrypoint, ['--apply', '--cron'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /- pruned: .* — prunable/)
    assert.match(result.stdout, /prune済み: 1/)
    assert.doesNotMatch(result.stdout, /skip: .*prunable/)
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.doesNotMatch(listing, new RegExp(stalePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/stale']).status, 0)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('dry-run reports stale registrations without mutating them', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-dry-'))
  try {
    const repo = await makeCommittedRepo(fixtureRoot)
    const stalePath = await addPrunableWorktree(repo)
    const result = run(entrypoint, ['--cron'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /- would-prune: .* — prunable/)
    assert.match(result.stdout, /prune予定: 1/)
    assert.doesNotMatch(result.stdout, /error:/)
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.match(listing, /prunable/)
    assert.match(listing, new RegExp(stalePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps an empty repository as a visible successful skip', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-empty-'))
  try {
    const repo = path.join(fixtureRoot, 'empty')
    const remote = path.join(fixtureRoot, 'origin.git')
    must(run('git', ['init', '-q', '--bare', remote]), 'git init bare remote')
    must(run('git', ['init', '-q', repo]), 'git init empty repo')
    git(repo, ['remote', 'add', 'origin', remote])
    await mkdir(path.join(repo, '.worktree'), { recursive: true })
    git(repo, ['worktree', 'add', '--orphan', '-b', 'orphan', '-q', path.join(repo, '.worktree', 'orphan')])

    const result = run(entrypoint, ['--cron'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /skip: .* — empty-repository/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps an unborn repository with remote refs on the error path', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-uncertain-'))
  try {
    const seed = await makeCommittedRepo(fixtureRoot, 'seed')
    const remote = path.join(fixtureRoot, 'origin.git')
    must(run('git', ['init', '-q', '--bare', remote]), 'git init bare remote')
    git(seed, ['branch', '-M', 'main'])
    git(seed, ['remote', 'add', 'origin', remote])
    git(seed, ['push', '-q', 'origin', 'main'])
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main'])

    const repo = path.join(fixtureRoot, 'empty-root')
    must(run('git', ['init', '-q', repo]), 'git init unborn repo')
    git(repo, ['remote', 'add', 'origin', remote])
    await mkdir(path.join(repo, '.worktree'), { recursive: true })
    git(repo, ['worktree', 'add', '--orphan', '-b', 'orphan', '-q', path.join(repo, '.worktree', 'orphan')])

    const result = run(entrypoint, ['--cron'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /error: .* — default-branch-not-found/)
    assert.doesNotMatch(result.stdout, /empty-repository/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron wrapper applies the same prune-first contract without arguments', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-cron-'))
  try {
    const repo = await makeCommittedRepo(fixtureRoot)
    const stalePath = await addPrunableWorktree(repo)
    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.match(result.stdout, /- pruned: .* — prunable/)
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.doesNotMatch(listing, new RegExp(stalePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('cron wrapper has a side-effect-free help path and rejects arguments', () => {
  const help = run(cronEntrypoint, ['--help'])
  assert.equal(help.status, 0, help.stderr || help.stdout || help.error || 'process did not start')
  assert.match(help.stdout, /Usage: clean-merged-worktrees-cron\.sh/)

  const invalid = run(cronEntrypoint, ['--unexpected'])
  assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout || invalid.error || 'process did not start')
})
