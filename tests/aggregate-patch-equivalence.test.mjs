import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as aggregatePatchModule from '../lib/aggregate-patch-equivalence.ts'
import { aggregatePatchEquivalence } from '../lib/aggregate-patch-equivalence.ts'

function runGit(repo, args, options = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: options.env,
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null,
  }
}

function git(repo, args) {
  const result = runGit(repo, args)
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')}: ${result.stderr || result.stdout || result.error || 'no status'}`,
  )
  return result.stdout.trim()
}

async function makeSquashFixture(partial = false, largeBinary = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aggregate-patch-equivalence-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'aggregate-patch-test'])
  await writeFile(path.join(repo, 'README'), 'base\n')
  git(repo, ['add', 'README'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['branch', '-M', 'main'])
  const base = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-qc', 'feature'])
  await writeFile(path.join(repo, 'first.txt'), 'first change\n')
  git(repo, ['add', 'first.txt'])
  git(repo, ['commit', '-qm', 'first change'])
  const firstCommit = git(repo, ['rev-parse', 'HEAD'])
  const secondPath = largeBinary ? 'large.bin' : 'second.txt'
  const secondContent = largeBinary ? randomBytes(1024 * 1024) : 'second change\n'
  await writeFile(path.join(repo, secondPath), secondContent)
  git(repo, ['add', secondPath])
  git(repo, ['commit', '-qm', 'second change'])
  const featureHead = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'main'])
  if (partial) {
    git(repo, ['cherry-pick', '--no-commit', firstCommit])
    git(repo, ['commit', '-qm', 'partial backport'])
  } else {
    git(repo, ['merge', '--squash', 'feature'])
    git(repo, ['commit', '-qm', 'squashed feature'])
    await writeFile(path.join(repo, 'unrelated.txt'), 'independent default branch update\n')
    git(repo, ['add', 'unrelated.txt'])
    git(repo, ['commit', '-qm', 'unrelated default update'])
  }
  return { root, repo, base, featureHead }
}

async function makeCrissCrossFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aggregate-patch-criss-cross-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'aggregate-patch-test'])
  await writeFile(path.join(repo, 'README'), 'base\n')
  git(repo, ['add', 'README'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['branch', '-M', 'main'])
  git(repo, ['switch', '-qc', 'side-a'])
  await writeFile(path.join(repo, 'side-a.txt'), 'side a\n')
  git(repo, ['add', 'side-a.txt'])
  git(repo, ['commit', '-qm', 'side a'])
  const sideA = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'main'])
  await writeFile(path.join(repo, 'side-b.txt'), 'side b\n')
  git(repo, ['add', 'side-b.txt'])
  git(repo, ['commit', '-qm', 'side b'])
  const sideB = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'side-a'])
  git(repo, ['merge', '--no-ff', '-qm', 'merge side b into side a', sideB])
  const leftMerge = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'main'])
  git(repo, ['merge', '--no-ff', '-qm', 'merge side a into side b', sideA])
  git(repo, ['switch', '-qc', 'candidate', leftMerge])
  await writeFile(path.join(repo, 'candidate-only.txt'), 'candidate\n')
  git(repo, ['add', 'candidate-only.txt'])
  git(repo, ['commit', '-qm', 'candidate change'])
  const candidateHead = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'main'])
  await writeFile(path.join(repo, 'default-only.txt'), 'default\n')
  git(repo, ['add', 'default-only.txt'])
  git(repo, ['commit', '-qm', 'default change'])
  const mergeBaseCount = git(repo, ['merge-base', '--all', 'main', 'candidate']).split('\n').length
  return { root, repo, candidateHead, mergeBaseCount }
}

async function makeDuplicateContextFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aggregate-patch-duplicate-context-'))
  const repo = path.join(root, 'repo')
  await mkdir(repo)
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'aggregate-patch-test'])
  const block = ['alpha', 'context-1', 'context-2', 'old-value', 'context-3', 'context-4', 'omega']
  await writeFile(path.join(repo, 'duplicate.txt'), [...block, '', ...block, ''].join('\n'))
  git(repo, ['add', 'duplicate.txt'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['branch', '-M', 'main'])
  git(repo, ['switch', '-qc', 'feature'])
  await writeFile(
    path.join(repo, 'duplicate.txt'),
    [
      ...block,
      '',
      ...block.map((line) => {
        return line === 'old-value' ? 'new-value' : line
      }),
      '',
    ].join('\n'),
  )
  git(repo, ['commit', '-qam', 'change second duplicate block'])
  const featureHead = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '-q', 'main'])
  await writeFile(
    path.join(repo, 'duplicate.txt'),
    [
      ...block.map((line) => {
        return line === 'old-value' ? 'new-value' : line
      }),
      '',
      ...block,
      '',
    ].join('\n'),
  )
  git(repo, ['commit', '-qam', 'independent change to first duplicate block'])
  return { root, repo, featureHead }
}

test('keeps unconfirmed aggregate-process termination ahead of closed-PR fallback', () => {
  assert.equal(typeof aggregatePatchModule.classifyAggregatePatchFailure, 'function')
  const classify = aggregatePatchModule.classifyAggregatePatchFailure
  const terminationFailure = {
    ok: false,
    error: 'aggregate subprocess termination could not be confirmed',
    terminationUnconfirmed: true,
  }

  assert.deepEqual(classify(terminationFailure, true), {
    action: 'error',
    code: 'aggregate-patch-process-termination-unconfirmed',
    error: terminationFailure.error,
  })
  assert.deepEqual(classify(terminationFailure, false), {
    action: 'error',
    code: 'aggregate-patch-process-termination-unconfirmed',
    error: terminationFailure.error,
  })
  assert.deepEqual(classify({ ok: false, error: 'aggregate query failed' }, true), {
    action: 'closed-pr-fallback',
  })
  assert.deepEqual(classify({ ok: false, error: 'aggregate query failed' }, false), {
    action: 'error',
    code: 'aggregate-patch-equivalence-query-failed',
    error: 'aggregate query failed',
  })
})

test('rejects a reverse patch that only matches an identical hunk at another location', async () => {
  const fixture = await makeDuplicateContextFixture()
  try {
    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.featureHead,
      'main',
      runGit,
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /offset|ambiguous/i)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects aggregate evidence when histories have multiple best merge bases', async () => {
  const fixture = await makeCrissCrossFixture()
  try {
    assert.equal(fixture.mergeBaseCount, 2)
    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.candidateHead,
      'main',
      runGit,
    )
    assert.equal(result.ok, false)
    assert.match(result.error, /multiple|ambiguous/i)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes a multi-commit aggregate patch present in a squash commit', async () => {
  const fixture = await makeSquashFixture()
  try {
    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.featureHead,
      'main',
      runGit,
    )
    assert.equal(result.ok, true)
    assert.equal(result.merged, true)
    assert.equal(result.merge_base, fixture.base)
    assert.equal(result.commit_count, 2)
    assert.equal(result.changed_path_count, 2)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects aggregate patch evidence when only part of the branch delta is present', async () => {
  const fixture = await makeSquashFixture(true)
  try {
    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.featureHead,
      'main',
      runGit,
    )
    assert.equal(result.ok, true)
    assert.equal(result.merged, false)
    assert.equal(result.reason, 'aggregate-patch-not-present')
    assert.equal(result.changed_path_count, 2)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('recognizes a large binary aggregate patch without a spawnSync buffer failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aggregate-patch-large-binary-'))
  const repo = path.join(root, 'repo')
  try {
    await mkdir(repo)
    assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0)
    git(repo, ['config', 'user.email', 'test@example.invalid'])
    git(repo, ['config', 'user.name', 'aggregate-patch-test'])
    await writeFile(path.join(repo, 'README'), 'base\n')
    git(repo, ['add', 'README'])
    git(repo, ['commit', '-qm', 'base'])
    git(repo, ['branch', '-M', 'main'])
    git(repo, ['switch', '-qc', 'feature'])
    await writeFile(path.join(repo, 'large.bin'), randomBytes(18 * 1024 * 1024))
    git(repo, ['add', 'large.bin'])
    git(repo, ['commit', '-qm', 'large binary change'])
    const featureHead = git(repo, ['rev-parse', 'HEAD'])
    git(repo, ['switch', '-q', 'main'])
    git(repo, ['merge', '--squash', 'feature'])
    git(repo, ['commit', '-qm', 'squash large binary change'])

    const result = await aggregatePatchEquivalence(repo, featureHead, 'main', runGit)

    assert.equal(result.ok, true, result.ok ? '' : result.error)
    assert.equal(result.merged, true)
    assert.equal(result.changed_path_count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stops and awaits the diff child when launching git apply throws synchronously', async () => {
  const fixture = await makeSquashFixture(false, true)
  let hookCalled = false
  let indexDirectory = ''
  let diffChild = null
  let diffChildClosed = false
  let indexPresentAtDiffClose = false
  try {
    function afterDiffSpawn(child, indexPath) {
      hookCalled = true
      indexDirectory = path.dirname(indexPath)
      diffChild = child
      child.once('close', () => {
        diffChildClosed = true
        indexPresentAtDiffClose = existsSync(indexDirectory)
      })
      throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' })
    }

    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.featureHead,
      'main',
      runGit,
      undefined,
      afterDiffSpawn,
    )

    assert.equal(result.ok, false)
    assert.match(result.error, /git apply launch failed synchronously.*E2BIG/i)
    assert.equal(hookCalled, true)
    assert.equal(diffChildClosed, true)
    assert.equal(indexPresentAtDiffClose, true)
    await assert.rejects(stat(indexDirectory), { code: 'ENOENT' })
  } finally {
    if (diffChild && !diffChildClosed) {
      diffChild.kill('SIGKILL')
      await new Promise((resolve) => {
        return diffChild.once('close', resolve)
      })
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('preserves the temporary index when synchronous apply launch failure leaves the diff child alive', async () => {
  const fixture = await makeSquashFixture(false, true)
  const fakeBin = path.join(fixture.root, 'fake-bin')
  const fakeGit = path.join(fakeBin, 'git')
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
  let diffChild = null
  let originalKill = null
  let diffChildClosed = false
  let tempDirectory = ''
  try {
    assert.ok(realGit)
    await mkdir(fakeBin)
    await writeFile(
      fakeGit,
      `#!/bin/sh
if [ "$3" = "diff" ]; then
  exec /bin/sleep 60
fi
exec "${realGit}" "$@"
`,
    )
    await chmod(fakeGit, 0o755)

    const result = await aggregatePatchEquivalence(
      fixture.repo,
      fixture.featureHead,
      'main',
      runGit,
      { PATH: fakeBin },
      (child, indexPath) => {
        diffChild = child
        originalKill = child.kill.bind(child)
        tempDirectory = path.dirname(indexPath)
        child.once('close', () => {
          diffChildClosed = true
        })
        child.kill = () => {
          return false
        }
        throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' })
      },
    )

    assert.equal(result.ok, false)
    assert.equal(result.terminationUnconfirmed, true)
    assert.match(result.error, /git diff child termination could not be confirmed/)
    assert.deepEqual(aggregatePatchModule.classifyAggregatePatchFailure(result, true), {
      action: 'error',
      code: 'aggregate-patch-process-termination-unconfirmed',
      error: result.error,
    })
    assert.equal(diffChildClosed, false)
    assert.equal(existsSync(tempDirectory), true)
  } finally {
    if (diffChild && !diffChildClosed) {
      diffChild.kill = originalKill
      diffChild.kill('SIGKILL')
      await new Promise((resolve) => {
        return diffChild.once('close', resolve)
      })
    }
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
    await rm(fixture.root, { recursive: true, force: true })
  }
})
