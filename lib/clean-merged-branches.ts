#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { loadCleanMergedBranchesConfig } from './clean-merged-branches-config.ts'

const config = loadCleanMergedBranchesConfig()

function usage() {
  process.stdout.write(`Usage: clean-merged-branches [--root DIR] [--repo DIR ...] [--default-branch NAME] [--apply] [--json|--cron]\n\nDefault is dry-run. GIT_REPOSITORIES_ROOT defaults to $HOME/dev. Stale worktree registrations are pruned first; only clean, unlocked worktrees under <repo>/.worktree are eligible for removal. Candidate worktrees are disposable and ignored content is removed before worktree deletion.\nThe default branch must come from origin/HEAD unless explicitly supplied. A worktree is removed when its HEAD is an ancestor of that branch, when its local HEAD is an ancestor of a merged GitHub PR head with a reachable merge commit, or when all of its commits are patch-equivalent to the default branch. Local branches not checked out in any worktree are deleted under the same merge policy. Remote branches are never deleted.\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout || (command === 'gh' ? 60_000 : 30_000),
    killSignal: 'SIGKILL',
    env: config.environment,
    input: options.input
  })
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message || null
  }
}

function git(repo, args, options = {}) {
  return run('git', ['-C', repo, ...args], options)
}

async function deleteBranchRefWithCas(repo: string, ref: string, expectedOid: string, defaultRef: string, expectedDefaultHead: string, verifyUnderLock: () => string | null = () => null, beforeCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true }), allowedWorktreePath: string | null = null) {
  const command = ['-C', repo, 'update-ref', '--stdin']
  let stdout = ''
  let stderr = ''
  let launchError = null
  let closed = false
  let closeResult
  const child = spawn('git', command, {
    env: config.environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', (error: Error) => {
    launchError ||= error.message
  })
  const finished = new Promise((resolve) => {
    child.once('error', (error) => {
      launchError = error.message
      closed = true
      closeResult = { status: null, signal: null }
      resolve(closeResult)
    })
    child.once('close', (status, signal) => {
      closed = true
      closeResult = { status, signal }
      resolve(closeResult)
    })
  })
  const result = () => ({ ok: closed && closeResult?.status === 0, status: closeResult?.status ?? null, stdout, stderr, error: launchError })
  const abort = async () => {
    if (!closed) {
      try {
        child.stdin.write('abort\n')
        child.stdin.end()
      } catch {
        child.kill('SIGKILL')
      }
      await finished
    }
  }
  child.stdin.write(`start\nverify ${defaultRef} ${expectedDefaultHead}\ndelete ${ref} ${expectedOid}\nprepare\n`)
  const prepareDeadline = Date.now() + 30_000
  const hasAck = (name: string) => stdout.split(/\r?\n/).includes(`${name}: ok`)
  while (!closed && Date.now() < prepareDeadline && !hasAck('prepare')) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  if (closed || !hasAck('start') || !hasAck('prepare')) {
    await abort()
    const failed = result()
    return { ok: false, committed: false, error: `${commandDiagnostic('git', command, failed)}; update-ref prepare acknowledgement was not received` }
  }
  const fencedListing = git(repo, ['worktree', 'list', '--porcelain', '-z'])
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (closed) {
    const failed = result()
    return { ok: false, committed: false, error: commandDiagnostic('git', command, failed) }
  }
  if (!fencedListing.ok) {
    await abort()
    const failed = result()
    return { ok: false, committed: false, error: `${commandDiagnostic('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'], fencedListing)}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}` }
  }
  const allowedPath = allowedWorktreePath ? path.resolve(allowedWorktreePath) : null
  const branchInUse = parseWorktrees(fencedListing.stdout).some((worktree) => {
    return worktree.branchRef === ref && (!allowedPath || path.resolve(worktree.path) !== allowedPath)
  })
  if (branchInUse) {
    await abort()
    const failed = result()
    return { ok: false, committed: false, error: `${ref} became used by another worktree while its ref lock was held${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}` }
  }
  const evidenceError = verifyUnderLock()
  if (evidenceError) {
    await abort()
    const failed = result()
    return { ok: false, committed: false, error: `${evidenceError}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}` }
  }
  let preCommit
  try {
    preCommit = await beforeCommit()
  } catch (error) {
    preCommit = { ok: false, reason: 'branch-delete-failed', error: errorText(error) }
  }
  if (!preCommit.ok) {
    await abort()
    const failed = result()
    return {
      ok: false,
      committed: false,
      reason: preCommit.reason || 'branch-delete-failed',
      error: `${preCommit.error || 'pre-commit cleanup failed'}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}`,
    }
  }
  child.stdin.write('commit\n')
  child.stdin.end()
  await finished
  const committed = result()
  return committed.ok && hasAck('commit')
    ? { ...committed, committed: true }
    : { ...committed, committed: false, error: `${commandDiagnostic('git', command, committed)}; update-ref commit acknowledgement was not received` }
}

function verifyRefAbsent(repo, ref) {
  const result = git(repo, ['show-ref', '--verify', '--quiet', ref])
  if (result.ok) return { ok: true, absent: false }
  if (result.status === 1 && !result.stderr && !result.error) return { ok: true, absent: true }
  return { ok: false, error: commandDiagnostic('git', ['-C', repo, 'show-ref', '--verify', '--quiet', ref], result) }
}

function restoreBranchRef(repo, ref, expectedOid) {
  const restored = git(repo, ['update-ref', ref, expectedOid, ''])
  if (!restored.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, 'update-ref', ref, expectedOid, ''], restored) }
  const readBack = git(repo, ['rev-parse', '--verify', ref])
  if (!readBack.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, 'rev-parse', '--verify', ref], readBack) }
  if (readBack.stdout.trim() !== expectedOid) return { ok: false, error: `${ref} restored to ${readBack.stdout.trim()} instead of ${expectedOid}` }
  return { ok: true }
}

async function acquireWorktreeLocks(worktreeRecords: any[], lockNames: string[] = ['HEAD']) {
  const acquired: any[] = []
  let released = false
  async function release(consumedPaths = new Set()) {
    if (released) return { ok: true }
    released = true
    const errors: string[] = []
    for (const lock of acquired.reverse()) {
      let current
      try {
        current = await fs.lstat(lock.path)
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (consumedPaths.has(lock.path) && code === 'ENOENT') {
          try { await lock.handle.close() } catch (closeError) { errors.push(`${lock.path}: ${errorText(closeError)}`) }
          continue
        }
        errors.push(`${lock.path}: cannot verify lock before release: ${errorText(error)}`)
        try { await lock.handle.close() } catch (closeError) { errors.push(`${lock.path}: ${errorText(closeError)}`) }
        continue
      }
      if (consumedPaths.has(lock.path)) {
        errors.push(`${lock.path}: consumed lock still exists`)
        try { await lock.handle.close() } catch (closeError) { errors.push(`${lock.path}: ${errorText(closeError)}`) }
        continue
      }
      if (!sameFileIdentity(current, lock.identity)) {
        errors.push(`${lock.path}: lock identity changed before release`)
        try { await lock.handle.close() } catch (closeError) { errors.push(`${lock.path}: ${errorText(closeError)}`) }
        continue
      }
      try {
        await fs.unlink(lock.path)
      } catch (error) {
        errors.push(`${lock.path}: ${errorText(error)}`)
      }
      try {
        await lock.handle.close()
      } catch (error) {
        errors.push(`${lock.path}: ${errorText(error)}`)
      }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('; ') }
  }

  for (const worktree of worktreeRecords) {
    const worktreePath = path.resolve(worktree.path)
    for (const lockName of lockNames) {
      const lockTarget = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', lockName])
      if (!lockTarget.ok || !path.isAbsolute(lockTarget.stdout.trim())) {
        const releasedResult = await release()
        return {
          ok: false,
          error: `${!lockTarget.ok ? commandDiagnostic('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-path', lockName], lockTarget) : `git returned a non-absolute ${lockName} path: ${lockTarget.stdout.trim() || '<empty>'}`}${releasedResult.ok ? '' : `; lock release failed: ${releasedResult.error}`}`,
        }
      }
      const lockPath = `${lockTarget.stdout.trim()}.lock`
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0)
      let handle
      let identity
      try {
        handle = await fs.open(lockPath, flags, 0o600)
        identity = await handle.stat()
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, lock: lockName, worktree: worktreePath })}\n`, 'utf8')
        acquired.push({ path: lockPath, handle, identity })
      } catch (error) {
        if (handle) {
          try {
            const current = await fs.lstat(lockPath)
            if (identity && sameFileIdentity(current, identity)) await fs.unlink(lockPath)
          } catch {
            // Preserve an uncertain lock for operator inspection.
          }
        }
        try {
          if (handle) await handle.close()
        } catch {
          // Preserve the acquisition failure as the actionable diagnostic.
        }
        const releasedResult = await release()
        return {
          ok: false,
          error: `${lockPath}: ${errorText(error)}${releasedResult.ok ? '' : `; lock release failed: ${releasedResult.error}`}`,
        }
      }
    }
  }
  return { ok: true, release, paths: acquired.map((lock) => lock.path) }
}

async function acquireWorktreeHeadLocks(worktreeRecords) {
  return acquireWorktreeLocks(worktreeRecords, ['HEAD'])
}

function patchEquivalence(repo: string, expectedHead: string, defaultRef: string) {
  const args = ['cherry', defaultRef, expectedHead]
  const result = git(repo, args)
  if (!result.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...args], result) }
  if (result.stdout === '') return { ok: true, merged: false, commit_count: 0 }
  const newline = result.stdout.endsWith('\r\n') ? '\r\n' : result.stdout.endsWith('\n') ? '\n' : null
  if (!newline) return { ok: false, error: 'git cherry output is missing its terminal newline' }
  const body = result.stdout.slice(0, -newline.length)
  const lines = body.split(/\r?\n/)
  const objectFormat = gitObjectIdLength(repo)
  if (!objectFormat.ok) return { ok: false, error: objectFormat.error }
  const oidPattern = new RegExp(`^[+-] [0-9a-f]{${objectFormat.length}}$`)
  if (lines.length === 0 || lines.some((line) => line.length === 0 || !oidPattern.test(line))) {
    return { ok: false, error: 'git cherry returned a malformed patch-equivalence record' }
  }
  const commits = lines.map((line) => ({ status: line[0], oid: line.slice(2) }))
  return {
    ok: true,
    merged: commits.length > 0 && commits.every((commit) => commit.status === '-'),
    commit_count: commits.length,
  }
}

function mergeEvidenceError(repo: string, branchRef: string, expectedHead: string, defaultRef: string, evidence: any, expectedDefaultHead: string = evidence.default_head) {
  if (!isGitObjectId(expectedDefaultHead)) return `invalid expected default ref OID for ${defaultRef}: ${expectedDefaultHead || '<missing>'}`
  const defaultResult = git(repo, ['rev-parse', '--verify', defaultRef])
  if (!defaultResult.ok) return commandDiagnostic('git', ['-C', repo, 'rev-parse', '--verify', defaultRef], defaultResult)
  const actualDefaultHead = defaultResult.stdout.trim()
  if (actualDefaultHead !== expectedDefaultHead) return `default ref changed: ${actualDefaultHead || '<missing>'} != ${expectedDefaultHead}`
  if (evidence.method === 'ancestry') {
    return git(repo, ['merge-base', '--is-ancestor', expectedHead, defaultRef]).ok ? null : `${branchRef}@${expectedHead} is no longer an ancestor of ${defaultRef}`
  }
  if (evidence.method === 'github-merge-commit' && evidence.merge_commit) {
    return git(repo, ['merge-base', '--is-ancestor', evidence.merge_commit, defaultRef]).ok ? null : `merge commit ${evidence.merge_commit} is no longer reachable from ${defaultRef}`
  }
  if (evidence.method === 'patch-equivalence') {
    const patch = patchEquivalence(repo, expectedHead, defaultRef)
    if (!patch.ok) return patch.error || 'git cherry patch-equivalence query failed'
    return patch.merged ? null : `${branchRef}@${expectedHead} is no longer patch-equivalent to ${defaultRef}`
  }
  return `unsupported merge evidence for ${branchRef}: ${evidence.method || '<missing>'}`
}

// Deletes a local branch whose tip is proven merged into the default branch, whether or not it
// was ever attached to a worktree. `git branch -d` is not used: it judges mergedness against the
// branch upstream when one is configured, so a branch rebased onto and merged into the default
// branch but never pushed again is refused. The CAS transaction re-verifies the merge evidence
// and worktree usage while the ref lock is held instead.
async function deleteLocalBranchSafely(repo: string, worktreeRecords: any[], branchRef: string, expectedHead: string, defaultRef: string, expectedDefaultHead: string, evidence: any, allowedWorktreePath: string | null = null, beforeCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true })) {
  const branchDeleteMethod = evidence.method === 'ancestry'
    ? 'git-update-ref-transaction-cas-with-ancestry-evidence'
    : evidence.method === 'patch-equivalence'
      ? 'git-update-ref-transaction-cas-with-patch-equivalence-evidence'
      : 'git-update-ref-transaction-cas-with-merge-evidence'
  const headLocks = await acquireWorktreeHeadLocks(worktreeRecords)
  if (!headLocks.ok) return { ok: false, reason: 'worktree-head-lock-failed', detail: headLocks.error, branch_delete_method: branchDeleteMethod }
  let outcome = { ok: false, reason: 'branch-delete-failed', detail: 'branch deletion did not run', branch_delete_method: branchDeleteMethod }
  try {
    const fencedListing = git(repo, ['worktree', 'list', '--porcelain', '-z'])
    if (!fencedListing.ok) {
      outcome = { ok: false, reason: 'worktree-list-before-branch-delete-failed', detail: commandDiagnostic('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'], fencedListing), branch_delete_method: branchDeleteMethod }
    } else {
      const allowedPath = allowedWorktreePath ? path.resolve(allowedWorktreePath) : null
      const branchInUse = parseWorktrees(fencedListing.stdout).some((worktree) => {
        return worktree.branchRef === branchRef && (!allowedPath || path.resolve(worktree.path) !== allowedPath)
      })
      if (branchInUse) {
        outcome = { ok: false, reason: 'branch-still-used', detail: `${branchRef} is used by another worktree`, branch_delete_method: branchDeleteMethod }
      } else {
        const refBeforeDelete = git(repo, ['rev-parse', '--verify', branchRef])
      if (!refBeforeDelete.ok || refBeforeDelete.stdout.trim() !== expectedHead) {
        outcome = { ok: false, reason: 'branch-head-changed-before-delete', detail: !refBeforeDelete.ok ? commandDiagnostic('git', ['-C', repo, 'rev-parse', '--verify', branchRef], refBeforeDelete) : `${branchRef} changed: ${refBeforeDelete.stdout.trim()} != ${expectedHead}`, branch_delete_method: branchDeleteMethod }
      } else {
        const branchDelete = await deleteBranchRefWithCas(repo, branchRef, expectedHead, defaultRef, expectedDefaultHead, () => mergeEvidenceError(repo, branchRef, expectedHead, defaultRef, evidence, expectedDefaultHead), beforeCommit, allowedWorktreePath)
        if (!branchDelete.ok) {
          let restoreDetail = ''
          if (branchDelete.committed) {
            const restored = restoreBranchRef(repo, branchRef, expectedHead)
            restoreDetail = restored.ok ? '' : `; branch restore failed: ${restored.error}`
          } else {
            const branchAfterFailedDelete = verifyRefAbsent(repo, branchRef)
            if (!branchAfterFailedDelete.ok || branchAfterFailedDelete.absent) {
              const restored = restoreBranchRef(repo, branchRef, expectedHead)
              restoreDetail = restored.ok ? '' : `; branch restore failed: ${restored.error}`
            }
            if (!branchAfterFailedDelete.ok) restoreDetail = `${restoreDetail}; ref state after failed delete is indeterminate: ${branchAfterFailedDelete.error}`
          }
          outcome = { ok: false, reason: branchDelete.reason || 'branch-delete-failed', detail: `${branchDelete.error || commandDiagnostic('git', ['-C', repo, 'update-ref', '--stdin'], branchDelete)}${restoreDetail}`, branch_delete_method: branchDeleteMethod }
        } else {
          const branchAfterDelete = verifyRefAbsent(repo, branchRef)
          const listingAfterBranchDelete = git(repo, ['worktree', 'list', '--porcelain', '-z'])
          const branchUsedAfterDelete = listingAfterBranchDelete.ok && parseWorktrees(listingAfterBranchDelete.stdout).some((worktree) => worktree.branchRef === branchRef)
          if (!branchAfterDelete.ok || !listingAfterBranchDelete.ok || !branchAfterDelete.absent || branchUsedAfterDelete) {
            const issues = []
            if (!branchAfterDelete.ok) issues.push(branchAfterDelete.error)
            else if (!branchAfterDelete.absent) issues.push(`${branchRef} still exists after ${branchDeleteMethod}`)
            if (!listingAfterBranchDelete.ok) issues.push(commandDiagnostic('git', ['-C', repo, 'worktree', 'list', '--porcelain', '-z'], listingAfterBranchDelete))
            else if (branchUsedAfterDelete) issues.push(`${branchRef} became used by another worktree after ${branchDeleteMethod}`)
            const restored = restoreBranchRef(repo, branchRef, expectedHead)
            const restoreDetail = restored.ok ? '' : `; branch restore failed: ${restored.error}`
            outcome = { ok: false, reason: 'branch-delete-unverified', detail: `${issues.filter(Boolean).join('; ')}${restoreDetail}`, branch_delete_method: branchDeleteMethod }
          } else {
            outcome = { ok: true, branch_delete_method: branchDeleteMethod }
          }
        }
      }
    }
    }
  } finally {
    const released = await headLocks.release()
    if (!released.ok) {
      if (outcome.ok) {
        const restored = restoreBranchRef(repo, branchRef, expectedHead)
        const restoreDetail = restored.ok ? '' : `; branch restore failed: ${restored.error}`
        outcome = { ok: false, reason: 'worktree-head-lock-release-failed', detail: `${released.error}${restoreDetail}`, branch_delete_method: branchDeleteMethod }
      } else {
        outcome = { ...outcome, reason: 'worktree-head-lock-release-failed', detail: `${outcome.detail}; ${released.error}` }
      }
    }
  }
  return outcome
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

async function captureWorktreeRegistrationIdentity(worktreePath: string) {
  const gitDirResult = git(worktreePath, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const gitDir = gitDirResult.stdout.trim()
  if (!gitDirResult.ok) return { ok: false, error: commandDiagnostic('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-dir'], gitDirResult) }
  if (!gitDir || !path.isAbsolute(gitDir)) return { ok: false, error: `worktree git directory is not absolute: ${gitDir || '<empty>'}` }
  try {
    const realPath = await fs.realpath(gitDir)
    const identity = await fs.lstat(gitDir)
    return { ok: true, path: path.resolve(gitDir), realPath, identity }
  } catch (error) {
    return { ok: false, error: `worktree registration identity query failed for ${gitDir}: ${errorText(error)}` }
  }
}

function registrationIdentityMismatch(expected: any, actual: any, label = 'worktree registration') {
  if (!actual.ok) return actual.error
  if (actual.path !== expected.path) return `${label} path changed: ${actual.path} != ${expected.path}`
  if (actual.realPath !== expected.realPath) return `${label} realpath changed: ${actual.realPath} != ${expected.realPath}`
  if (!sameFileIdentity(actual.identity, expected.identity)) return `${label} filesystem identity changed`
  return null
}

async function verifyExistingRegistrationFence(repo: string, worktreePath: string, expectedRegistration: any, lockReason: string) {
  const listingArgs = ['worktree', 'list', '--porcelain', '-z']
  const listing = git(repo, listingArgs)
  if (!listing.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...listingArgs], listing) }
  const resolvedPath = path.resolve(worktreePath)
  const registered = parseWorktrees(listing.stdout).find((worktree) => path.resolve(worktree.path) === resolvedPath)
  if (!registered) return { ok: false, error: `worktree registration disappeared before Compose teardown: ${resolvedPath}` }
  if (registered.locked !== lockReason) return { ok: false, error: `worktree registration lock changed before Compose teardown: ${registered.locked || '<missing>'} != ${lockReason}` }
  const actual = await captureWorktreeRegistrationIdentity(worktreePath)
  const identityError = registrationIdentityMismatch(expectedRegistration, actual, 'worktree registration before Compose teardown')
  return identityError ? { ok: false, error: identityError } : { ok: true }
}

// 初回の worktree 一覧より先に registration 自体へロックを置く。path を一覧後に
// lock するだけでは、同じ path・branch・HEAD の replacement を元の対象と誤認できる。
const INITIAL_REGISTRATION_LOCK_REASON = 'clean-merged-branches initial identity fence'

async function readWorktreeRegistrationEntry(registrationPath: string) {
  try {
    const entryPath = path.resolve(registrationPath)
    const entryIdentity = await fs.lstat(entryPath)
    if (!entryIdentity.isDirectory()) return { ok: false, error: `${entryPath} is not a worktree registration directory` }
    const gitdirFile = path.join(entryPath, 'gitdir')
    const contents = (await fs.readFile(gitdirFile, 'utf8')).trim()
    const target = contents.replace(/^gitdir:\s*/, '').trim()
    if (!target) return { ok: false, error: `${gitdirFile} does not contain a valid gitdir record` }
    const gitdirPath = path.resolve(entryPath, target)
    const worktreePath = path.dirname(gitdirPath)
    const realPath = await fs.realpath(entryPath)
    const realWorktreePath = await fs.realpath(worktreePath)
    return { ok: true, path: entryPath, realPath, identity: entryIdentity, gitdirPath, worktreePath, realWorktreePath }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return { ok: false, code, error: `worktree registration identity query failed for ${registrationPath}: ${errorText(error)}` }
  }
}

async function openWorktreeRegistrationEntry(registrationPath: string) {
  let entryHandle = null
  try {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0)
    entryHandle = await fs.open(registrationPath, flags)
    const entryIdentity = await entryHandle.stat()
    const registration = await readWorktreeRegistrationEntry(registrationPath)
    if (!registration.ok) {
      await entryHandle.close()
      return registration
    }
    const currentIdentity = await fs.lstat(registration.path)
    if (!sameFileIdentity(currentIdentity, entryIdentity)) {
      await entryHandle.close()
      return { ok: false, error: `${registration.path}: registration directory changed while it was opened` }
    }
    return { ...registration, identity: entryIdentity, entryHandle }
  } catch (error) {
    if (entryHandle) {
      try { await entryHandle.close() } catch { /* Preserve the acquisition failure. */ }
    }
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    return { ok: false, code, error: `worktree registration entry open failed for ${registrationPath}: ${errorText(error)}` }
  }
}

async function acquireInitialRegistrationFences(repo: string) {
  const commonDirResult = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!commonDirResult.ok || !path.isAbsolute(commonDirResult.stdout.trim())) {
    return {
      ok: false,
      error: !commonDirResult.ok
        ? commandDiagnostic('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], commonDirResult)
        : `git common directory is not absolute: ${commonDirResult.stdout.trim() || '<empty>'}`,
    }
  }
  let allowedRoot: string
  try {
    allowedRoot = await fs.realpath(path.join(repo, '.worktree'))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { ok: true, fences: new Map(), allowedRoot: null, release: async () => ({ ok: true }) }
    return { ok: false, error: `eligible worktree root query failed: ${errorText(error)}` }
  }
  if (!isWithin(allowedRoot, repo)) return { ok: false, error: `eligible worktree root escapes repository: ${allowedRoot}` }
  const registrationRoot = path.join(commonDirResult.stdout.trim(), 'worktrees')
  let entries
  try {
    entries = await fs.readdir(registrationRoot, { withFileTypes: true })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { ok: true, fences: new Map(), allowedRoot, release: async () => ({ ok: true }) }
    return { ok: false, error: `worktree registration directory query failed: ${errorText(error)}` }
  }

  const states: any[] = []
  const fences = new Map()
  let released = false
  const release = async () => {
    if (released) return { ok: true }
    released = true
    const errors: string[] = []
    for (const state of [...states].reverse()) {
      if (state.released) continue
      if (state.owned && !state.retain) {
        try {
          const currentEntry = await fs.lstat(state.registration.path)
          if (!sameFileIdentity(currentEntry, state.registration.identity)) {
            errors.push(`${state.registration.path}: registration identity changed before initial lock release`)
          } else {
            const current = await fs.lstat(state.lockPath)
            if (!sameFileIdentity(current, state.lockIdentity)) {
              errors.push(`${state.lockPath}: initial registration lock identity changed before release`)
            } else {
              await fs.unlink(state.lockPath)
            }
          }
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code !== 'ENOENT') errors.push(`${state.lockPath}: initial registration lock release failed: ${errorText(error)}`)
        }
      }
      if (state.handle) {
        try {
          await state.handle.close()
        } catch (error) {
          errors.push(`${state.lockPath}: initial registration lock handle close failed: ${errorText(error)}`)
        }
      }
      if (state.entryHandle) {
        try {
          await state.entryHandle.close()
        } catch (error) {
          errors.push(`${state.registration.path}: worktree registration directory handle close failed: ${errorText(error)}`)
        }
      }
      state.released = true
    }
    return errors.length === 0 ? { ok: true } : { ok: false, error: errors.join('; ') }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const registrationPath = path.join(registrationRoot, entry.name)
    const registration = await openWorktreeRegistrationEntry(registrationPath)
    if (!registration.ok) {
      if (registration.code === 'ENOENT') continue
      const releasedResult = await release()
      return { ok: false, error: `${registration.error}${releasedResult.ok ? '' : `; ${releasedResult.error}`}` }
    }
    if (!isWithin(registration.realWorktreePath, allowedRoot)) {
      await (registration as any).entryHandle.close()
      continue
    }
    const candidate = path.resolve(registration.worktreePath)
    if (fences.has(candidate)) {
      const releasedResult = await release()
      return { ok: false, error: `multiple worktree registrations resolve to ${candidate}${releasedResult.ok ? '' : `; ${releasedResult.error}`}` }
    }
    const lockPath = path.join(registration.path, 'locked')
    const state: any = { candidate, registration, lockPath, entryHandle: (registration as any).entryHandle, handle: null, owned: false, lockIdentity: null, retain: false, released: false }
    states.push(state)
    try {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0)
      const handle = await fs.open(lockPath, flags, 0o600)
      const lockIdentity = await handle.stat()
      await handle.writeFile(`${INITIAL_REGISTRATION_LOCK_REASON}\n`, 'utf8')
      state.handle = handle
      state.lockIdentity = lockIdentity
      state.owned = true
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'EEXIST') {
        const releasedResult = await release()
        return { ok: false, error: `${lockPath}: initial registration fence failed: ${errorText(error)}${releasedResult.ok ? '' : `; ${releasedResult.error}`}` }
      }
    }
    try {
      const currentEntry = await fs.lstat(registration.path)
      if (!sameFileIdentity(currentEntry, registration.identity)) {
        const releasedResult = await release()
        return { ok: false, error: `${registration.path}: registration identity changed while acquiring the initial fence${releasedResult.ok ? '' : `; ${releasedResult.error}`}` }
      }
    } catch (error) {
      const releasedResult = await release()
      return { ok: false, error: `${registration.path}: registration identity verification failed: ${errorText(error)}${releasedResult.ok ? '' : `; ${releasedResult.error}`}` }
    }
    fences.set(candidate, state)
    const realCandidate = path.resolve(registration.realWorktreePath)
    if (realCandidate !== candidate) fences.set(realCandidate, state)
  }
  return { ok: true, fences, allowedRoot, release }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

async function acquireCleanupLock(repo) {
  const commonDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!commonDir.ok) {
    return {
      ok: false,
      code: 'cleanup-lock-path-failed',
      error: commandDiagnostic('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], commonDir),
    }
  }
  const commonDirPath = commonDir.stdout.trim()
  if (!commonDirPath || !path.isAbsolute(commonDirPath)) {
    return { ok: false, code: 'cleanup-lock-path-failed', error: `git common directory is not absolute: ${commonDirPath || '<empty>'}` }
  }
  const lockPath = path.join(commonDirPath, 'clean-merged-branches.lock')
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0)
  let handle
  try {
    handle = await fs.open(lockPath, flags, 0o600)
  } catch (error) {
    return { ok: false, code: 'cleanup-lock-unavailable', error: `${lockPath}: ${errorText(error)}` }
  }

  let identity
  try {
    identity = await handle.stat()
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, repository: repo })}\n`, 'utf8')
  } catch (error) {
    try {
      const current = await fs.lstat(lockPath)
      if (sameFileIdentity(current, identity)) await fs.unlink(lockPath)
    } catch {
      // Preserve an uncertain lock for operator inspection.
    }
    try {
      await handle.close()
    } catch {
      // The original setup failure is the actionable error.
    }
    return { ok: false, code: 'cleanup-lock-initialize-failed', error: `${lockPath}: ${errorText(error)}` }
  }

  let released = false
  return {
    ok: true,
    path: lockPath,
    async release() {
      if (released) return { ok: true }
      released = true
      let current
      try {
        current = await fs.lstat(lockPath)
      } catch (error) {
        try {
          await handle.close()
        } catch {
          // Preserve the path/read-back failure as the primary diagnostic.
        }
        return { ok: false, error: `${lockPath}: cannot verify lock before release: ${errorText(error)}` }
      }
      if (!sameFileIdentity(current, identity)) {
        try {
          await handle.close()
        } catch {
          // Keep the identity mismatch visible.
        }
        return { ok: false, error: `${lockPath}: lock identity changed before release` }
      }
      let unlinkError = null
      try {
        await fs.unlink(lockPath)
      } catch (error) {
        unlinkError = error
      }
      let closeError = null
      try {
        await handle.close()
      } catch (error) {
        closeError = error
      }
      if (unlinkError || closeError) {
        return { ok: false, error: `${lockPath}: ${unlinkError?.message || ''}${unlinkError && closeError ? '; ' : ''}${closeError?.message || ''}` }
      }
      return { ok: true }
    },
  }
}

function pathIsWithinOrEqual(child, parent) {
  const resolvedChild = path.resolve(child)
  const resolvedParent = path.resolve(parent)
  return resolvedChild === resolvedParent || isWithin(resolvedChild, resolvedParent)
}

function dockerInspectContainer(containerId) {
  const inspected = run('docker', ['inspect', containerId])
  if (!inspected.ok) return { ok: false, code: 'compose-inspect-failed', error: commandDiagnostic('docker', ['inspect', containerId], inspected) }
  try {
    const records = JSON.parse(inspected.stdout)
    if (!Array.isArray(records) || records.length !== 1) return { ok: false, code: 'compose-inspect-failed', error: `docker inspect returned ${records.length} records` }
    return { ok: true, record: records[0] }
  } catch (error) {
    return { ok: false, code: 'compose-inspect-failed', error: errorText(error) }
  }
}

function composeTeardownForWorktree(worktree, apply) {
  const listed = run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project'])
  if (listed.error && listed.error.includes('ENOENT')) return { ok: false, code: 'compose-query-failed', error: commandDiagnostic('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project'], listed) }
  if (!listed.ok) return { ok: false, code: 'compose-query-failed', error: commandDiagnostic('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project'], listed) }
  const containerIds = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  if (containerIds.length === 0) return { ok: true, status: 'none', projects: [] }

  const projectsByName = new Map()
  for (const containerId of containerIds) {
    const inspected = dockerInspectContainer(containerId)
    if (!inspected.ok) return inspected
    const record = inspected.record
    const labels = record.Config?.Labels || {}
    const projectName = labels['com.docker.compose.project']
    const workingDir = labels['com.docker.compose.project.working_dir']
    const configFiles = (labels['com.docker.compose.project.config_files'] || '').split(',').map((value) => value.trim()).filter(Boolean)
    const mounts = Array.isArray(record.Mounts) ? record.Mounts : []
    const candidateIdentity = Boolean(workingDir && pathIsWithinOrEqual(workingDir, worktree))
    const configFilesWithinCandidate = configFiles.length > 0 && configFiles.every((value) => pathIsWithinOrEqual(value, worktree))
    const bindMountsWithinCandidate = mounts.every((mount) => mount.Type !== 'bind' || Boolean(mount.Source && pathIsWithinOrEqual(mount.Source, worktree)))
    const safeCandidateIdentity = candidateIdentity && Boolean(projectName) && configFilesWithinCandidate && bindMountsWithinCandidate
    if (candidateIdentity && !safeCandidateIdentity) {
      return { ok: false, code: 'compose-identity-mismatch', error: `container ${containerId} metadata is outside ${worktree}`, projects: [] }
    }
    if (!projectName) continue
    if (!projectsByName.has(projectName)) projectsByName.set(projectName, { name: projectName, records: [] })
    projectsByName.get(projectName).records.push({ containerId, workingDir, configFiles, safeCandidateIdentity, candidateIdentity })
  }
  const projects = new Map()
  for (const project of projectsByName.values()) {
    if (!project.records.some((record) => record.candidateIdentity)) continue
    if (project.records.some((record) => !record.safeCandidateIdentity)) {
      return { ok: false, code: 'compose-identity-mismatch', error: `Compose project ${project.name} has containers outside ${worktree}`, projects: [] }
    }
    const first = project.records[0]
    const signature = JSON.stringify({ workingDir: first.workingDir, configFiles: first.configFiles })
    if (project.records.some((record) => JSON.stringify({ workingDir: record.workingDir, configFiles: record.configFiles }) !== signature)) {
      return { ok: false, code: 'compose-identity-mismatch', error: `Compose project ${project.name} has mixed worktree metadata`, projects: [] }
    }
    projects.set(project.name, {
      name: project.name,
      workingDir: first.workingDir,
      configFiles: first.configFiles,
      containerIds: project.records.map((record) => record.containerId),
    })
  }
  if (projects.size === 0) return { ok: true, status: 'none', projects: [] }
  if (!apply) return { ok: true, status: 'planned', projects: [...projects.values()] }

  const teardowns = []
  for (const project of projects.values()) {
    const args = ['compose', '-p', project.name]
    for (const configFile of project.configFiles) args.push('-f', configFile)
    args.push('down', '--remove-orphans')
    const stopped = run('docker', args)
    const readBack = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project.name}`])
    if (!stopped.ok) return { ok: false, code: 'compose-down-failed', error: commandDiagnostic('docker', args, stopped), projects: teardowns }
    if (!readBack.ok || readBack.stdout.trim()) return { ok: false, code: 'compose-containers-still-running', error: commandDiagnostic('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project.name}`], readBack), projects: teardowns }
    teardowns.push({ ...project, command: commandText('docker', args), status: 'stopped', readBack: '0 running containers' })
  }
  return { ok: true, status: 'stopped', projects: teardowns }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function commandText(command, args) {
  return [command, ...args].map((value) => {
    return shellQuote(value)
  }).join(' ')
}

function commandDiagnostic(command, args, result) {
  const fields = [`command=${commandText(command, args)}`, `exit=${result.status ?? 'launch-failed'}`]
  if (result.error) fields.push(`error=${result.error}`)
  if (result.stderr.trim()) fields.push(`stderr=${result.stderr.trim()}`)
  if (result.stdout.trim()) fields.push(`stdout=${result.stdout.trim()}`)
  return fields.join('; ')
}

function appendRestoreDiagnostic(detail, command, args, result) {
  return `${detail}; restore=${result.ok ? 'ok' : 'failed'}; ${commandDiagnostic(command, args, result)}`
}

type WorktreeRecord = {
  path: string
  head?: string
  branchRef?: string
  locked?: string
  prunable?: string
}

function parseWorktrees(output: string) {
  const records: WorktreeRecord[] = []
  let current: Partial<WorktreeRecord> = {}
  for (const token of output.split('\0')) {
    if (!token) {
      if (typeof current.path === 'string') records.push({ ...current, path: current.path })
      current = {}
      continue
    }
    const space = token.indexOf(' ')
    const key = space === -1 ? token : token.slice(0, space)
    const value = space === -1 ? true : token.slice(space + 1)
    if (key === 'worktree' && typeof value === 'string') current.path = value
    else if (key === 'HEAD' && typeof value === 'string') current.head = value
    else if (key === 'branch' && typeof value === 'string') current.branchRef = value
    else if (key === 'locked') current.locked = typeof value === 'string' ? value : ''
    else if (key === 'prunable') current.prunable = typeof value === 'string' ? value : ''
  }
  if (typeof current.path === 'string') records.push({ ...current, path: current.path })
  return records
}

// The prepared ref transaction protects refs, not the pathname of a worktree registration.
// Re-read registration, filesystem identity, HEAD, and branch immediately before removal.
async function inspectWorktreeIdentity(repo: string, worktreePath: string, expectedHead: string, expectedBranchRef: string, allowedRoot: string, expectedRegistration: any, expectedLockReason: string | null = null) {
  const resolvedPath = path.resolve(worktreePath)
  const listingArgs = ['worktree', 'list', '--porcelain', '-z']
  const listing = git(repo, listingArgs)
  if (!listing.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...listingArgs], listing) }
  const registered = parseWorktrees(listing.stdout).find((worktree) => path.resolve(worktree.path) === resolvedPath)
  if (!registered) return { ok: false, error: `quarantine worktree disappeared before removal: ${resolvedPath}` }
  const issues: string[] = []
  if (registered.head !== expectedHead) issues.push(`HEAD changed before removal: ${registered.head || '<missing>'} != ${expectedHead}`)
  if (registered.branchRef !== expectedBranchRef) issues.push(`branch changed before removal: ${registered.branchRef || '<missing>'} != ${expectedBranchRef}`)
  if (expectedLockReason !== null && registered.locked !== expectedLockReason) issues.push(`registration lock changed before removal: ${registered.locked || '<missing>'} != ${expectedLockReason}`)
  const registration = await captureWorktreeRegistrationIdentity(worktreePath)
  const registrationError = registrationIdentityMismatch(expectedRegistration, registration, 'quarantine worktree registration')
  if (registrationError) issues.push(registrationError)
  // The caller acquires the registration lock immediately before this check.
  // A pre-existing lock cannot be acquired and is rejected by `worktree lock`.
  if (registered.prunable !== undefined) issues.push('quarantine worktree became prunable before removal')
  let realPath: string | null = null
  try {
    realPath = await fs.realpath(worktreePath)
  } catch (error) {
    issues.push(`quarantine realpath failed before removal: ${errorText(error)}`)
  }
  if (realPath !== resolvedPath) issues.push(`quarantine path changed before removal: ${realPath || '<missing>'}`)
  if (realPath && !isWithin(realPath, allowedRoot)) issues.push(`quarantine path escaped allowed root before removal: ${realPath}`)
  const head = git(worktreePath, ['rev-parse', '--verify', 'HEAD'])
  if (!head.ok || head.stdout.trim() !== expectedHead) issues.push(!head.ok ? commandDiagnostic('git', ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD'], head) : `worktree HEAD changed before removal: ${head.stdout.trim()} != ${expectedHead}`)
  const branch = git(worktreePath, ['symbolic-ref', '-q', 'HEAD'])
  if (!branch.ok || branch.stdout.trim() !== expectedBranchRef) issues.push(!branch.ok ? commandDiagnostic('git', ['-C', worktreePath, 'symbolic-ref', '-q', 'HEAD'], branch) : `worktree branch changed before removal: ${branch.stdout.trim()} != ${expectedBranchRef}`)
  const statusArgs = ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all']
  const status = git(worktreePath, statusArgs)
  if (!status.ok) issues.push(commandDiagnostic('git', ['-C', worktreePath, ...statusArgs], status))
  else if (status.stdout.length > 0) issues.push('worktree became dirty before removal')
  const ignored = ignoredFiles(worktreePath)
  if (!ignored.ok) issues.push(commandDiagnostic('git', ['-C', worktreePath, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'], ignored))
  else if (ignored.stdout.length > 0) issues.push('ignored files appeared before removal')
  return issues.length === 0 ? { ok: true } : { ok: false, error: issues.join('; ') }
}

// Git's registration lock is the enforceable fence between the final identity
// check and `worktree remove`: a normal concurrent `remove`/`move`/`add` cannot
// replace the registration while this lock is held. A single `--force` also
// respects it; the cleanup's double-force is used only after all dirty-state
// checks have passed because Git otherwise refuses to remove a locked tree.
async function verifyWorktreeIdentityBeforeRemove(repo: string, worktreePath: string, expectedHead: string, expectedBranchRef: string, allowedRoot: string, expectedRegistration: any, existingLockReason: string | null = null) {
  let acquiredHere = false
  let lockArgs = null
  if (existingLockReason === null) {
    lockArgs = ['worktree', 'lock', '--reason', 'clean-merged-branches removal fence', worktreePath]
    const locked = git(repo, lockArgs)
    if (!locked.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...lockArgs], locked) }
    acquiredHere = true
  }
  const identity = await inspectWorktreeIdentity(repo, worktreePath, expectedHead, expectedBranchRef, allowedRoot, expectedRegistration, existingLockReason)
  if (identity.ok) return { ok: true, registrationLocked: true }
  const unlockArgs = ['worktree', 'unlock', worktreePath]
  const unlocked = acquiredHere ? git(repo, unlockArgs) : { ok: true }
  const unlockError = unlocked.ok ? '' : `; ${commandDiagnostic('git', ['-C', repo, ...unlockArgs], unlocked)}`
  return { ok: false, error: `${identity.error}${unlockError}` }
}

function pruneWorktreeRegistrations(repo, apply) {
  const args = apply ? ['worktree', 'prune', '-v'] : ['worktree', 'prune', '--dry-run', '-v']
  const result = git(repo, args)
  return result.ok
    ? { ok: true, args, output: result.stdout.trim() }
    : { ok: false, args, error: commandDiagnostic('git', ['-C', repo, ...args], result) }
}

function defaultBranchStatusArgs(defaultPath, worktrees) {
  const exclusions = []
  for (const worktree of worktrees) {
    const candidatePath = path.resolve(worktree.path)
    if (!isWithin(candidatePath, defaultPath)) continue
    const relative = path.relative(defaultPath, candidatePath)
    if (relative) exclusions.push(`:(exclude)${relative}`)
  }
  return ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ...exclusions]
}

const MAX_CRON_PATH_LENGTH = 120
const MAX_CRON_LOCATIONS = 4

function statusKind(code: string) {
  if (code === '??') return '未追跡'
  if (code.includes('U') || code === 'AA' || code === 'DD') return '競合'
  if (code.includes('D')) return '削除'
  if (code.includes('R')) return '名前変更'
  if (code.includes('C')) return 'コピー'
  if (code.includes('A')) return '追加'
  if (code.includes('M')) return '変更'
  return '変更'
}

function escapeCronPath(value: string) {
  let escaped = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0
    if (character === '\\') escaped += '\\\\'
    else if (character === '\t') escaped += '\\t'
    else if (character === '\n') escaped += '\\n'
    else if (character === '\r') escaped += '\\r'
    else if (codePoint === 0x2028) escaped += '\\u2028'
    else if (codePoint === 0x2029) escaped += '\\u2029'
    else if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      escaped += `\\x${codePoint.toString(16).padStart(2, '0')}`
    } else {
      escaped += character
    }
  }
  const characters = Array.from(escaped)
  return characters.length > MAX_CRON_PATH_LENGTH
    ? `${characters.slice(0, MAX_CRON_PATH_LENGTH - 1).join('')}…`
    : escaped
}

function isValidDirtyStatusCode(code: string) {
  if (code === '??') return true
  if (code === '  ' || code === '!!') return false
  if (new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(code)) return true
  const indexStatus = new Set([' ', 'M', 'T', 'A', 'D', 'R', 'C'])
  const worktreeStatus = new Set([' ', 'M', 'T', 'D'])
  return indexStatus.has(code[0]) && worktreeStatus.has(code[1])
}

function summarizeDirtyStatus(output: string) {
  const counts = new Map<string, number>()
  const locations = new Map<string, number>()
  if (!output.endsWith('\0')) return { ok: false, error: 'git status returned an unterminated porcelain stream' }
  const tokens = output.split('\0')
  let records = 0
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      if (index !== tokens.length - 1) return { ok: false, error: 'git status returned an empty record' }
      continue
    }
    if (token.length < 4 || token[2] !== ' ') return { ok: false, error: `git status returned an invalid porcelain record: ${escapeCronPath(token)}` }
    const code = token.slice(0, 2)
    if (!isValidDirtyStatusCode(code)) return { ok: false, error: `git status returned an invalid status code: ${escapeCronPath(code)}` }
    const itemPath = token.slice(3)
    if (!itemPath) return { ok: false, error: 'git status returned a record without a path' }
    const kind = statusKind(code)
    const location = itemPath.includes('/') ? `${itemPath.split('/', 1)[0]}/` : itemPath
    counts.set(kind, (counts.get(kind) || 0) + 1)
    locations.set(location, (locations.get(location) || 0) + 1)
    records += 1
    if (code.includes('R') || code.includes('C')) {
      const renamedPath = tokens[index + 1]
      if (!renamedPath) return { ok: false, error: 'git status returned a rename/copy record without its second path' }
      index += 1
    }
  }
  if (records === 0) return { ok: false, error: 'git status returned no parseable records' }
  const countText = [...counts.entries()]
    .map(([kind, count]) => `${kind} ${count.toLocaleString('ja-JP')}件`)
    .join('、')
  const locationEntries = [...locations.entries()].sort((left, right) => {
    return right[1] - left[1] || left[0].localeCompare(right[0])
  })
  const visibleLocations = locationEntries.slice(0, MAX_CRON_LOCATIONS).map(([location, count]) => {
    return `${escapeCronPath(location)} (${count.toLocaleString('ja-JP')}件)`
  })
  if (locationEntries.length > visibleLocations.length) visibleLocations.push(`他${locationEntries.length - visibleLocations.length}箇所`)
  return { ok: true, summary: `${countText}。主な場所: ${visibleLocations.join('、')}` }
}

function isGitObjectId(value: unknown) {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
}

function readDefaultWorktreeSnapshot(repo: string, expectedPath: string, expectedWorktree: WorktreeRecord) {
  const args = ['worktree', 'list', '--porcelain', '-z']
  if (!expectedWorktree.branchRef || !isGitObjectId(expectedWorktree.head)) {
    return { ok: false, error: `default branch worktree identity is malformed before status: ${expectedWorktree.branchRef || '<missing>'}@${expectedWorktree.head || '<missing>'}` }
  }
  const listing = git(repo, args)
  if (!listing.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...args], listing) }
  const currentWorktrees = parseWorktrees(listing.stdout)
  const currentMatches = currentWorktrees.filter((item) => path.resolve(item.path) === expectedPath)
  if (currentMatches.length !== 1) {
    return { ok: false, error: currentMatches.length === 0 ? `default branch worktree disappeared: ${expectedPath}` : `default branch worktree identity is ambiguous: ${expectedPath}` }
  }
  const current = currentMatches[0]
  if (!current.branchRef || !isGitObjectId(current.head)) {
    return { ok: false, error: `default branch worktree identity is malformed after status: ${current.branchRef || '<missing>'}@${current.head || '<missing>'}` }
  }
  if (current.branchRef !== expectedWorktree.branchRef || current.head !== expectedWorktree.head) {
    return {
      ok: false,
      error: `default branch worktree identity changed: expected ${expectedWorktree.branchRef || '<detached>'}@${expectedWorktree.head || '<missing>'}, actual ${current.branchRef || '<detached>'}@${current.head || '<missing>'}`,
    }
  }
  return { ok: true, worktrees: currentWorktrees }
}

async function refreshDefaultBranchBeforeCleanup(repo, worktrees, defaultInfo) {
  const defaultBranchRef = `refs/heads/${defaultInfo.name}`
  const defaultWorktree = worktrees.find((item) => item.branchRef === defaultBranchRef)
  if (defaultWorktree) {
    const defaultPath = path.resolve(defaultWorktree.path)
    const beforeStatus = readDefaultWorktreeSnapshot(repo, defaultPath, defaultWorktree)
    if (!beforeStatus.ok) return { ok: false, code: 'default-branch-refresh-failed', error: beforeStatus.error }
    const statusArgs = defaultBranchStatusArgs(defaultPath, beforeStatus.worktrees)
    const status = git(defaultPath, statusArgs)
    if (!status.ok) {
      return { ok: false, code: 'default-branch-refresh-failed', error: commandDiagnostic('git', ['-C', defaultPath, ...statusArgs], status) }
    }
    let dirtyStatus
    if (status.stdout.length > 0) {
      const summarized = summarizeDirtyStatus(status.stdout)
      if (!summarized.ok) return { ok: false, code: 'default-branch-refresh-failed', error: summarized.error }
      dirtyStatus = summarized.summary
    }
    const afterStatus = readDefaultWorktreeSnapshot(repo, defaultPath, defaultWorktree)
    if (!afterStatus.ok) return { ok: false, code: 'default-branch-refresh-failed', error: afterStatus.error }
    if (dirtyStatus !== undefined) {
      return {
        ok: true,
        skipped: true,
        code: 'default-branch-dirty',
        error: `default branch worktree is dirty: ${defaultPath}`,
        dirty_status: dirtyStatus,
        default_worktree_path: defaultPath,
        default_worktree: defaultWorktree,
      }
    }
  }

  // Cleanup only needs the authoritative remote-tracking ref. Do not pull/rebase
  // an existing worktree here: the repository lock cannot fence an unrelated
  // checkout, so a concurrent branch switch could otherwise mutate the wrong
  // branch. The dedicated refresh job remains responsible for worktree rebase.
  const args = ['fetch', '--no-tags', 'origin', `refs/heads/${defaultInfo.name}:refs/remotes/origin/${defaultInfo.name}`]
  const fetched = git(repo, args, { timeout: 120_000 })
  return fetched.ok
    ? { ok: true, refreshed: true, mode: 'fetch' }
    : { ok: false, code: 'default-branch-refresh-failed', error: commandDiagnostic('git', ['-C', repo, ...args], fetched) }
}

function worktreeRegistrationResult(repo, item, action, detail = item.prunable) {
  return {
    repo,
    path: path.resolve(item.path),
    branch: item.branchRef?.replace(/^refs\/heads\//, '') || null,
    head: item.head || null,
    action,
    reason: 'prunable',
    detail
  }
}

function ownerRepo(remote) {
  const value = remote.trim()
  let pathname
  if (value.includes('://')) {
    try {
      const parsed = new URL(value)
      if (parsed.hostname !== 'github.com') return null
      pathname = parsed.pathname
    } catch {
      return null
    }
  } else {
    const scp = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
    if (!scp || scp[1] !== 'github.com') return null
    pathname = `/${scp[2]}`
  }
  const match = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function discoverRepos(root, explicitRepos) {
  if (explicitRepos.length) return explicitRepos.map((repo) => path.resolve(repo))
  const repos = []
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'tmp') continue
    const candidate = path.join(root, entry.name)
    try {
      await fs.access(path.join(candidate, '.git'))
      repos.push(candidate)
    } catch {
      // Not a root checkout.
    }
  }
  return repos.sort()
}

function defaultBranch(repo, explicitName = null) {
  if (explicitName) {
    const remoteRef = `refs/remotes/origin/${explicitName}`
    const localRef = `refs/heads/${explicitName}`
    if (git(repo, ['show-ref', '--verify', '--quiet', remoteRef]).ok) return { name: explicitName, ref: remoteRef, source: 'explicit-remote' }
    if (git(repo, ['show-ref', '--verify', '--quiet', localRef]).ok) return { name: explicitName, ref: localRef, source: 'explicit-local' }
    return null
  }
  const symbolic = git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (symbolic.ok && symbolic.stdout.trim().startsWith('origin/')) {
    const name = symbolic.stdout.trim().slice('origin/'.length)
    return { name, ref: `refs/remotes/origin/${name}`, source: 'origin/HEAD' }
  }

  const queried = git(repo, ['ls-remote', '--symref', 'origin', 'HEAD'])
  if (!queried.ok) return null
  const lines = queried.stdout.split(/\r?\n/).filter(Boolean)
  const symbolicLine = lines.find((line) => line.startsWith('ref: ') && line.endsWith('\tHEAD'))
  const name = symbolicLine?.slice('ref: refs/heads/'.length, -'\tHEAD'.length)
  if (!name) return null
  const remoteRef = `refs/remotes/origin/${name}`
  const localRef = `refs/heads/${name}`
  if (git(repo, ['show-ref', '--verify', '--quiet', remoteRef]).ok) return { name, ref: remoteRef, source: 'remote-HEAD-query' }
  if (git(repo, ['show-ref', '--verify', '--quiet', localRef]).ok) return { name, ref: localRef, source: 'remote-HEAD-query-local' }
  return null
}

function isEmptyRepository(repo) {
  const head = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.ok) return false
  const remoteHeads = git(repo, ['ls-remote', '--heads', 'origin'])
  return remoteHeads.ok && remoteHeads.stdout.trim() === ''
}

function ignoredFiles(repo) {
  return git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'])
}

function ignoredFilesDetail(result) {
  const count = result.stdout.split('\0').filter(Boolean).length
  return `${count} ignored path${count === 1 ? '' : 's'}`
}

function remoteDefaultState(repo, expectedName, explicit = false) {
  const args = explicit ? ['ls-remote', 'origin', `refs/heads/${expectedName}`] : ['ls-remote', '--symref', 'origin', 'HEAD']
  const queried = git(repo, args)
  if (!queried.ok) return { ok: false, code: 'remote-default-query-failed', error: queried.stderr.trim() }
  const lines = queried.stdout.split(/\r?\n/).filter(Boolean)
  if (!explicit) {
    const symbolic = lines.find((line) => line.startsWith('ref: ') && line.endsWith('\tHEAD'))
    const remoteName = symbolic?.slice('ref: refs/heads/'.length, -'\tHEAD'.length)
    if (!remoteName || remoteName !== expectedName) return { ok: false, code: 'remote-default-branch-mismatch', error: `remote HEAD is ${remoteName || '<unknown>'}, expected ${expectedName}` }
  }
  const suffix = explicit ? `\trefs/heads/${expectedName}` : '\tHEAD'
  const oidLine = lines.find((line) => line.endsWith(suffix) && /^[0-9a-f]+\t/.test(line))
  const oid = oidLine?.split('\t', 1)[0]
  if (!oid) return { ok: false, code: 'remote-default-oid-missing', error: `remote default OID was not returned for ${expectedName}` }
  return { ok: true, name: expectedName, oid }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function gitObjectIdLength(repo) {
  const result = git(repo, ['rev-parse', '--show-object-format'])
  if (!result.ok) return { ok: false, code: 'git-object-format-unreadable', error: commandDiagnostic('git', ['-C', repo, 'rev-parse', '--show-object-format'], result) }
  const format = result.stdout.trim()
  if (format === 'sha1') return { ok: true, length: 40 }
  if (format === 'sha256') return { ok: true, length: 64 }
  return { ok: false, code: 'git-object-format-unsupported', error: `unsupported Git object format: ${format || '<empty>'}` }
}

const MERGED_PR_BATCH_LIMIT = 1000
const MERGED_PR_BRANCH_LIMIT = 100
const MERGED_PR_FIELDS = 'number,url,mergedAt,headRefName,headRefOid,mergeCommit'

function validatePullList(pulls, oidLength) {
  if (!Array.isArray(pulls)) return 'gh pr list response must be an array'
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`)
  for (const pull of pulls) {
    if (!isRecord(pull) || !Number.isInteger(pull.number) || pull.number < 1 || typeof pull.url !== 'string' || pull.url.length === 0 || (pull.mergedAt !== null && typeof pull.mergedAt !== 'string')) {
      return 'gh pr list response contains an invalid pull object'
    }
    if (typeof pull.headRefName !== 'string' || pull.headRefName.length === 0) return 'gh pr list headRefName is invalid'
    if (typeof pull.headRefOid !== 'string' || !oidPattern.test(pull.headRefOid)) return 'gh pr list headRefOid is invalid'
    if (pull.mergeCommit !== null && (!isRecord(pull.mergeCommit) || typeof pull.mergeCommit.oid !== 'string' || !oidPattern.test(pull.mergeCommit.oid))) return 'gh pr list mergeCommit is invalid'
  }
  return null
}

function queryMergedPulls(target, defaultName, oidLength, limit, headBranch = null) {
  const args = ['pr', 'list', '--repo', target, '--state', 'merged', '--base', defaultName, '--limit', String(limit), '--json', MERGED_PR_FIELDS]
  if (headBranch) args.splice(6, 0, '--head', headBranch)
  const response = run('gh', args, { timeout: 120_000 })
  if (!response.ok) return { ok: false, code: 'github-query-failed', error: (response.stderr || response.error || '').trim() }
  let pulls
  try {
    pulls = JSON.parse(response.stdout)
  } catch (error) {
    return { ok: false, code: 'github-invalid-json', error: errorText(error) }
  }
  const pullListError = validatePullList(pulls, oidLength)
  if (pullListError) return { ok: false, code: 'github-invalid-response', error: pullListError }
  return { ok: true, pulls, truncated: pulls.length >= limit }
}

// Resolves merged-PR evidence with one `gh pr list` per repository. A local branch head
// can match the merged PR head exactly or be an ancestor of it. The batch is fetched lazily
// and a truncated batch falls back to a per-branch `--head` query. When PR evidence is absent,
// the resolver falls back to read-only `git cherry` patch-equivalence evidence so local merges,
// cherry-picks, and non-GitHub repositories can still be cleaned safely.
function createMergedPrLookup(repo, defaultName, defaultRef) {
  let context = null
  let batch = null
  function loadContext() {
    if (context) return context
    const remote = git(repo, ['config', '--get', 'remote.origin.url'])
    if (!remote.ok) return (context = { ok: false, code: 'missing-origin', error: remote.stderr.trim() })
    const target = ownerRepo(remote.stdout)
    if (!target) return (context = { ok: false, code: 'non-github-origin', error: remote.stdout.trim() })
    const objectFormat = gitObjectIdLength(repo)
    if (!objectFormat.ok) return (context = { ok: false, code: objectFormat.code, error: objectFormat.error, repository: target })
    return (context = { ok: true, target, oidLength: objectFormat.length })
  }
  function matchPulls(pulls, target, head) {
    let unreachable = null
    for (const pull of pulls) {
      const exactHead = pull.headRefOid === head
      const ancestorHead = !exactHead
        && git(repo, ['cat-file', '-e', `${pull.headRefOid}^{commit}`]).ok
        && git(repo, ['merge-base', '--is-ancestor', head, pull.headRefOid]).ok
      if (!exactHead && !ancestorHead) continue
      const mergeCommit = pull.mergeCommit?.oid
      const mergeCommitExists = mergeCommit && git(repo, ['cat-file', '-e', `${mergeCommit}^{commit}`]).ok
      const mergeCommitReachable = mergeCommitExists && git(repo, ['merge-base', '--is-ancestor', mergeCommit, defaultRef]).ok
      if (mergeCommitReachable) return { ok: true, match: pull, repository: target, mergedHead: head, prHead: pull.headRefOid, headRelation: exactHead ? 'exact' : 'ancestor', mergeCommit }
      unreachable ||= { pull, mergeCommit: mergeCommit || null }
    }
    if (unreachable) return { ok: false, code: 'merge-evidence-unreachable', error: `PR #${unreachable.pull.number} merge commit is not reachable from ${defaultRef}`, repository: target, mergeCommit: unreachable.mergeCommit }
    return { ok: true, match: null, repository: target }
  }
  return function mergedPrEvidence(branch, head) {
    const ctx = loadContext()
    if (!ctx.ok) return ctx
    batch ||= queryMergedPulls(ctx.target, defaultName, ctx.oidLength, MERGED_PR_BATCH_LIMIT)
    if (!batch.ok) return { ...batch, repository: ctx.target }
    const matched = matchPulls(batch.pulls.filter((pull) => pull.headRefName === branch), ctx.target, head)
    if (!matched.ok || matched.match || !batch.truncated) return matched
    const single = queryMergedPulls(ctx.target, defaultName, ctx.oidLength, MERGED_PR_BRANCH_LIMIT, branch)
    if (!single.ok) return { ...single, repository: ctx.target }
    return matchPulls(single.pulls.filter((pull) => pull.headRefName === branch), ctx.target, head)
  }
}

function resolveMergeEvidence(repo: string, branch: string, head: string, defaultRef: string, defaultHead: string, mergedPrEvidence: (branch: string, head: string) => any) {
  const pr = mergedPrEvidence(branch, head)
  if (pr.ok && pr.match) {
    return {
      ok: true,
      evidence: {
        method: 'github-merge-commit',
        pr: pr.match.url,
        number: pr.match.number,
        merged_at: pr.match.mergedAt,
        merge_commit: pr.mergeCommit,
        pr_head: pr.prHead,
        head_relation: pr.headRelation,
        default_ref: defaultRef,
        default_head: defaultHead,
      },
    }
  }

  const patch = patchEquivalence(repo, head, defaultRef)
  if (patch.ok && patch.merged) {
    return {
      ok: true,
      evidence: {
        method: 'patch-equivalence',
        default_ref: defaultRef,
        default_head: defaultHead,
        commit_count: patch.commit_count,
      },
    }
  }
  if (!pr.ok) {
    if (!patch.ok) {
      return {
        ok: false,
        code: 'patch-equivalence-query-failed',
        error: `${patch.error}; PR evidence unavailable: ${pr.error}`,
        repository: pr.repository,
        pr_error: { code: pr.code, detail: pr.error },
      }
    }
    return pr
  }
  if (!patch.ok) return { ok: false, code: 'patch-equivalence-query-failed', error: patch.error }
  return { ok: true, evidence: null }
}

async function inspectRepository(repo, apply, explicitDefaultBranch) {
  const realRepo = await fs.realpath(repo)
  if (!apply) return inspectRepositoryUnderLock(realRepo, apply, explicitDefaultBranch)
  const lock = await acquireCleanupLock(realRepo)
  if (!lock.ok) return [{ repo: realRepo, action: 'error', reason: lock.code, detail: lock.error }]
  let results
  let inspectionError = null
  try {
    results = await inspectRepositoryUnderLock(realRepo, apply, explicitDefaultBranch)
  } catch (error) {
    inspectionError = error
  }
  const released = await lock.release()
  if (inspectionError) {
    if (!released.ok) throw new Error(`${errorText(inspectionError)}; cleanup lock release failed: ${released.error}`)
    throw inspectionError
  }
  if (!released.ok) results.push({ repo: realRepo, action: 'error', reason: 'cleanup-lock-release-failed', detail: released.error })
  return results
}

async function inspectRepositoryUnderLock(realRepo, apply, explicitDefaultBranch) {
  const results: any[] = []
  const initialFences: any = apply ? await acquireInitialRegistrationFences(realRepo) : { ok: true, fences: new Map(), release: async () => ({ ok: true }) }
  if (!initialFences.ok) return [{ repo: realRepo, action: 'error', reason: 'worktree-registration-fence-failed', detail: initialFences.error }]
  const listing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
  if (!listing.ok) {
    const released = await initialFences.release()
    return [{ repo: realRepo, action: 'error', reason: 'worktree-list-failed', detail: `${listing.stderr.trim()}${released.ok ? '' : `; initial registration fence release failed: ${released.error}`}` }]
  }
  let worktrees = parseWorktrees(listing.stdout)
  let rootRecord = worktrees.find((item) => path.resolve(item.path) === realRepo)
  if (!rootRecord) {
    const released = await initialFences.release()
    return [{ repo: realRepo, action: 'error', reason: 'root-worktree-not-found', detail: released.ok ? undefined : `initial registration fence release failed: ${released.error}` }]
  }
  let candidateWorktrees = worktrees.filter((item) => path.resolve(item.path) !== realRepo)
  const initialRegistrationIdentities = new Map()
  const initialRegistrationFences: Array<{ candidate: string; beforeLockIdentity: any; fence: any }> = []
  if (apply) {
    for (const item of candidateWorktrees.filter((candidate) => candidate.prunable === undefined)) {
      const candidate = path.resolve(item.path)
      let realCandidate
      try {
        realCandidate = await fs.realpath(candidate)
      } catch {
        realCandidate = null
      }
      if (!initialFences.allowedRoot || !realCandidate || !isWithin(realCandidate, initialFences.allowedRoot)) continue
      const fence = initialFences.fences.get(candidate)
      if (item.locked !== undefined && !fence?.owned) continue
      if (!fence?.owned) {
        initialRegistrationIdentities.set(candidate, { ok: false, error: 'candidate registration was not fenced before the initial worktree listing' })
        continue
      }
      const identity = await captureWorktreeRegistrationIdentity(candidate)
      const identityError = registrationIdentityMismatch(fence.registration, identity, 'initial registration')
      if (identityError) {
        initialRegistrationIdentities.set(candidate, { ok: false, error: identityError })
      } else {
        initialRegistrationFences.push({ candidate, beforeLockIdentity: identity, fence })
      }
    }
  }
  const initialBranches = listLocalBranches(realRepo)
  if (!initialBranches.ok) {
    const released = await initialFences.release()
    return [{ repo: realRepo, action: 'error', reason: 'branch-list-failed', detail: `${initialBranches.error}${released.ok ? '' : `; initial registration fence release failed: ${released.error}`}` }]
  }
  const initialBranchHeads = new Map((initialBranches as any).branches.map((branch: any) => [branch.ref, branch.oid]))
  if (apply) {
    for (const fence of initialRegistrationFences) {
      const identity = await captureWorktreeRegistrationIdentity(fence.candidate)
      const identityError = registrationIdentityMismatch(fence.beforeLockIdentity, identity, 'initial registration')
      if (identityError) {
        initialRegistrationIdentities.set(fence.candidate, { ok: false, error: identityError })
      } else {
        initialRegistrationIdentities.set(fence.candidate, identity)
      }
    }
    const initialIdentityFailures = [...initialRegistrationIdentities.entries()].filter(([, identity]) => !identity?.ok)
    if (initialIdentityFailures.length > 0) {
      const released = await initialFences.release()
      return [{
        repo: realRepo,
        action: 'error',
        reason: 'worktree-registration-identity-failed',
        detail: `${initialIdentityFailures.map(([candidate, identity]) => `${candidate}: ${identity.error || 'registration identity was not captured'}`).join('; ')}${released.ok ? '' : `; initial registration fence release failed: ${released.error}`}`,
      }]
    }
  }
  const initialPrunable = candidateWorktrees.filter((item) => item.prunable !== undefined)
  let registrationFenceFailure = false
  try {
  const plannedPrunablePaths = new Set(initialPrunable.map((item) => path.resolve(item.path)))

  // Prune stale registrations before checking repository state or classifying candidates.
  // Dry-run keeps the repository unchanged and reports what apply would prune.
  const prune = pruneWorktreeRegistrations(realRepo, apply)
  if (!prune.ok) return [{ repo: realRepo, action: 'error', reason: 'worktree-prune-failed', detail: prune.error }]
  if (apply) {
    const postPruneListing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
    if (!postPruneListing.ok) return [{ repo: realRepo, action: 'error', reason: 'worktree-list-after-prune-failed', detail: postPruneListing.stderr.trim() }]
    const postPruneWorktrees = parseWorktrees(postPruneListing.stdout)
    const unresolved = initialPrunable.filter((item) => postPruneWorktrees.some((current) => path.resolve(current.path) === path.resolve(item.path)))
    const pruned = initialPrunable.filter((item) => !unresolved.includes(item))
    results.push(...pruned.map((item) => worktreeRegistrationResult(realRepo, item, 'pruned')))
    if (unresolved.length > 0) {
      results.push(...unresolved.map((item) => worktreeRegistrationResult(realRepo, item, 'error', `${item.prunable || 'prunable registration remains'}; git worktree prune completed but the registration is still present`)))
      return results
    }
    worktrees = postPruneWorktrees
    rootRecord = worktrees.find((item) => path.resolve(item.path) === realRepo)
    if (!rootRecord) return [...results, { repo: realRepo, action: 'error', reason: 'root-worktree-not-found-after-prune' }]
    candidateWorktrees = worktrees.filter((item) => path.resolve(item.path) !== realRepo)
  } else {
    results.push(...initialPrunable.map((item) => worktreeRegistrationResult(realRepo, item, 'would-prune')))
    candidateWorktrees = candidateWorktrees.filter((item) => !plannedPrunablePaths.has(path.resolve(item.path)))
  }

  if (isEmptyRepository(realRepo)) {
    return [...results, { repo: realRepo, action: 'skip', reason: 'empty-repository' }]
  }
  if (candidateWorktrees.length === 0 && !hasUnattachedLocalBranches(realRepo, worktrees)) return results
  // With no worktree candidates only unattached branches remain. A repository whose default
  // branch cannot be established (no origin, stale or dirty default, ...) keeps its branches
  // without reporting an error, matching how unmerged unattached branches are skipped.
  const branchCleanupOnly = candidateWorktrees.length === 0
  const prerequisiteFailure = (item) => branchCleanupOnly
    ? [...results, { repo: realRepo, action: 'skip', reason: 'branch-cleanup-unavailable', detail: `${item.reason}${item.detail ? `: ${item.detail}` : ''}` }]
    : [...results, item]
  let defaultInfo = defaultBranch(realRepo, explicitDefaultBranch)
  if (!defaultInfo) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'default-branch-not-found' })
  let dirtyRefresh: any = null
  if (apply) {
    const refreshed = await refreshDefaultBranchBeforeCleanup(realRepo, worktrees, defaultInfo)
    if (!refreshed.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: refreshed.code, detail: refreshed.error, dirty_status: refreshed.dirty_status })
    dirtyRefresh = refreshed
    defaultInfo = defaultBranch(realRepo, explicitDefaultBranch)
    if (!defaultInfo) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'default-branch-not-found-after-refresh' })
  }
  const defaultHeadResult = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
  if (!defaultHeadResult.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'default-ref-unreadable' })
  const defaultHead = defaultHeadResult.stdout.trim()
  const mergedPrEvidence = createMergedPrLookup(realRepo, defaultInfo.name, defaultInfo.ref)
  const remoteDefault = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
  if (!remoteDefault.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: remoteDefault.code, detail: remoteDefault.error })
  if (remoteDefault.oid !== defaultHead) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'local-default-stale', detail: `${defaultInfo.ref}=${defaultHead}, remote=${remoteDefault.oid}` })
  if (dirtyRefresh?.skipped) {
    const finalSnapshot = readDefaultWorktreeSnapshot(realRepo, dirtyRefresh.default_worktree_path, dirtyRefresh.default_worktree)
    if (!finalSnapshot.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'default-branch-refresh-failed', detail: finalSnapshot.error })
    return prerequisiteFailure({ repo: realRepo, action: 'skip', severity: 'warn', reason: dirtyRefresh.code, detail: dirtyRefresh.error, dirty_status: dirtyRefresh.dirty_status })
  }
  const allowedRoot = path.join(realRepo, '.worktree')
  let realAllowedRoot: string | null = null
  try {
    const resolvedAllowedRoot = await fs.realpath(allowedRoot)
    if (isWithin(resolvedAllowedRoot, realRepo)) realAllowedRoot = resolvedAllowedRoot
  } catch {
    // Repositories without a physical in-repository .worktree directory have no eligible candidates.
  }

  for (const item of worktrees) {
    const candidate = path.resolve(item.path)
    if (candidate === realRepo) continue
    const base = { repo: realRepo, path: candidate, branch: item.branchRef?.replace(/^refs\/heads\//, '') || null, head: item.head || null }
    if (item.prunable !== undefined) {
      if (!apply && plannedPrunablePaths.has(candidate)) continue
      results.push({ ...base, action: 'error', reason: 'worktree-prune-unresolved', detail: item.prunable || 'prunable registration remains' })
      continue
    }
    let realCandidate
    try {
      realCandidate = await fs.realpath(candidate)
    } catch (error) {
      results.push({ ...base, action: 'error', reason: 'candidate-realpath-failed', detail: errorText(error) })
      continue
    }
    if (!realAllowedRoot || !isWithin(realCandidate, realAllowedRoot)) {
      results.push({ ...base, action: 'skip', reason: 'outside-repo-worktree-root' })
      continue
    }
    const initialFence = apply ? initialFences.fences.get(candidate) : null
    if (item.locked !== undefined && !initialFence?.owned) {
      results.push({ ...base, action: 'skip', reason: 'locked', detail: item.locked })
      continue
    }
    if (!item.branchRef?.startsWith('refs/heads/')) {
      results.push({ ...base, action: 'skip', reason: 'detached-head' })
      continue
    }
    if (base.branch === defaultInfo.name) {
      results.push({ ...base, action: 'skip', reason: 'default-branch' })
      continue
    }
    const status = git(candidate, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!status.ok) {
      results.push({ ...base, action: 'error', reason: 'status-failed', detail: status.stderr.trim() })
      continue
    }
    if (status.stdout.length > 0) {
      results.push({ ...base, action: 'skip', reason: 'dirty' })
      continue
    }
    const ignoredBeforeQuarantine = ignoredFiles(candidate)
    if (!ignoredBeforeQuarantine.ok) {
      results.push({ ...base, action: 'error', reason: 'ignored-files-query-failed', detail: commandDiagnostic('git', ['-C', candidate, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'], ignoredBeforeQuarantine) })
      continue
    }

    const ancestry = git(realRepo, ['merge-base', '--is-ancestor', item.head, defaultInfo.ref]).ok
    let evidence = ancestry ? { method: 'ancestry', default_ref: defaultInfo.ref, default_head: defaultHead } : null
    if (!evidence) {
      const resolved = resolveMergeEvidence(realRepo, base.branch || '', item.head || '', defaultInfo.ref, defaultHead, mergedPrEvidence)
      if (!resolved.ok) {
        results.push({ ...base, action: 'error', reason: resolved.code, detail: resolved.error, repository: resolved.repository, pr_error: resolved.pr_error })
        continue
      }
      evidence = resolved.evidence
    }
    if (!evidence) {
      results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found' })
      continue
    }
    const refBeforeRemove = git(realRepo, ['rev-parse', '--verify', item.branchRef])
    if (!refBeforeRemove.ok || refBeforeRemove.stdout.trim() !== item.head) {
      results.push({ ...base, action: 'error', reason: 'branch-head-changed-before-remove', evidence })
      continue
    }
    const defaultBeforeRemove = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
    if (!defaultBeforeRemove.ok || defaultBeforeRemove.stdout.trim() !== defaultHead) {
      results.push({ ...base, action: 'error', reason: 'default-head-changed-before-remove', evidence })
      continue
    }
    const remoteBeforeRemove = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
    if (!remoteBeforeRemove.ok || remoteBeforeRemove.oid !== defaultHead) {
      results.push({ ...base, action: 'error', reason: remoteBeforeRemove.ok ? 'remote-default-changed-before-remove' : remoteBeforeRemove.code, detail: remoteBeforeRemove.ok ? `${remoteBeforeRemove.oid} != ${defaultHead}` : remoteBeforeRemove.error, evidence })
      continue
    }
    if (evidence.method === 'ancestry' && !git(realRepo, ['merge-base', '--is-ancestor', item.head, defaultInfo.ref]).ok) {
      results.push({ ...base, action: 'error', reason: 'ancestry-changed-before-remove', evidence })
      continue
    }
    if (evidence.method === 'github-merge-commit' && !git(realRepo, ['merge-base', '--is-ancestor', evidence.merge_commit, defaultInfo.ref]).ok) {
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-before-remove', evidence })
      continue
    }
    if (evidence.method === 'patch-equivalence') {
      const patchError = mergeEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead)
      if (patchError) {
        results.push({ ...base, action: 'error', reason: 'patch-equivalence-changed-before-remove', detail: patchError, evidence })
        continue
      }
    }
    const registrationBeforeQuarantine = apply ? initialRegistrationIdentities.get(candidate) : null
    if (apply && !registrationBeforeQuarantine?.ok) {
      registrationFenceFailure = true
      results.push({ ...base, action: 'error', reason: 'worktree-registration-identity-failed', detail: registrationBeforeQuarantine?.error || 'candidate registration was not present in the initial worktree snapshot', evidence })
      continue
    }
    if (apply) {
      const preComposeFence = await verifyExistingRegistrationFence(realRepo, candidate, registrationBeforeQuarantine, INITIAL_REGISTRATION_LOCK_REASON)
      if (!preComposeFence.ok) {
        registrationFenceFailure = true
        results.push({ ...base, action: 'error', reason: 'worktree-registration-identity-failed', detail: preComposeFence.error, evidence })
        continue
      }
    }
    const compose = composeTeardownForWorktree(candidate, apply)
    if (!compose.ok) {
      results.push({ ...base, action: 'error', reason: compose.code, detail: compose.error, evidence, compose })
      continue
    }
    if (!apply) {
      results.push({ ...base, action: 'would-delete', reason: 'merged', evidence, compose, ignored_files: ignoredBeforeQuarantine.stdout.length > 0 ? ignoredFilesDetail(ignoredBeforeQuarantine) : undefined })
      continue
    }
    const quarantine = path.join(realAllowedRoot, `.cleanup-${path.basename(candidate)}-${randomBytes(16).toString('hex')}`)
    const movedToQuarantine = git(realRepo, ['worktree', 'move', '-f', '-f', candidate, quarantine])
    if (!movedToQuarantine.ok) {
      registrationFenceFailure = true
      results.push({ ...base, action: 'error', reason: 'worktree-quarantine-move-failed', detail: movedToQuarantine.stderr.trim(), evidence })
      continue
    }
    const restoreQuarantine = () => git(realRepo, ['worktree', 'move', '-f', '-f', quarantine, candidate])
    const quarantinedHead = git(quarantine, ['rev-parse', '--verify', 'HEAD'])
    const quarantinedBranch = git(quarantine, ['symbolic-ref', '-q', 'HEAD'])
    const registrationAfterQuarantine = await captureWorktreeRegistrationIdentity(quarantine)
    const registrationAfterQuarantineError = registrationIdentityMismatch(registrationBeforeQuarantine, registrationAfterQuarantine, 'quarantine worktree registration')
    if (!quarantinedHead.ok || quarantinedHead.stdout.trim() !== item.head || !quarantinedBranch.ok || quarantinedBranch.stdout.trim() !== item.branchRef || registrationAfterQuarantineError) {
      if (registrationAfterQuarantineError) registrationFenceFailure = true
      const restored = registrationAfterQuarantineError ? { ok: false, stderr: `quarantine retained: ${registrationAfterQuarantineError}` } : restoreQuarantine()
      results.push({ ...base, action: 'error', reason: registrationAfterQuarantineError ? 'worktree-registration-changed-after-quarantine' : 'worktree-head-or-branch-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const statusBeforeRemove = git(quarantine, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!statusBeforeRemove.ok) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'status-recheck-failed-before-remove', detail: `${statusBeforeRemove.stderr.trim()}${restored.ok ? '' : `; restore failed: ${restored.stderr.trim()}`}`, evidence })
      continue
    }
    if (statusBeforeRemove.stdout.length > 0) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-became-dirty-before-remove', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const ignoredAfterQuarantine = ignoredFiles(quarantine)
    if (!ignoredAfterQuarantine.ok) {
      const restored = restoreQuarantine()
      results.push({
        ...base,
        action: 'error',
        reason: 'ignored-files-query-failed-after-quarantine',
        detail: appendRestoreDiagnostic(commandDiagnostic('git', ['-C', quarantine, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'], ignoredAfterQuarantine), 'git', ['-C', realRepo, 'worktree', 'move', quarantine, candidate], restored),
        evidence
      })
      continue
    }
    const ignoredFilesPresent = ignoredBeforeQuarantine.stdout.length > 0 || ignoredAfterQuarantine.stdout.length > 0
    const ignoredFilesRemoved = ignoredFilesPresent
      ? {
          before_quarantine: ignoredFilesDetail(ignoredBeforeQuarantine),
          after_quarantine: ignoredFilesDetail(ignoredAfterQuarantine),
        }
      : undefined
    const statusAfterQuarantine = git(quarantine, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    const headAfterQuarantine = git(quarantine, ['rev-parse', '--verify', 'HEAD'])
    const branchAfterQuarantine = git(quarantine, ['symbolic-ref', '-q', 'HEAD'])
    const refAfterQuarantine = git(realRepo, ['rev-parse', '--verify', item.branchRef])
    const defaultAfterQuarantine = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
    const listingAfterQuarantine = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
    const registeredAfterQuarantine = listingAfterQuarantine.ok
      ? parseWorktrees(listingAfterQuarantine.stdout).find((worktree) => path.resolve(worktree.path) === path.resolve(quarantine))
      : null
    let realQuarantineAfterQuarantine = null
    try {
      realQuarantineAfterQuarantine = await fs.realpath(quarantine)
    } catch {
      // Reported by the combined post-quarantine identity check below.
    }
    const quarantineFenceLost = !registeredAfterQuarantine || registeredAfterQuarantine.locked !== INITIAL_REGISTRATION_LOCK_REASON || realQuarantineAfterQuarantine !== path.resolve(quarantine) || !isWithin(realQuarantineAfterQuarantine, realAllowedRoot)
    if (!statusAfterQuarantine.ok || statusAfterQuarantine.stdout.length > 0 || !headAfterQuarantine.ok || headAfterQuarantine.stdout.trim() !== item.head || !branchAfterQuarantine.ok || branchAfterQuarantine.stdout.trim() !== item.branchRef || !refAfterQuarantine.ok || refAfterQuarantine.stdout.trim() !== item.head || !defaultAfterQuarantine.ok || defaultAfterQuarantine.stdout.trim() !== defaultHead || quarantineFenceLost) {
      if (quarantineFenceLost) registrationFenceFailure = true
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-state-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const remoteAfterQuarantine = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
    if (!remoteAfterQuarantine.ok || remoteAfterQuarantine.oid !== defaultHead) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'remote-default-changed-after-quarantine', detail: `${remoteAfterQuarantine.ok ? `${remoteAfterQuarantine.oid} != ${defaultHead}` : remoteAfterQuarantine.error}${restored.ok ? '' : `; restore failed: ${restored.stderr.trim()}`}`, evidence })
      continue
    }
    const mergeEvidenceStillValid = mergeEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead) === null
    if (!mergeEvidenceStillValid) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    if (ignoredFilesPresent) {
      const cleanArgs = ['clean', '-ffdX']
      const cleaned = git(quarantine, cleanArgs)
      if (!cleaned.ok) {
        const restored = restoreQuarantine()
        results.push({
          ...base,
          action: 'error',
          reason: 'ignored-files-clean-failed',
          detail: appendRestoreDiagnostic(commandDiagnostic('git', ['-C', quarantine, ...cleanArgs], cleaned), 'git', ['-C', realRepo, 'worktree', 'move', quarantine, candidate], restored),
          evidence,
          ignored_files_observed: ignoredFilesRemoved,
        })
        continue
      }
      const ignoredAfterClean = ignoredFiles(quarantine)
      const statusAfterClean = git(quarantine, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
      if (!ignoredAfterClean.ok || ignoredAfterClean.stdout.length > 0 || !statusAfterClean.ok || statusAfterClean.stdout.length > 0) {
        const restored = restoreQuarantine()
        const cleanVerification = !ignoredAfterClean.ok
          ? commandDiagnostic('git', ['-C', quarantine, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--directory'], ignoredAfterClean)
          : !statusAfterClean.ok
            ? commandDiagnostic('git', ['-C', quarantine, '-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], statusAfterClean)
            : `ignored files remain after clean: ${ignoredFilesDetail(ignoredAfterClean)}; status is not clean after clean`
        results.push({
          ...base,
          action: 'error',
          reason: 'ignored-files-clean-unverified',
          detail: appendRestoreDiagnostic(cleanVerification, 'git', ['-C', realRepo, 'worktree', 'move', quarantine, candidate], restored),
          evidence,
          ignored_files_observed: ignoredFilesRemoved,
        })
        continue
      }
      const headAfterClean = git(quarantine, ['rev-parse', '--verify', 'HEAD'])
      const branchAfterClean = git(quarantine, ['symbolic-ref', '-q', 'HEAD'])
      const refAfterClean = git(realRepo, ['rev-parse', '--verify', item.branchRef])
      const defaultAfterClean = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
      const listingAfterClean = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
      const registeredAfterClean = listingAfterClean.ok
        ? parseWorktrees(listingAfterClean.stdout).find((worktree) => path.resolve(worktree.path) === path.resolve(quarantine))
        : null
      let realQuarantineAfterClean = null
      try {
        realQuarantineAfterClean = await fs.realpath(quarantine)
      } catch {
        // Reported by the post-clean identity check below.
      }
      const remoteAfterClean = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
      const mergeEvidenceAfterClean = mergeEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead) === null
      const postCleanIssues = []
      if (!headAfterClean.ok || headAfterClean.stdout.trim() !== item.head) postCleanIssues.push(!headAfterClean.ok ? commandDiagnostic('git', ['-C', quarantine, 'rev-parse', '--verify', 'HEAD'], headAfterClean) : `HEAD changed after ignored cleanup: ${headAfterClean.stdout.trim()} != ${item.head}`)
      if (!branchAfterClean.ok || branchAfterClean.stdout.trim() !== item.branchRef) postCleanIssues.push(!branchAfterClean.ok ? commandDiagnostic('git', ['-C', quarantine, 'symbolic-ref', '-q', 'HEAD'], branchAfterClean) : `branch changed after ignored cleanup: ${branchAfterClean.stdout.trim()} != ${item.branchRef}`)
      if (!refAfterClean.ok || refAfterClean.stdout.trim() !== item.head) postCleanIssues.push(!refAfterClean.ok ? commandDiagnostic('git', ['-C', realRepo, 'rev-parse', '--verify', item.branchRef], refAfterClean) : `branch ref changed after ignored cleanup: ${refAfterClean.stdout.trim()} != ${item.head}`)
      if (!defaultAfterClean.ok || defaultAfterClean.stdout.trim() !== defaultHead) postCleanIssues.push(!defaultAfterClean.ok ? commandDiagnostic('git', ['-C', realRepo, 'rev-parse', '--verify', defaultInfo.ref], defaultAfterClean) : `default ref changed after ignored cleanup: ${defaultAfterClean.stdout.trim()} != ${defaultHead}`)
      if (!listingAfterClean.ok) postCleanIssues.push(commandDiagnostic('git', ['-C', realRepo, 'worktree', 'list', '--porcelain', '-z'], listingAfterClean))
      else if (!registeredAfterClean || registeredAfterClean.locked !== INITIAL_REGISTRATION_LOCK_REASON) {
        registrationFenceFailure = true
        postCleanIssues.push('quarantine worktree registration changed or lost the initial identity fence after ignored cleanup')
      }
      if (realQuarantineAfterClean !== path.resolve(quarantine) || !isWithin(realQuarantineAfterClean, realAllowedRoot)) postCleanIssues.push(`quarantine path changed after ignored cleanup: ${realQuarantineAfterClean || '<missing>'}`)
      if (!remoteAfterClean.ok || remoteAfterClean.oid !== defaultHead) postCleanIssues.push(remoteAfterClean.ok ? `remote default changed after ignored cleanup: ${remoteAfterClean.oid} != ${defaultHead}` : remoteAfterClean.error)
      if (!mergeEvidenceAfterClean) postCleanIssues.push('merge evidence is no longer valid after ignored cleanup')
      if (postCleanIssues.length > 0) {
        const restored = restoreQuarantine()
        results.push({
          ...base,
          action: 'error',
          reason: 'worktree-state-changed-after-ignored-clean',
          detail: appendRestoreDiagnostic(postCleanIssues.join('; '), 'git', ['-C', realRepo, 'worktree', 'move', quarantine, candidate], restored),
          evidence,
          ignored_files_observed: ignoredFilesRemoved,
        })
        continue
      }
    }
    const quarantinePath = path.resolve(quarantine)
    const headLockRecords = parseWorktrees(listingAfterQuarantine.stdout)
      .filter((worktree) => path.resolve(worktree.path) !== quarantinePath)
    const beforeCommit = async () => {
      const contentLocks: any = await acquireWorktreeLocks([{ path: quarantine }], ['HEAD', 'index'])
      if (!contentLocks.ok) return { ok: false, reason: 'worktree-content-lock-failed', error: contentLocks.error }
      const identity = await verifyWorktreeIdentityBeforeRemove(realRepo, quarantine, item.head || '', item.branchRef || '', realAllowedRoot, registrationBeforeQuarantine, INITIAL_REGISTRATION_LOCK_REASON)
      if (!identity.ok) {
        const released = await contentLocks.release()
        return { ok: false, reason: 'worktree-identity-changed-before-remove', error: `${identity.error}${released.ok ? '' : `; content lock release failed: ${released.error}`}` }
      }
      const removeArgs = ['worktree', 'remove', '-f', '-f', quarantine]
      const removed = git(realRepo, removeArgs)
      if (!removed.ok) {
        initialFence.retain = true
        const released = await contentLocks.release()
        return {
          ok: false,
          reason: 'worktree-remove-failed',
          error: `${commandDiagnostic('git', ['-C', realRepo, ...removeArgs], removed)}; quarantine registration lock retained for manual inspection${released.ok ? '' : `; content lock release failed: ${released.error}`}`,
        }
      }
      const consumedContentLocks = await contentLocks.release(new Set(contentLocks.paths))
      if (!consumedContentLocks.ok) return { ok: false, reason: 'worktree-content-lock-release-failed', error: consumedContentLocks.error }
      const verifyListing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
      const stillPresent = verifyListing.ok && parseWorktrees(verifyListing.stdout).some((worktree) => path.resolve(worktree.path) === quarantinePath)
      let pathStillPresent = false
      try {
        await fs.lstat(quarantine)
        pathStillPresent = true
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code !== 'ENOENT') pathStillPresent = true
      }
      if (!verifyListing.ok || stillPresent || pathStillPresent) {
        return {
          ok: false,
          reason: 'worktree-remove-unverified',
          error: !verifyListing.ok
            ? commandDiagnostic('git', ['-C', realRepo, 'worktree', 'list', '--porcelain', '-z'], verifyListing)
            : stillPresent
              ? `${quarantine} is still registered after worktree remove`
              : `${quarantine} still exists after worktree remove`,
        }
      }
      return { ok: true }
    }
    const branchSafety = await deleteLocalBranchSafely(realRepo, headLockRecords, item.branchRef, item.head, defaultInfo.ref, defaultHead, evidence, quarantine, beforeCommit)
    if (!branchSafety.ok) {
      if (branchSafety.reason.startsWith('worktree-')) registrationFenceFailure = true
      results.push({ ...base, action: 'error', reason: branchSafety.reason, detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
      continue
    }
    results.push({ ...base, action: 'deleted', reason: 'merged', evidence, branch_delete_method: branchSafety.branch_delete_method, ignored_files_removed: ignoredFilesRemoved })
  }
  if (registrationFenceFailure) return results
  const worktreeBranchRefs = new Set(worktrees.map((item) => item.branchRef).filter(Boolean))
  results.push(...await cleanupUnattachedMergedBranches(realRepo, apply, explicitDefaultBranch, defaultInfo, defaultHead, worktreeBranchRefs, mergedPrEvidence, initialBranchHeads))
  return results
  } finally {
    const released = await initialFences.release()
    if (!released.ok) results.push({ repo: realRepo, action: 'error', reason: 'worktree-registration-fence-release-failed', detail: released.error })
  }
}

function listLocalBranches(repo) {
  const args = ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/']
  const listed = git(repo, args)
  if (!listed.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...args], listed) }
  const branches = listed.stdout.split('\n').filter(Boolean).map((line) => {
    const [ref, oid] = line.split('\0')
    return { ref, oid }
  })
  if (branches.some((branch) => !branch.ref?.startsWith('refs/heads/') || !isGitObjectId(branch.oid))) {
    return { ok: false, error: 'git for-each-ref returned a malformed branch record' }
  }
  return { ok: true, branches }
}

function hasUnattachedLocalBranches(repo, worktrees) {
  const listed = listLocalBranches(repo)
  // A listing failure is reported by the branch pass itself.
  if (!listed.ok) return true
  const attached = new Set(worktrees.map((item) => item.branchRef).filter(Boolean))
  return listed.branches.some((branch) => !attached.has(branch.ref))
}

// Local branches that are not checked out in any worktree follow the same merge policy as
// worktree candidates: the tip is an ancestor of the default branch, is an ancestor of a
// merged GitHub PR head with a reachable merge commit, or is patch-equivalent to the default
// branch. Branches that were attached to a worktree at the start of this run are handled (or kept)
// by the worktree pass and are not reconsidered here.
async function cleanupUnattachedMergedBranches(realRepo: any, apply: any, explicitDefaultBranch: any, defaultInfo: any, defaultHead: any, worktreeBranchRefs: any, mergedPrEvidence: any, initialBranchHeads: any) {
  const results: any[] = []
  const listed = listLocalBranches(realRepo)
  if (!listed.ok) return [{ repo: realRepo, action: 'error', reason: 'branch-list-failed', detail: listed.error }]
  const defaultLocalRef = `refs/heads/${defaultInfo.name}`
  for (const { ref, oid } of listed.branches) {
    if (ref === defaultLocalRef || worktreeBranchRefs.has(ref)) continue
    const base = { repo: realRepo, target: 'branch', branch: ref.slice('refs/heads/'.length), head: oid }
    if (!initialBranchHeads.has(ref)) {
      results.push({ ...base, action: 'skip', reason: 'branch-created-during-cleanup' })
      continue
    }
    if (initialBranchHeads.get(ref) !== oid) {
      results.push({ ...base, action: 'error', reason: 'branch-head-changed-during-cleanup', detail: `${ref} changed from ${initialBranchHeads.get(ref)} to ${oid}` })
      continue
    }
    const ancestry = git(realRepo, ['merge-base', '--is-ancestor', oid, defaultInfo.ref]).ok
    let evidence = ancestry ? { method: 'ancestry', default_ref: defaultInfo.ref, default_head: defaultHead } : null
    if (!evidence) {
      const resolved = resolveMergeEvidence(realRepo, base.branch, oid, defaultInfo.ref, defaultHead, mergedPrEvidence)
      if (!resolved.ok) {
        if (resolved.code === 'patch-equivalence-query-failed') {
          results.push({ ...base, action: 'error', reason: resolved.code, detail: resolved.error, repository: resolved.repository, pr_error: resolved.pr_error })
        } else {
          // Without merge evidence the branch is kept. Unattached branches are often local work or
          // live in non-GitHub repositories, so an unavailable PR lookup is not reported as an error.
          results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found', merge_evidence_error: { code: resolved.code, detail: resolved.error, repository: resolved.repository } })
        }
        continue
      }
      evidence = resolved.evidence
    }
    if (!evidence) {
      results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found' })
      continue
    }
    const refBeforeDelete = git(realRepo, ['rev-parse', '--verify', ref])
    if (!refBeforeDelete.ok || refBeforeDelete.stdout.trim() !== oid) {
      results.push({ ...base, action: 'error', reason: 'branch-head-changed-before-delete', evidence })
      continue
    }
    const defaultBeforeDelete = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
    if (!defaultBeforeDelete.ok || defaultBeforeDelete.stdout.trim() !== defaultHead) {
      results.push({ ...base, action: 'error', reason: 'default-head-changed-before-delete', evidence })
      continue
    }
    const remoteBeforeDelete = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
    if (!remoteBeforeDelete.ok || remoteBeforeDelete.oid !== defaultHead) {
      results.push({ ...base, action: 'error', reason: remoteBeforeDelete.ok ? 'remote-default-changed-before-delete' : remoteBeforeDelete.code, detail: remoteBeforeDelete.ok ? `${remoteBeforeDelete.oid} != ${defaultHead}` : remoteBeforeDelete.error, evidence })
      continue
    }
    const evidenceError = mergeEvidenceError(realRepo, ref, oid, defaultInfo.ref, evidence, defaultHead)
    if (evidenceError) {
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-before-delete', detail: evidenceError, evidence })
      continue
    }
    if (!apply) {
      results.push({ ...base, action: 'would-delete', reason: 'merged', evidence })
      continue
    }
    const listing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
    if (!listing.ok) {
      results.push({ ...base, action: 'error', reason: 'worktree-list-before-branch-delete-failed', detail: commandDiagnostic('git', ['-C', realRepo, 'worktree', 'list', '--porcelain', '-z'], listing), evidence })
      continue
    }
    const branchSafety = await deleteLocalBranchSafely(realRepo, parseWorktrees(listing.stdout), ref, oid, defaultInfo.ref, defaultHead, evidence)
    if (!branchSafety.ok) {
      results.push({ ...base, action: 'error', reason: branchSafety.reason, detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
      continue
    }
    results.push({ ...base, action: 'deleted', reason: 'merged', evidence, branch_delete_method: branchSafety.branch_delete_method })
  }
  return results
}

function resultTarget(item) {
  if (item.path) return item.path
  if (item.target === 'branch') return `${item.repo} (branch ${item.branch})`
  return item.repo
}

function isDefaultBranchWorktreeDirty(item: { reason?: string; dirty_status?: string }) {
  return (item.reason === 'default-branch-dirty' || item.reason === 'default-branch-refresh-failed') && item.dirty_status !== undefined
}

function hasDirtyConflict(item: { dirty_status?: string }) {
  const countText = item.dirty_status?.split('。', 1)[0] || ''
  return countText.split('、').some((entry) => entry.startsWith('競合 '))
}

function cronCause(item) {
  if (isDefaultBranchWorktreeDirty(item)) return 'default branchのworktreeに未コミットの変更または未追跡ファイルがあります'
  if (item.reason === 'dirty') return '対象worktreeに未commit変更があります'
  if (item.reason === 'locked') return `対象worktreeがロックされています${item.detail ? `: ${item.detail}` : ''}`
  return item.detail ? item.detail.replaceAll(/\s+/g, ' ').trim() : '詳細情報はありません'
}

function cronNextStep(item) {
  if (isDefaultBranchWorktreeDirty(item)) {
    if (hasDirtyConflict(item)) return '競合を解消するか、進行中のmergeまたはrebaseをabortしてから、必要な変更をcommitまたは退避し、worktreeをcleanにして再実行してください'
    return '検出された変更内容を確認し、不要なキャッシュや生成物はリポジトリ外へ移動または削除し、必要な変更はcommitまたは退避して、worktreeをcleanにしてから再実行してください'
  }
  if (item.reason === 'dirty') return '変更内容を確認し、必要ならcommitまたはstashしてから再実行してください'
  if (item.reason === 'branch-created-during-cleanup') return 'cleanup中に作成されたbranchのため削除せず保持しました。現在のworktree/branch状態を確認してから再実行してください'
  if (item.reason === 'worktree-remove-failed') return 'quarantine worktreeのregistration lockを保持したまま原因を確認し、対象pathとbranchを再検証してから手動復旧してください'
  if (item.reason === 'locked') return 'worktreeの利用状況を確認し、不要なlockを解除してから再実行してください'
  if (item.action === 'error') return '原因を確認してから再実行してください'
  return null
}

function renderCron(summary) {
  const importantReasons = new Set(['empty-repository', 'prunable', 'default-branch-dirty', 'dirty', 'locked', 'ignored-files-query-failed', 'ignored-files-query-failed-after-quarantine', 'ignored-files-clean-failed', 'ignored-files-clean-unverified', 'worktree-state-changed-after-ignored-clean', 'missing-origin', 'non-github-origin', 'no-merge-evidence', 'merge-evidence-unreachable', 'github-query-failed', 'github-invalid-json', 'github-invalid-response', 'git-object-format-unreadable', 'git-object-format-unsupported', 'status-failed', 'candidate-realpath-failed', 'cleanup-lock-path-failed', 'cleanup-lock-unavailable', 'cleanup-lock-initialize-failed', 'cleanup-lock-release-failed', 'worktree-prune-failed', 'worktree-prune-unresolved', 'worktree-list-after-prune-failed', 'branch-head-changed-before-remove', 'patch-equivalence-query-failed', 'patch-equivalence-changed-before-remove', 'worktree-identity-changed-before-remove', 'worktree-registration-fence-failed', 'worktree-registration-fence-release-failed', 'worktree-registration-identity-failed', 'worktree-registration-changed-after-quarantine', 'worktree-content-lock-failed', 'worktree-content-lock-release-failed', 'worktree-quarantine-move-failed', 'worktree-head-or-branch-changed-after-quarantine', 'status-recheck-failed-before-remove', 'worktree-became-dirty-before-remove', 'worktree-remove-failed', 'worktree-remove-unverified', 'branch-created-during-cleanup', 'branch-head-changed-during-cleanup', 'branch-still-used', 'compose-query-failed', 'compose-inspect-failed', 'compose-identity-mismatch', 'compose-down-failed', 'compose-containers-still-running'])
  const report = summary.results.filter((item) => item.action === 'deleted' || item.action === 'error' || item.severity === 'warn' || importantReasons.has(item.reason))
  if (report.length === 0) return '[SILENT]\n'
  const lines = ['## merged worktree cleanup']
  for (const item of report) {
    const target = resultTarget(item)
    const evidence = item.evidence?.pr ? ` (${item.evidence.pr})` : ''
    const detail = item.detail && !isDefaultBranchWorktreeDirty(item) ? ` — ${item.detail.replaceAll(/\s+/g, ' ').trim()}` : ''
    const ignored = item.ignored_files_removed
      ? ` — ignored removed: ${item.ignored_files_removed.before_quarantine} before quarantine, ${item.ignored_files_removed.after_quarantine} after quarantine`
      : ''
    const action = item.severity === 'warn' ? 'warn' : item.action
    lines.push(`- ${action}: ${target} — ${item.reason}${evidence}${detail}${ignored}`)
    if (item.action === 'error' || item.severity === 'warn') {
      lines.push(`  原因: ${cronCause(item)}`)
      if (isDefaultBranchWorktreeDirty(item)) lines.push(`  検出: ${item.dirty_status || '変更内容を読み取れませんでした'}`)
      const nextStep = cronNextStep(item)
      if (nextStep) lines.push(`  対応: ${nextStep}`)
    }
  }
  const pruneSummary = summary.mode === 'dry-run' ? `prune予定: ${summary.would_prune}` : `prune済み: ${summary.pruned}`
  lines.push('', `削除: ${summary.deleted} / ${pruneSummary} / 警告: ${summary.warnings} / エラー: ${summary.errors} / 要確認skip: ${report.filter((item) => item.action === 'skip').length}`)
  return `${lines.join('\n')}\n`
}

async function main() {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      repo: { type: 'string', multiple: true },
      'default-branch': { type: 'string' },
      apply: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      cron: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
    strict: true,
  })
  if (values.help) return usage()
  const explicitRepos = (values.repo || []).map((repo) => path.resolve(repo))
  if (!values.root && explicitRepos.length === 0 && !config.configuredRoot) throw new Error('GIT_REPOSITORIES_ROOT is required when HOME is unset')
  const root = path.resolve(values.root || config.configuredRoot || '.')
  const apply = values.apply
  const json = values.json
  const cron = values.cron
  const explicitDefaultBranch = values['default-branch'] || null
  if (json && cron) throw new Error('--json and --cron are mutually exclusive')

  const repos = await discoverRepos(root, explicitRepos)
  const results: Array<{ action: string; reason?: string; repo?: string; path?: string; severity?: string; [key: string]: unknown }> = []
  for (const repo of repos) results.push(...await inspectRepository(repo, apply, explicitDefaultBranch))
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    root,
    repositories_checked: repos.length,
    candidates: results.length,
    deleted: results.filter((item) => item.action === 'deleted').length,
    pruned: results.filter((item) => item.action === 'pruned').length,
    would_delete: results.filter((item) => item.action === 'would-delete').length,
    would_prune: results.filter((item) => item.action === 'would-prune').length,
    skipped: results.filter((item) => item.action === 'skip').length,
    warnings: results.filter((item) => 'severity' in item && item.severity === 'warn').length,
    errors: results.filter((item) => item.action === 'error').length,
    results
  }
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else if (cron) process.stdout.write(renderCron(summary))
  else {
    process.stdout.write(`Merged worktree cleanup (${summary.mode}): ${summary.repositories_checked} repos, ${summary.deleted} deleted, ${summary.would_delete} would delete, ${summary.errors} errors\n`)
    for (const item of results) process.stdout.write(`${item.action.toUpperCase()} ${resultTarget(item)}: ${item.reason}\n`)
  }
  process.exitCode = summary.errors > 0 ? 1 : 0
}

main().catch((error) => {
  process.stderr.write(`clean-merged-branches: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
