import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const entrypoint = path.join(root, 'bin', 'clean-merged-branches.sh')
const cronEntrypoint = path.join(root, 'bin', 'clean-merged-branches-cron.sh')

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
    const lockExists = await access(path.join(repo, '.git', 'clean-merged-branches.lock')).then(() => true).catch(() => false)
    assert.equal(lockExists, false)
    const headPath = path.resolve(repo, git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'HEAD']).stdout.trim())
    await assert.rejects(access(`${headPath}.lock`))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('deletes a clean squash-merged worktree without PR evidence', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-patch-equivalence-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const ghLog = path.join(fixtureRoot, 'gh.log')
    await writeLoggingGh(fakeBin, ghLog, [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].evidence.method, 'patch-equivalence')
    assert.equal(summary.results[0].evidence.commit_count, 1)
    assert.equal(summary.results[0].branch_delete_method, 'git-update-ref-transaction-cas-with-patch-equivalence-evidence')
    assert.equal((await ghCalls(ghLog)).length, 1)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects malformed git cherry output before deleting a worktree', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-malformed-cherry-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
if [ "$1" != "-C" ]; then exit 99; fi
repo="$2"
shift 2
if [ "$1" = "cherry" ]; then
  printf '%s\\n\\n' '- ${head}'
  exit 0
fi
exec "$real_git" -C "$repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    const ghLog = path.join(fixtureRoot, 'gh.log')
    await writeLoggingGh(fakeBin, ghLog, [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'patch-equivalence-query-failed')
    assert.equal(summary.results[0].action, 'error')
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/feature']).stdout.trim(), head)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fences the default ref while deleting a patch-equivalent branch', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-default-fence-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const preMergeHead = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    const mergeHead = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const transactionMarker = path.join(fixtureRoot, 'transaction-started')
    const resetStatus = path.join(fixtureRoot, 'default-reset-status')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -u
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
marker=${JSON.stringify(transactionMarker)}
reset_status=${JSON.stringify(resetStatus)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ]; then
  touch "$marker"
  exec "$real_git" -C "$invoked_repo" "$@"
fi
if [ "$1" = "cherry" ] && [ -f "$marker" ]; then
  "$real_git" -C "$invoked_repo" "$@"
  cherry_status=$?
  "$real_git" -C "$repo" update-ref refs/remotes/origin/main ${JSON.stringify(preMergeHead)} >/dev/null 2>&1
  printf '%s\\n' "$?" > "$reset_status"
  exit "$cherry_status"
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    const ghLog = path.join(fixtureRoot, 'gh.log')
    await writeLoggingGh(fakeBin, ghLog, [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.notEqual((await readFile(resetStatus, 'utf8')).trim(), '0')
    assert.equal(git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim(), mergeHead)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects a replacement worktree at the quarantine path before removal', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-quarantine-race-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const transactionMarker = path.join(fixtureRoot, 'transaction-started')
    const replacementMarker = path.join(fixtureRoot, 'replacement-created')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
transaction_marker=${JSON.stringify(transactionMarker)}
replacement_marker=${JSON.stringify(replacementMarker)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ]; then
  touch "$transaction_marker"
  exec "$real_git" -C "$invoked_repo" "$@"
fi
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ -f "$transaction_marker" ] && [ ! -f "$replacement_marker" ]; then
  touch "$replacement_marker"
  quarantine=''
  for candidate in "$repo"/.worktree/.cleanup-*; do
    if [ -d "$candidate" ]; then quarantine="$candidate"; break; fi
  done
  test -n "$quarantine"
  "$real_git" -C "$repo" worktree remove -f -f "$quarantine"
  "$real_git" -C "$repo" branch unrelated main
  "$real_git" -C "$repo" worktree add -q "$quarantine" unrelated
  printf '%s\\n' 'unrelated worktree content' > "$quarantine/unrelated.txt"
  "$real_git" -C "$quarantine" add unrelated.txt
  "$real_git" -C "$quarantine" commit -qm 'unrelated worktree'
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'worktree-identity-changed-before-remove')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/unrelated']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, /branch refs\/heads\/unrelated/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('rejects a same-head replacement registration before final cleanup', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-registration-race-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    git(repo, ['branch', 'unattached', 'main'])
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const transactionMarker = path.join(fixtureRoot, 'transaction-started')
    const replacementMarker = path.join(fixtureRoot, 'same-registration-replacement-created')
    const composeMarker = path.join(fixtureRoot, 'compose-invoked')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
list_count_file=${JSON.stringify(path.join(fixtureRoot, 'worktree-list-count'))}
replacement_marker=${JSON.stringify(replacementMarker)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
  count=0
  if [ -f "$list_count_file" ]; then count=$(cat "$list_count_file"); fi
  count=$((count + 1))
  printf '%s\\n' "$count" > "$list_count_file"
  if [ "$count" -eq 3 ] && [ ! -f "$replacement_marker" ]; then
    touch "$replacement_marker"
    "$real_git" -C "$repo" worktree remove -f -f "$repo/.worktree/feature"
    "$real_git" -C "$repo" worktree add -q "$repo/.worktree/feature" feature
  fi
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, `#!/bin/sh
set -eu
touch ${JSON.stringify(composeMarker)}
[ "$1" = "ps" ] && exit 0
printf '%s\\n' "unexpected docker command" >&2
exit 99
`)
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.ok(summary.errors >= 1)
    assert.equal(summary.results[0].reason, 'worktree-registration-identity-failed')
    assert.match(summary.results[0].detail, /registration (path|realpath|filesystem identity|lock) changed/)
    assert.equal(existsSync(composeMarker), false)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/unattached']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, /branch refs\/heads\/feature/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fences a replacement registration before the initial worktree listing', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-pre-lock-registration-race-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const replacementMarker = path.join(fixtureRoot, 'pre-list-replacement-attempted')
    const replacementStatus = path.join(fixtureRoot, 'pre-list-replacement-status')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
replacement_marker=${JSON.stringify(replacementMarker)}
replacement_status=${JSON.stringify(replacementStatus)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ "$3" = "--porcelain" ] && [ "$4" = "-z" ] && [ ! -f "$replacement_marker" ]; then
  touch "$replacement_marker"
  candidate=''
  for path in "$repo"/.worktree/*; do
    if [ -d "$path" ]; then candidate="$path"; break; fi
  done
  test -n "$candidate"
  set +e
  "$real_git" -C "$repo" worktree remove --force "$candidate"
  status=$?
  set -e
  printf '%s\\n' "$status" > "$replacement_status"
  if [ "$status" -eq 0 ]; then
    "$real_git" -C "$repo" worktree add -q "$candidate" feature
  fi
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal((await readFile(replacementMarker, 'utf8')).length, 0)
    assert.notEqual((await readFile(replacementStatus, 'utf8')).trim(), '0')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']).stdout, /branch refs\/heads\/feature/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('fences the initial registration identity before branch snapshot', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-initial-registration-fence-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const attemptMarker = path.join(fixtureRoot, 'initial-replacement-attempted')
    const attemptStatus = path.join(fixtureRoot, 'initial-replacement-status')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
attempt_marker=${JSON.stringify(attemptMarker)}
attempt_status=${JSON.stringify(attemptStatus)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "for-each-ref" ] && [ ! -f "$attempt_marker" ]; then
  touch "$attempt_marker"
  candidate=''
  for path in "$repo"/.worktree/*; do
    if [ -d "$path" ]; then candidate="$path"; break; fi
  done
  test -n "$candidate"
  set +e
  "$real_git" -C "$repo" worktree remove --force "$candidate" >/dev/null 2>&1
  status=$?
  set -e
  printf '%s\\n' "$status" > "$attempt_status"
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.notEqual((await readFile(attemptStatus, 'utf8')).trim(), '0')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.doesNotMatch(git(repo, ['worktree', 'list', '--porcelain']).stdout, /branch refs\/heads\/feature/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('holds a quarantine registration lock through worktree removal', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-quarantine-lock-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const attemptMarker = path.join(fixtureRoot, 'replacement-attempted')
    const attemptStatus = path.join(fixtureRoot, 'replacement-status')
    const writerSwitchStatus = path.join(fixtureRoot, 'writer-switch-status')
    const writerAddStatus = path.join(fixtureRoot, 'writer-add-status')
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=${JSON.stringify(repo)}
attempt_marker=${JSON.stringify(attemptMarker)}
attempt_status=${JSON.stringify(attemptStatus)}
writer_switch_status=${JSON.stringify(writerSwitchStatus)}
writer_add_status=${JSON.stringify(writerAddStatus)}
if [ "$1" != "-C" ]; then exit 99; fi
invoked_repo="$2"
shift 2
if [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ ! -f "$attempt_marker" ]; then
  touch "$attempt_marker"
  quarantine=''
  for candidate in "$repo"/.worktree/.cleanup-*; do
    if [ -d "$candidate" ]; then quarantine="$candidate"; break; fi
  done
  test -n "$quarantine"
  set +e
  "$real_git" -C "$quarantine" switch -c writer >/dev/null 2>&1
  printf '%s\\n' "$?" > "$writer_switch_status"
  printf '%s\\n' 'late writer content' > "$quarantine/late-writer.txt"
  "$real_git" -C "$quarantine" add late-writer.txt >/dev/null 2>&1
  printf '%s\\n' "$?" > "$writer_add_status"
  "$real_git" -C "$repo" worktree remove --force "$quarantine" >/dev/null 2>&1
  status=$?
  set -e
  printf '%s\\n' "$status" > "$attempt_status"
  if [ "$status" -eq 0 ]; then
    "$real_git" -C "$repo" branch unrelated main
    "$real_git" -C "$repo" worktree add -q "$quarantine" unrelated
    printf '%s\\n' 'unrelated worktree content' > "$quarantine/unrelated.txt"
    "$real_git" -C "$quarantine" add unrelated.txt
    "$real_git" -C "$quarantine" commit -qm 'unrelated worktree'
  fi
fi
exec "$real_git" -C "$invoked_repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.notEqual((await readFile(attemptStatus, 'utf8')).trim(), '0')
    assert.notEqual((await readFile(writerSwitchStatus, 'utf8')).trim(), '0')
    assert.notEqual((await readFile(writerAddStatus, 'utf8')).trim(), '0')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/unrelated']).status, 1)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/writer']).status, 0)
    assert.equal(summary.results.at(-1).reason, 'branch-created-during-cleanup')
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('retains the registration lock when final worktree removal fails', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-remove-failure-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
if [ "$1" != "-C" ]; then exit 99; fi
repo="$2"
shift 2
if [ "$1" = "worktree" ] && [ "$2" = "remove" ] && [ "$3" = "-f" ] && [ "$4" = "-f" ]; then
  printf '%s\\n' 'simulated final remove failure' >&2
  exit 73
fi
exec "$real_git" -C "$repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 0)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].reason, 'worktree-remove-failed')
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/feature']).stdout.trim().length, 40)
    const listing = git(repo, ['worktree', 'list', '--porcelain']).stdout
    assert.match(listing, /locked clean-merged-branches initial identity fence/)
    assert.match(listing, /\.cleanup-feature-/)
    assert.doesNotMatch(listing, new RegExp(worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')))
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
    assert.equal(summary.results[0].branch_delete_method, 'git-update-ref-transaction-cas-with-ancestry-evidence')
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
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z","headRefName":"feature","headRefOid":"${head}","mergeCommit":{"oid":"${mergeCommit}"}}]'
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
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z","headRefName":"feature","headRefOid":"${head}","mergeCommit":{"oid":"${mergeCommit}"}}]'
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

test('does not remove quarantine before update-ref prepare acknowledgement', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-prepare-race-'))
  try {
    const { repo } = await makeRemoteCandidateRepo(fixtureRoot)
    squashMergeCandidateIntoMain(repo)
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
repo=''
if [ "$1" != "-C" ]; then exit 99; fi
repo="$2"
shift 2
if [ "$1" = "update-ref" ] && [ "$2" = "--stdin" ]; then
  mkdir -p "$repo/.git/refs/heads" "$repo/.git/refs/remotes/origin"
  : > "$repo/.git/refs/heads/feature.lock"
  : > "$repo/.git/refs/remotes/origin/main.lock"
  IFS= read -r line
  printf '%s\\n' 'start: ok'
  sleep 2
  exit 0
fi
exec "$real_git" -C "$repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])
    const fakeDocker = path.join(fakeBin, 'docker')
    await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
    await chmod(fakeDocker, 0o755)

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.match(summary.results[0].detail, /prepare acknowledgement/)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 0)
    assert.match(git(repo, ['worktree', 'list', '--porcelain']).stdout, /\.cleanup-feature-/)
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
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z","headRefName":"feature","headRefOid":"${head}","mergeCommit":{"oid":"${mergeCommit}"}}]'
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
    const lockPath = path.join(repo, '.git', 'clean-merged-branches.lock')
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
  printf '%s\\n' '[{"number":1,"url":"https://github.com/owner/repo/pull/1","mergedAt":"2026-01-01T00:00:00Z","headRefName":"feature","headRefOid":"${head}","mergeCommit":{"oid":"refs/heads/main"}}]'
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
    assert.match(summary.results[0].detail, /mergeCommit is invalid/)
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
  assert.match(help.stdout, /Usage: clean-merged-branches-cron\.sh/)

  const invalid = run(cronEntrypoint, ['--unexpected'])
  assert.equal(invalid.status, 2, invalid.stderr || invalid.stdout || invalid.error || 'process did not start')
})

async function writeLoggingGh(fakeBin, logPath, pulls) {
  const fakeGh = path.join(fakeBin, 'gh')
  await writeFile(fakeGh, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' ${JSON.stringify(JSON.stringify(pulls))}
  exit 0
fi
exit 1
`)
  await chmod(fakeGh, 0o755)
  const fakeDocker = path.join(fakeBin, 'docker')
  await writeFile(fakeDocker, '#!/bin/sh\n[ "$1" = "ps" ] && exit 0\nprintf "%s\\n" "unexpected docker command" >&2\nexit 99\n')
  await chmod(fakeDocker, 0o755)
}

async function ghCalls(logPath) {
  return (await readFile(logPath, 'utf8').catch(() => '')).split('\n').filter(Boolean)
}

test('deletes merged local branches that have no worktree and skips unmerged ones', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-unattached-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    // The upstream lags behind the merged local branch, which `git branch -d` would refuse.
    git(worktree, ['push', '-q', '-u', 'origin', 'feature'])
    await writeFile(path.join(worktree, 'feature-2.txt'), 'feature 2\n')
    git(worktree, ['add', 'feature-2.txt'])
    git(worktree, ['commit', '-qm', 'feature 2'])
    git(repo, ['worktree', 'remove', worktree])
    mergeCandidateIntoMain(repo)
    git(repo, ['branch', 'wip', 'main'])
    git(repo, ['switch', '-q', 'wip'])
    await writeFile(path.join(repo, 'wip.txt'), 'wip\n')
    git(repo, ['add', 'wip.txt'])
    git(repo, ['commit', '-qm', 'wip'])
    git(repo, ['switch', '-q', 'main'])
    git(repo, ['branch', 'checked-out', 'main'])
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const ghLog = path.join(fixtureRoot, 'gh.log')
    await writeLoggingGh(fakeBin, ghLog, [])
    const other = path.join(fixtureRoot, 'other')
    git(repo, ['worktree', 'add', '-q', other, 'checked-out'])

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 0)
    const byBranch = Object.fromEntries(summary.results.filter((item) => item.target === 'branch').map((item) => [item.branch, item]))
    assert.equal(byBranch.feature.action, 'deleted')
    assert.equal(byBranch.feature.evidence.method, 'ancestry')
    assert.equal(byBranch.feature.branch_delete_method, 'git-update-ref-transaction-cas-with-ancestry-evidence')
    assert.equal(byBranch.wip.action, 'skip')
    assert.equal(byBranch.wip.reason, 'merge-evidence-not-found')
    assert.equal(byBranch['checked-out'], undefined)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/wip'])
    git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/checked-out'])
    assert.equal((await ghCalls(ghLog)).length, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('deletes squash-merged unattached branches without PR evidence', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-unattached-patch-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot, 'git.example.invalid')
    squashMergeCandidateIntoMain(repo)
    git(repo, ['worktree', 'remove', worktree])

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].target, 'branch')
    assert.equal(summary.results[0].evidence.method, 'patch-equivalence')
    assert.equal(summary.results[0].evidence.commit_count, 1)
    assert.equal(summary.results[0].branch_delete_method, 'git-update-ref-transaction-cas-with-patch-equivalence-evidence')
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('reports patch-equivalence failures for unattached branches', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-unattached-malformed-cherry-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    squashMergeCandidateIntoMain(repo)
    git(repo, ['worktree', 'remove', worktree])
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const realGit = run('which', ['git']).stdout.trim()
    const fakeGit = path.join(fakeBin, 'git')
    await writeFile(fakeGit, `#!/bin/sh
set -eu
real_git=${JSON.stringify(realGit)}
if [ "$1" != "-C" ]; then exit 99; fi
repo="$2"
shift 2
if [ "$1" = "cherry" ]; then
  printf '%s\\n\\n' '- ${head}'
  exit 0
fi
exec "$real_git" -C "$repo" "$@"
`)
    await chmod(fakeGit, 0o755)
    await writeLoggingGh(fakeBin, path.join(fixtureRoot, 'gh.log'), [])

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 1)
    assert.equal(summary.results[0].action, 'error')
    assert.equal(summary.results[0].reason, 'patch-equivalence-query-failed')
    assert.equal(git(repo, ['rev-parse', '--verify', 'refs/heads/feature']).stdout.trim(), head)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('keeps unattached branches without reporting errors when merge evidence is unavailable', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-unattached-no-origin-'))
  try {
    const repo = await makeCommittedRepo(fixtureRoot)
    git(repo, ['branch', 'topic'])
    const result = run(cronEntrypoint, [], {
      env: { GIT_REPOSITORIES_ROOT: fixtureRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    assert.equal(result.stdout, '[SILENT]\n')
    git(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/topic'])
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('uses merged PR evidence when the local branch head is an ancestor of the PR head', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-pr-head-ancestor-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const localHead = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    await writeFile(path.join(worktree, 'feature-2.txt'), 'feature 2\n')
    git(worktree, ['add', 'feature-2.txt'])
    git(worktree, ['commit', '-qm', 'feature 2'])
    const prHead = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    git(repo, ['merge', '--squash', 'feature'])
    git(repo, ['commit', '-qm', 'squash merge feature'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin', 'main'])
    const mergeCommit = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    git(worktree, ['reset', '--hard', '-q', localHead])

    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const ghLog = path.join(fixtureRoot, 'gh.log')
    const pull = {
      number: 1,
      url: 'https://github.com/owner/repo/pull/1',
      mergedAt: '2026-01-01T00:00:00Z',
      headRefName: 'feature',
      headRefOid: prHead,
      mergeCommit: { oid: mergeCommit },
    }
    await writeLoggingGh(fakeBin, ghLog, [pull])

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.deleted, 1)
    assert.equal(summary.errors, 0)
    assert.equal(summary.results[0].evidence.method, 'github-merge-commit')
    assert.equal(summary.results[0].evidence.head_relation, 'ancestor')
    assert.equal(summary.results[0].evidence.pr_head, prHead)
    assert.equal((await ghCalls(ghLog)).length, 1)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})

test('resolves merged-PR evidence for every candidate with one gh call per repository', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'clean-merged-worktrees-gh-batch-'))
  try {
    const { repo, worktree } = await makeRemoteCandidateRepo(fixtureRoot)
    const featureHead = git(worktree, ['rev-parse', 'HEAD']).stdout.trim()
    git(repo, ['branch', 'other', 'main'])
    const otherWorktree = path.join(fixtureRoot, 'other-work')
    git(repo, ['worktree', 'add', '-q', otherWorktree, 'other'])
    await writeFile(path.join(otherWorktree, 'other.txt'), 'other\n')
    git(otherWorktree, ['add', 'other.txt'])
    git(otherWorktree, ['commit', '-qm', 'other'])
    const otherHead = git(otherWorktree, ['rev-parse', 'HEAD']).stdout.trim()
    git(repo, ['worktree', 'remove', otherWorktree])
    squashMergeCandidateIntoMain(repo)
    const featureMerge = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    git(repo, ['merge', '--squash', 'other'])
    git(repo, ['commit', '-qm', 'squash merge other'])
    git(repo, ['push', '-q', 'origin', 'main'])
    git(repo, ['fetch', '-q', 'origin', 'main'])
    const otherMerge = git(repo, ['rev-parse', 'refs/remotes/origin/main']).stdout.trim()
    const fakeBin = path.join(fixtureRoot, 'bin')
    await mkdir(fakeBin, { recursive: true })
    const ghLog = path.join(fixtureRoot, 'gh.log')
    const pull = (number, headRefName, headRefOid, mergeCommit) => ({ number, url: `https://github.com/owner/repo/pull/${number}`, mergedAt: '2026-01-01T00:00:00Z', headRefName, headRefOid, mergeCommit: { oid: mergeCommit } })
    await writeLoggingGh(fakeBin, ghLog, [pull(1, 'feature', featureHead, featureMerge), pull(2, 'other', otherHead, otherMerge)])

    const result = run(entrypoint, ['--repo', repo, '--apply', '--json'], {
      env: {
        GIT_REPOSITORIES_ROOT: fixtureRoot,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout || result.error || 'process did not start')
    const summary = JSON.parse(result.stdout)
    assert.equal(summary.errors, 0)
    assert.equal(summary.deleted, 2)
    assert.deepEqual(summary.results.map((item) => [item.branch, item.action, item.evidence?.number]), [['feature', 'deleted', 1], ['other', 'deleted', 2]])
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feature']).status, 1)
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/other']).status, 1)
    const calls = await ghCalls(ghLog)
    assert.equal(calls.length, 1)
    assert.doesNotMatch(calls[0], /--head/)
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
