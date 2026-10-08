import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const entrypoint = path.join(root, 'bin', 'refresh-default-branches.sh')

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

test('skips a repository with an unborn branch before attempting a rebase', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })

    must(run('git', ['init', '--bare', remote]), 'git init remote')
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'base.txt'), 'base\n')
    git(seed, ['add', 'base.txt'])
    git(seed, ['commit', '-m', 'base'])
    git(seed, ['remote', 'add', 'origin', remote])
    git(seed, ['push', 'origin', 'main'])
    must(run('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']), 'set remote HEAD')

    must(run('git', ['init', '-b', 'feat/issue-29-growth-agent', repo]), 'git init unborn repo')
    git(repo, ['remote', 'add', 'origin', remote])
    await writeFile(path.join(repo, 'README.md'), 'draft\n')

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /対象 repository: 1件/)
    assert.match(result.stdout, /fixture: スキップ — ローカルHEADがcommitを指さないunborn branchのためスキップ/)
    assert.equal(git(repo, ['branch', '--show-current']).stdout.trim(), 'feat/issue-29-growth-agent')
    assert.equal(
      run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/main']).status,
      1,
    )
    assert.equal(run('git', ['-C', repo, 'show-ref', '--verify', '--quiet', 'refs/heads/main']).status, 1)
    assert.equal(await readFile(path.join(repo, 'README.md'), 'utf8'), 'draft\n')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('keeps an unborn branch with an unreachable origin as a failure', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const missingRemote = path.join(tmp, 'missing.git')
    await mkdir(devRoot, { recursive: true })
    must(run('git', ['init', '-b', 'feat/unborn', repo]), 'git init unborn repo')
    git(repo, ['remote', 'add', 'origin', missingRemote])
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stdout, /fixture: 失敗/)
    assert.match(result.stdout, /ls-remote --heads origin/)
    assert.doesNotMatch(result.stdout, /fixture: スキップ/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('keeps an unborn branch failure when the remote default branch is unresolved', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'refresh-default-branches-'))
  try {
    const devRoot = path.join(tmp, 'dev')
    const repo = path.join(devRoot, 'fixture')
    const seed = path.join(tmp, 'seed')
    const remote = path.join(tmp, 'remote.git')
    await mkdir(devRoot, { recursive: true })

    must(run('git', ['init', '--bare', remote]), 'git init remote')
    must(run('git', ['init', '-b', 'main', seed]), 'git init seed')
    git(seed, ['config', 'user.name', 'Fixture'])
    git(seed, ['config', 'user.email', 'fixture@example.invalid'])
    await writeFile(path.join(seed, 'base.txt'), 'base\n')
    git(seed, ['add', 'base.txt'])
    git(seed, ['commit', '-m', 'base'])
    git(seed, ['remote', 'add', 'origin', remote])
    git(seed, ['push', 'origin', 'main'])
    must(run('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing']), 'set missing remote HEAD')

    must(run('git', ['init', '-b', 'feat/unborn', repo]), 'git init unborn repo')
    git(repo, ['remote', 'add', 'origin', remote])
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

    const result = run(entrypoint, [], {
      env: { ...process.env, GIT_REPOSITORIES_ROOT: devRoot },
    })

    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stdout, /fixture: 失敗/)
    assert.match(result.stdout, /origin\/HEAD/)
    assert.doesNotMatch(result.stdout, /fixture: スキップ/)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
