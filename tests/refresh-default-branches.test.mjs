import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const entrypoint = path.join(root, 'bin', 'refresh-default-branches')

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

function must(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout || result.error}`)
  return result
}

function git(repo, args) {
  return must(run('git', ['-C', repo, ...args]), `git ${args.join(' ')}`)
}

async function createRepository(repo, { remoteHead = true } = {}) {
  must(run('git', ['init', '-b', 'main', repo]), 'git init')
  git(repo, ['config', 'user.name', 'Fixture'])
  git(repo, ['config', 'user.email', 'fixture@example.invalid'])
  await writeFile(path.join(repo, 'base.txt'), 'base\n')
  git(repo, ['add', 'base.txt'])
  git(repo, ['commit', '-m', 'base'])
  git(repo, ['remote', 'add', 'origin', repo])
  if (remoteHead) {
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  }
}

test('runs without Hermes and refreshes repository default branches', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })
    await mkdir(seed, { recursive: true })
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'base.txt'), 'base\n')
    git(seed, ['add', 'base.txt'])
    git(seed, ['commit', '-m', 'base'])
    must(run('git', ['clone', '--bare', seed, remote]), 'git clone bare remote')
    must(run('git', ['clone', remote, repo]), 'git clone fixture')
    git(repo, ['config', 'user.name', 'Fixture'])
    git(repo, ['config', 'user.email', 'fixture@example.invalid'])
    git(repo, ['switch', '-c', 'fix/root-drift'])

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    must(result, 'refresh default branches')
    assert.equal(result.stdout, '')
    assert.equal(git(repo, ['branch', '--show-current']).stdout.trim(), 'fix/root-drift')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('aborts a pull rebase it started when it fails', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })
    await mkdir(seed, { recursive: true })
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'conflict.txt'), 'base\n')
    git(seed, ['add', 'conflict.txt'])
    git(seed, ['commit', '-m', 'base'])
    must(run('git', ['clone', '--bare', seed, remote]), 'git clone bare remote')
    must(run('git', ['clone', remote, repo]), 'git clone fixture')
    git(repo, ['config', 'user.name', 'Fixture'])
    git(repo, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(repo, 'conflict.txt'), 'local\n')
    git(repo, ['add', 'conflict.txt'])
    git(repo, ['commit', '-m', 'local conflict'])
    git(seed, ['remote', 'add', 'origin', remote])
    await writeFile(path.join(seed, 'conflict.txt'), 'remote\n')
    git(seed, ['add', 'conflict.txt'])
    git(seed, ['commit', '-m', 'remote conflict'])
    git(seed, ['push', 'origin', 'main'])

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /fixture: 失敗/)
    const rebaseMerge = must(run('git', ['-C', repo, 'rev-parse', '--git-path', 'rebase-merge']), 'git rebase path').stdout.trim()
    assert.equal(existsSync(rebaseMerge), false)
    assert.doesNotMatch(must(run('git', ['-C', repo, 'status'])).stdout, /rebase in progress/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('keeps the command-line boundary independent from Hermes', async () => {
  const help = must(run(entrypoint, ['--help']), 'help')
  assert.match(help.stdout, /GIT_REPOSITORIES_ROOT/)

  const invalid = run(entrypoint, ['--unexpected'])
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /unexpected argument/)

  const extra = run(entrypoint, ['--help', 'unexpected'])
  assert.equal(extra.status, 2)
  assert.match(extra.stderr, /unexpected argument/)
})

test('reports a missing repository root without a stack trace', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const missingRoot = path.join(tmp, 'missing')
    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: missingRoot },
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /repository rootを読み込めません/)
    assert.doesNotMatch(result.stderr, /Error: ENOENT/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('does not treat hidden or ordinary untracked files as dirty', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    await mkdir(repo, { recursive: true })
    await createRepository(repo)
    await mkdir(path.join(repo, '.gocache'))
    await writeFile(path.join(repo, '.gocache', 'cache.bin'), 'cache\n')
    await writeFile(path.join(repo, '.env'), 'secret=fixture\n')
    await writeFile(path.join(repo, 'notes.txt'), 'local note\n')

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    must(result, 'refresh with local files')
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stdout, /fixture: スキップ/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('does not report an abort failure when a feature rebase never starts', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })
    await mkdir(seed, { recursive: true })
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'base.txt'), 'base\n')
    git(seed, ['add', 'base.txt'])
    git(seed, ['commit', '-m', 'base'])
    must(run('git', ['clone', '--bare', seed, remote]), 'git clone bare remote')
    must(run('git', ['clone', remote, repo]), 'git clone fixture')
    git(repo, ['config', 'user.name', 'Fixture'])
    git(repo, ['config', 'user.email', 'fixture@example.invalid'])
    git(repo, ['switch', '-c', 'fix/root-drift'])
    await writeFile(path.join(repo, 'base.txt'), 'dirty\n')

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /fixture: 失敗/)
    assert.doesNotMatch(result.stdout, /rebase --abortにも失敗/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('reports repositories whose origin/HEAD cannot be resolved', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'missing-head')
    const emptyRemote = path.join(tmp, 'empty.git')
    await mkdir(repo, { recursive: true })
    await createRepository(repo, { remoteHead: false })
    must(run('git', ['init', '--bare', emptyRemote]), 'git init empty remote')
    git(repo, ['remote', 'set-url', 'origin', emptyRemote])

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    assert.equal(result.status, 1)
    assert(result.stdout.includes('missing-head: 失敗 — origin/HEADを解決できません'))
    assert.match(result.stdout, /git -C .*missing-head remote set-head origin --auto/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('follows the remote-advertised default branch without a fetch refspec', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })
    await mkdir(seed, { recursive: true })
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'base.txt'), 'base\n')
    git(seed, ['add', 'base.txt'])
    git(seed, ['commit', '-m', 'base'])
    must(run('git', ['clone', '--bare', seed, remote]), 'git clone bare remote')
    must(run('git', ['clone', remote, repo]), 'git clone fixture')
    git(repo, ['config', 'user.name', 'Fixture'])
    git(repo, ['config', 'user.email', 'fixture@example.invalid'])
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    git(repo, ['config', '--unset-all', 'remote.origin.fetch'])
    git(repo, ['switch', '-c', 'fix/root-drift'])
    git(seed, ['remote', 'add', 'origin', remote])
    git(seed, ['branch', 'trunk'])
    git(seed, ['switch', 'trunk'])
    await writeFile(path.join(seed, 'remote.txt'), 'remote update\n')
    git(seed, ['add', 'remote.txt'])
    git(seed, ['commit', '-m', 'remote update'])
    git(seed, ['push', 'origin', 'trunk'])
    must(run('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']), 'set remote HEAD')
    const remoteHead = git(seed, ['rev-parse', 'trunk']).stdout.trim()

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })
    must(result, 'refresh without fetch refspec')
    assert.equal(git(repo, ['rev-parse', 'trunk']).stdout.trim(), remoteHead)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
