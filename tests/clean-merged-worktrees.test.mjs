import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('preserves ignored files and reports the merged worktree as a skip', async () => {
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
    const result = run(entrypoint, ['--apply', '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 0)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].action, 'skip')
    assert.equal(summary.results[0].reason, 'ignored-files-present')
    assert.equal(await access(ignoredPath).then(() => true).catch(() => false), true)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
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
