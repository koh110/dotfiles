#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { loadCleanMergedBranchesConfig } from './clean-merged-branches-config.ts'
import { aggregatePatchEquivalence as checkAggregatePatchEquivalence } from './aggregate-patch-equivalence.ts'

const config = loadCleanMergedBranchesConfig()

function usage() {
  process.stdout.write(`Usage: clean-merged-branches [--root DIR] [--repo DIR ...] [--default-branch NAME] [--apply] [--json|--cron]\n\nDefault is dry-run. GIT_REPOSITORIES_ROOT defaults to $HOME/dev. Stale worktree registrations and stale origin tracking refs covered by origin's fetch refspec are pruned first; remote branches and refs outside that refspec are retained. Only clean, unlocked linked worktrees under GIT_REPOSITORIES_ROOT with verified merge evidence or a same-repository closed-PR head match are eligible for removal; the repository's primary checkout is never removed. Candidate worktrees are disposable and ignored content is removed before worktree deletion.\nThe default branch must come from origin/HEAD unless explicitly supplied. A worktree is removed when its HEAD is an ancestor of that branch, when its local HEAD is an ancestor of a merged GitHub PR head with a reachable merge commit, or when all of its commits are patch-equivalent to the default branch, or when its complete aggregate net patch from the merge base is present in the default tree, or when its same-repository closed PR has the same head branch and its local head matches or precedes the PR head. A closed PR is not merge evidence; an unmerged branch is removed only when another ref preserves its commits, and an open PR protects its branch. Local branches not checked out in any worktree follow the same cleanup rules. Remote branches are never deleted.\n`)
}

type RunOptions = {
  cwd?: string
  timeout?: number
  input?: string
  env?: Record<string, string | undefined>
}

function run(command: string, args: string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout || (command === 'gh' ? 60_000 : 30_000),
    killSignal: 'SIGKILL',
    env: options.env ? { ...config.environment, ...options.env } : config.environment,
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

function git(repo: string, args: string[], options: RunOptions = {}) {
  return run('git', ['-C', repo, ...args], options)
}

async function deleteBranchRefWithCas(repo: string, ref: string, expectedOid: string, defaultRef: string, expectedDefaultHead: string, verifyUnderLock: () => string | null = () => null, beforeCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true }), allowedWorktreePath: string | null = null, recoveryRef: string | null = null, recoveryOid: string | null = null, beforeRefCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true }), afterAbort: () => Promise<{ ok: boolean, error?: string }> = async () => ({ ok: true })) {
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
  const recoveryVerify = recoveryRef && recoveryOid ? `verify ${recoveryRef} ${recoveryOid}\n` : ''
  child.stdin.write(`start\nverify ${defaultRef} ${expectedDefaultHead}\n${recoveryVerify}delete ${ref} ${expectedOid}\nprepare\n`)
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
  let preCommit
  try {
    preCommit = await beforeCommit()
  } catch (error) {
    preCommit = { ok: false, reason: 'branch-delete-failed', error: errorText(error) }
  }
  if (!preCommit.ok) {
    await abort()
    let cleanupError = ''
    try {
      const released = await afterAbort()
      if (!released.ok) cleanupError = `; pre-commit lock release failed: ${released.error || 'unknown error'}`
    } catch (error) {
      cleanupError = `; pre-commit lock release failed: ${errorText(error)}`
    }
    const failed = result()
    return {
      ok: false,
      committed: false,
      reason: preCommit.reason || 'branch-delete-failed',
      error: `${preCommit.error || 'pre-commit cleanup failed'}${cleanupError}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}`,
    }
  }
  const evidenceError = verifyUnderLock()
  if (evidenceError) {
    await abort()
    let cleanupError = ''
    try {
      const released = await afterAbort()
      if (!released.ok) cleanupError = `; pre-commit lock release failed: ${released.error || 'unknown error'}`
    } catch (error) {
      cleanupError = `; pre-commit lock release failed: ${errorText(error)}`
    }
    const failed = result()
    return {
      ok: false,
      committed: false,
      reason: 'merge-evidence-changed-after-quarantine',
      error: `${evidenceError}${cleanupError}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}`,
    }
  }
  let preRefCommit
  try {
    preRefCommit = await beforeRefCommit()
  } catch (error) {
    preRefCommit = { ok: false, reason: 'branch-delete-failed', error: errorText(error) }
  }
  if (!preRefCommit.ok) {
    await abort()
    let cleanupError = ''
    try {
      const released = await afterAbort()
      if (!released.ok) cleanupError = `; pre-commit lock release failed: ${released.error || 'unknown error'}`
    } catch (error) {
      cleanupError = `; pre-commit lock release failed: ${errorText(error)}`
    }
    const failed = result()
    return {
      ok: false,
      committed: false,
      reason: preRefCommit.reason || 'branch-delete-failed',
      error: `${preRefCommit.error || 'pre-ref-commit cleanup failed'}${cleanupError}${failed.ok ? '' : `; transaction=${commandDiagnostic('git', command, failed)}`}`,
    }
  }
  child.stdin.write('commit\n')
  child.stdin.end()
  await finished
  const committed = result()
  if (committed.ok && hasAck('commit')) return { ...committed, committed: true }
  let cleanupError = ''
  try {
    const released = await afterAbort()
    if (!released.ok) cleanupError = `; pre-commit lock release failed: ${released.error || 'unknown error'}`
  } catch (error) {
    cleanupError = `; pre-commit lock release failed: ${errorText(error)}`
  }
  return { ...committed, committed: false, error: `${commandDiagnostic('git', command, committed)}; update-ref commit acknowledgement was not received${cleanupError}` }
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

function closedPullRequestEvidenceError(repo: string, branchRef: string, expectedHead: string, evidence: any): string | null {
  const branch = branchRef.replace(/^refs\/heads\//, '')
  if (branchRef !== `refs/heads/${evidence.head_ref}` || expectedHead !== evidence.branch_head) {
    return `${branchRef}@${expectedHead} no longer matches its closed PR evidence`
  }
  const remote = git(repo, ['config', '--get', 'remote.origin.url'])
  if (!remote.ok) return commandDiagnostic('git', ['-C', repo, 'config', '--get', 'remote.origin.url'], remote)
  const target = ownerRepo(remote.stdout)
  if (!target || target !== evidence.repository || evidence.head_repository !== target) {
    return `${branchRef} closed PR repository changed before deletion`
  }
  const objectFormat = gitObjectIdLength(repo)
  if (!objectFormat.ok) return objectFormat.error
  const currentPulls = queryPullRequests(target, objectFormat.length, PULL_REQUEST_BRANCH_LIMIT, branch)
  if (!currentPulls.ok) return `closed PR #${evidence.number} revalidation failed: ${currentPulls.error}`
  if (currentPulls.truncated) return `closed PR #${evidence.number} revalidation returned a truncated branch list`
  const openPull = currentPulls.pulls.find((pull) => pull.state === 'OPEN' && pull.headRepository?.nameWithOwner === target)
  if (openPull) return `open PR #${openPull.number} now protects ${branch}`
  const pull = currentPulls.pulls.find((candidate) => candidate.number === evidence.number)
  if (!pull) return `closed PR #${evidence.number} is no longer listed for ${branch}`
  if (pull.url !== evidence.pr || pull.state !== 'CLOSED' || pull.mergedAt !== null) {
    return `PR #${evidence.number} is no longer closed and unmerged`
  }
  if (pull.headRefName !== branch || pull.headRefOid !== evidence.pr_head || pull.headRepository?.nameWithOwner !== target || pull.baseRefName !== evidence.base_ref) {
    return `PR #${evidence.number} head or repository changed before deletion`
  }
  if (evidence.head_relation === 'exact' && expectedHead === pull.headRefOid) return null
  if (evidence.head_relation === 'ancestor' && git(repo, ['merge-base', '--is-ancestor', expectedHead, pull.headRefOid]).ok) return null
  return `PR #${evidence.number} no longer contains ${branchRef}@${expectedHead}`
}

function openPullRequestEvidenceError(repo: string, branchRef: string, evidence: any): string | null {
  const branch = evidence.head_ref
  if (branchRef !== `refs/heads/${branch}`) return `${branchRef} no longer matches its GitHub head branch evidence`
  const remote = git(repo, ['config', '--get', 'remote.origin.url'])
  if (!remote.ok) return commandDiagnostic('git', ['-C', repo, 'config', '--get', 'remote.origin.url'], remote)
  const target = ownerRepo(remote.stdout)
  if (!target || target !== evidence.repository) return `${branchRef} GitHub repository changed before deletion`
  const objectFormat = gitObjectIdLength(repo)
  if (!objectFormat.ok) return objectFormat.error
  const currentPulls = queryPullRequests(target, objectFormat.length, PULL_REQUEST_BRANCH_LIMIT, branch)
  if (!currentPulls.ok) return `PR state revalidation failed for ${branch}: ${currentPulls.error}`
  const openPull = currentPulls.pulls.find((pull) => pull.state === 'OPEN' && pull.headRefName === branch && pull.headRepository?.nameWithOwner === target)
  if (openPull) return `open PR #${openPull.number} now protects ${branch}`
  if (currentPulls.truncated) return `PR state revalidation returned a truncated branch list for ${branch}`
  return null
}

function closedPrRecoveryRef(repo: string, branchRef: string, expectedHead: string): { ok: true, ref: string | null, oid: string | null } | { ok: false, error: string } {
  const args = ['for-each-ref', '--contains', expectedHead, '--format=%(refname)%00%(objectname)']
  const listed = git(repo, args)
  if (!listed.ok) return { ok: false, error: commandDiagnostic('git', ['-C', repo, ...args], listed) }
  const refs = listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, oid] = line.split('\0')
    return { ref, oid }
  })
  if (refs.some((item) => !item.ref || !isGitObjectId(item.oid))) return { ok: false, error: 'git for-each-ref returned a malformed recovery ref record' }
  const recovery = refs.find((item) => item.ref !== branchRef)
  return { ok: true, ref: recovery?.ref || null, oid: recovery?.oid || null }
}

function cleanupEvidenceError(repo: string, branchRef: string, expectedHead: string, defaultRef: string, evidence: any, expectedDefaultHead: string = evidence.default_head, checkOpenPullRequest = true) {
  if (!isGitObjectId(expectedDefaultHead)) return `invalid expected default ref OID for ${defaultRef}: ${expectedDefaultHead || '<missing>'}`
  const defaultResult = git(repo, ['rev-parse', '--verify', defaultRef])
  if (!defaultResult.ok) return commandDiagnostic('git', ['-C', repo, 'rev-parse', '--verify', defaultRef], defaultResult)
  const actualDefaultHead = defaultResult.stdout.trim()
  if (actualDefaultHead !== expectedDefaultHead) return `default ref changed: ${actualDefaultHead || '<missing>'} != ${expectedDefaultHead}`
  if (evidence.method === 'closed-pr') return closedPullRequestEvidenceError(repo, branchRef, expectedHead, evidence)
  if (checkOpenPullRequest && evidence.method !== 'closed-pr' && evidence.repository && evidence.head_ref) {
    const openPullError = openPullRequestEvidenceError(repo, branchRef, evidence)
    if (openPullError) return openPullError
  }
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
  if (evidence.method === 'aggregate-patch-equivalence') {
    const patch = checkAggregatePatchEquivalence(repo, expectedHead, defaultRef, git)
    if (!patch.ok) return patch.error || 'aggregate patch-equivalence query failed'
    if (!patch.merged) return `${branchRef}@${expectedHead} aggregate patch is no longer present in ${defaultRef}`
    if (patch.merge_base !== evidence.merge_base || patch.commit_count !== evidence.commit_count || patch.changed_path_count !== evidence.changed_path_count) {
      return `${branchRef}@${expectedHead} aggregate patch evidence changed before deletion`
    }
    return null
  }
  return `unsupported merge evidence for ${branchRef}: ${evidence.method || '<missing>'}`
}

function cleanupReason(evidence: any) {
  return evidence.method === 'closed-pr' ? 'closed-pr' : 'merged'
}

// merge確認済みまたはclosed PRで候補となったlocal branchを、worktreeで使用されていない場合に削除する。
// `git branch -d`はupstream基準のmergedness判定で拒否する場合があるため使わず、ref CAS transaction中にevidenceとworktree使用状況を再検証する。
// closed PRについては、別のrefが未merge commitを保持していることも同じtransactionで確認する。
async function deleteLocalBranchSafely(repo: string, worktreeRecords: any[], branchRef: string, expectedHead: string, defaultRef: string, expectedDefaultHead: string, evidence: any, allowedWorktreePath: string | null = null, beforeCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true }), beforeRefCommit: () => Promise<{ ok: boolean, reason?: string, error?: string }> = async () => ({ ok: true }), afterAbort: () => Promise<{ ok: boolean, error?: string }> = async () => ({ ok: true })) {
  const branchDeleteMethod = evidence.method === 'ancestry'
    ? 'git-update-ref-transaction-cas-with-ancestry-evidence'
    : evidence.method === 'patch-equivalence'
      ? 'git-update-ref-transaction-cas-with-patch-equivalence-evidence'
      : evidence.method === 'aggregate-patch-equivalence'
        ? 'git-update-ref-transaction-cas-with-aggregate-patch-equivalence-evidence'
        : evidence.method === 'closed-pr'
          ? 'git-update-ref-transaction-cas-with-closed-pr-evidence'
        : 'git-update-ref-transaction-cas-with-merge-evidence'
  const headLocks = await acquireWorktreeHeadLocks(worktreeRecords)
  if (!headLocks.ok) return { ok: false, reason: 'worktree-head-lock-failed', detail: headLocks.error, branch_delete_method: branchDeleteMethod }
  let outcome: { ok: boolean, reason: string, detail?: string, branch_delete_method: string, branch_retained?: boolean, branch_retained_reason?: string } = { ok: false, reason: 'branch-delete-failed', detail: 'branch deletion did not run', branch_delete_method: branchDeleteMethod }
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
        const recovery = evidence.method === 'closed-pr' ? closedPrRecoveryRef(repo, branchRef, expectedHead) : null
        if (recovery && (!recovery.ok || !recovery.ref || !recovery.oid)) {
          outcome = {
            ok: true,
            reason: 'closed-pr-branch-retained',
            branch_retained: true,
            branch_retained_reason: recovery.ok ? 'closed-pr-local-commit-not-recoverable' : 'closed-pr-recovery-ref-check-unavailable',
            detail: recovery.ok ? 'no other ref preserves this unmerged commit' : recovery.error,
            branch_delete_method: 'closed-pr-local-commit-retained',
          }
        } else {
        const branchDelete = await deleteBranchRefWithCas(repo, branchRef, expectedHead, defaultRef, expectedDefaultHead, () => cleanupEvidenceError(repo, branchRef, expectedHead, defaultRef, evidence, expectedDefaultHead), beforeCommit, allowedWorktreePath, recovery?.ref || null, recovery?.oid || null, beforeRefCommit, afterAbort)
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
            outcome = { ok: true, reason: 'branch-deleted', branch_delete_method: branchDeleteMethod }
            }
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

async function acquireInitialRegistrationFences(repo: string, eligibleRoot: string | null) {
  const commonDirResult = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!commonDirResult.ok || !path.isAbsolute(commonDirResult.stdout.trim())) {
    return {
      ok: false,
      error: !commonDirResult.ok
        ? commandDiagnostic('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], commonDirResult)
        : `git common directory is not absolute: ${commonDirResult.stdout.trim() || '<empty>'}`,
    }
  }
  if (!eligibleRoot) return { ok: true, fences: new Map(), allowedRoot: null, release: async () => ({ ok: true }) }
  let allowedRoot: string
  try {
    allowedRoot = await fs.realpath(eligibleRoot)
  } catch (error) {
    return { ok: false, error: `eligible worktree root query failed: ${errorText(error)}` }
  }
  if (allowedRoot !== eligibleRoot) return { ok: false, error: `eligible worktree root identity changed: ${allowedRoot} != ${eligibleRoot}` }
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

type OriginTrackingRef = { ref: string; branch: string; oid: string }

function listOriginTrackingRefs(repo: string) {
  const args = ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes/origin/']
  const result = git(repo, args)
  if (!result.ok) return { ok: false as const, refs: null, error: commandDiagnostic('git', ['-C', repo, ...args], result) }
  const refs = new Map<string, string>()
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const [ref, oid, ...extra] = line.split('\0')
    if (extra.length > 0 || !ref?.startsWith('refs/remotes/origin/') || !isGitObjectId(oid)) {
      return { ok: false as const, refs: null, error: 'git for-each-ref returned a malformed origin tracking ref record' }
    }
    refs.set(ref, oid)
  }
  return { ok: true as const, refs, error: null }
}

function originPruneCandidates(repo: string) {
  const remotes = git(repo, ['remote'])
  if (!remotes.ok) return { ok: false as const, error: commandDiagnostic('git', ['-C', repo, 'remote'], remotes) }
  if (!remotes.stdout.split(/\r?\n/).includes('origin')) return { ok: true as const, candidates: [] }
  const localRefs = listOriginTrackingRefs(repo)
  if (!localRefs.ok || !localRefs.refs) return { ok: false as const, error: localRefs.error || 'origin refs could not be read' }
  const args = ['remote', 'prune', '--dry-run', 'origin']
  const preview = git(repo, args, { timeout: 120_000 })
  if (!preview.ok) return { ok: false as const, error: commandDiagnostic('git', ['-C', repo, ...args], preview) }
  const candidates: OriginTrackingRef[] = []
  for (const line of preview.stdout.split(/\r?\n/)) {
    if (!line.includes('[would prune]')) continue
    const match = line.match(/^\s*\*\s+\[would prune\]\s+(origin\/.+)$/)
    if (!match) return { ok: false as const, error: `git remote prune returned a malformed stale ref record: ${line}` }
    const ref = `refs/remotes/${match[1]}`
    const validRef = git(repo, ['check-ref-format', ref])
    if (ref === 'refs/remotes/origin/HEAD' || !validRef.ok) return { ok: false as const, error: `git remote prune returned an invalid origin ref: ${ref}` }
    const oid = localRefs.refs.get(ref)
    if (!oid) return { ok: false as const, error: `stale origin ref was not present in the local snapshot: ${ref}` }
    candidates.push({ ref, branch: match[1], oid })
  }
  if (new Set(candidates.map((item) => item.ref)).size !== candidates.length) {
    return { ok: false as const, error: 'git remote prune returned duplicate stale origin refs' }
  }
  return { ok: true as const, candidates }
}

function originTrackingRefResult(repo: string, item: OriginTrackingRef, action: 'would-prune' | 'pruned' | 'error', detail?: string) {
  return {
    repo,
    target: 'remote-tracking-ref',
    ref: item.ref,
    branch: item.branch,
    head: item.oid,
    action,
    reason: 'stale-origin-tracking-ref',
    detail,
  }
}

function pruneOriginTrackingRefs(repo: string, apply: boolean) {
  const preview = originPruneCandidates(repo)
  if (!preview.ok) return { ok: false, results: [{ repo, action: 'error', reason: 'origin-tracking-ref-prune-query-failed', detail: preview.error }] }
  if (preview.candidates.length === 0) return { ok: true, results: [] }
  if (!apply) return { ok: true, results: preview.candidates.map((item) => originTrackingRefResult(repo, item, 'would-prune')) }

  // Apply only the exact ref/OID snapshot after a second dry-run confirms the same candidate set.
  // Never use `git remote prune` for mutation: its broader refspec scope can change after preview.
  const confirmation = originPruneCandidates(repo)
  if (!confirmation.ok) {
    return { ok: false, results: [{ repo, action: 'error', reason: 'origin-tracking-ref-prune-confirmation-failed', detail: confirmation.error }] }
  }
  const expected = new Map(preview.candidates.map((item) => [item.ref, item.oid]))
  const confirmed = new Map(confirmation.candidates.map((item) => [item.ref, item.oid]))
  if (expected.size !== confirmed.size || [...expected].some(([ref, oid]) => confirmed.get(ref) !== oid)) {
    return {
      ok: false,
      results: [{
        repo,
        action: 'error',
        reason: 'origin-tracking-ref-prune-candidate-set-changed',
        detail: 'origin stale-ref candidates or expected object IDs changed between preview and apply; no refs were deleted',
      }],
    }
  }

  const deleted = []
  const results = []
  for (const item of preview.candidates) {
    const removed = git(repo, ['update-ref', '-d', item.ref, item.oid])
    if (!removed.ok) {
      results.push(originTrackingRefResult(
        repo,
        item,
        'error',
        commandDiagnostic('git', ['-C', repo, 'update-ref', '-d', item.ref, item.oid], removed),
      ))
      continue
    }
    deleted.push(item)
  }

  const after = listOriginTrackingRefs(repo)
  if (!after.ok) {
    return {
      ok: false,
      results: [...results, { repo, action: 'error', reason: 'origin-tracking-ref-prune-readback-failed', detail: after.error }],
    }
  }
  for (const item of deleted) {
    const currentOid = after.refs.get(item.ref)
    if (currentOid === undefined) {
      results.push(originTrackingRefResult(repo, item, 'pruned'))
    } else if (currentOid === item.oid) {
      results.push(originTrackingRefResult(repo, item, 'error', `${item.ref} remains after compare-and-delete`))
    } else {
      results.push(originTrackingRefResult(repo, { ...item, oid: currentOid }, 'error', `${item.ref} changed during compare-and-delete`))
    }
  }
  return { ok: results.every((item) => item.action !== 'error'), results }
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

async function resolvePrimaryCheckout(repo: string) {
  const realCandidate = await fs.realpath(repo).catch(() => null)
  const gitDirResult = git(repo, ['rev-parse', '--path-format=absolute', '--git-dir'])
  const commonDirResult = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!realCandidate || !gitDirResult.ok || !commonDirResult.ok) return null
  const realGitDir = await fs.realpath(gitDirResult.stdout.trim()).catch(() => null)
  const realCommonDir = await fs.realpath(commonDirResult.stdout.trim()).catch(() => null)
  if (!realGitDir || !realCommonDir) return null
  if (realGitDir === realCommonDir) return { repo: realCandidate, commonDir: realCommonDir }

  const listing = git(repo, ['worktree', 'list', '--porcelain', '-z'])
  if (!listing.ok) return null
  for (const worktree of parseWorktrees(listing.stdout)) {
    const candidate = path.resolve(worktree.path)
    const realWorktree = await fs.realpath(candidate).catch(() => null)
    if (!realWorktree) continue
    const worktreeGitDir = git(candidate, ['rev-parse', '--path-format=absolute', '--git-dir'])
    if (!worktreeGitDir.ok) continue
    const realWorktreeGitDir = await fs.realpath(worktreeGitDir.stdout.trim()).catch(() => null)
    if (realWorktreeGitDir === realCommonDir) return { repo: realWorktree, commonDir: realCommonDir }
  }
  return null
}

async function discoverRepos(root: string, explicitRepos: string[]) {
  if (explicitRepos.length) {
    const repos = new Set()
    for (const repo of explicitRepos) {
      const primary = await resolvePrimaryCheckout(path.resolve(repo))
      if (!primary) throw new Error(`could not resolve the primary checkout for --repo ${repo}`)
      repos.add(primary.repo)
    }
    return [...repos].sort()
  }

  const reposByCommonDir = new Map()
  const entries = await fs.readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'tmp') continue
    const candidate = path.join(root, entry.name)
    try {
      await fs.access(path.join(candidate, '.git'))
      const primary = await resolvePrimaryCheckout(candidate)
      if (primary) reposByCommonDir.set(primary.commonDir, primary.repo)
    } catch {
      // Not a root checkout or linked worktree.
    }
  }
  return [...new Set(reposByCommonDir.values())].sort()
}

async function resolveEligibleWorktreeRoot(repo: string, managedRoot: string | null) {
  if (managedRoot) {
    try {
      return { ok: true, path: await fs.realpath(managedRoot) }
    } catch (error) {
      return { ok: false, path: null, error: `managed worktree root query failed: ${errorText(error)}` }
    }
  }

  const localRoot = path.join(repo, '.worktree')
  try {
    const realLocalRoot = await fs.realpath(localRoot)
    if (!isWithin(realLocalRoot, repo)) return { ok: false, path: null, error: `eligible worktree root escapes repository: ${realLocalRoot}` }
    return { ok: true, path: realLocalRoot }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') return { ok: true, path: null }
    return { ok: false, path: null, error: `eligible worktree root query failed: ${errorText(error)}` }
  }
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

function isSameOrWithin(child: string, parent: string) {
  const relative = path.relative(parent, child)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function processErrorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

function processPathIsWithin(target: string, value: string) {
  const pathname = value.endsWith(' (deleted)') ? value.slice(0, -' (deleted)'.length) : value
  return path.isAbsolute(pathname) && isSameOrWithin(path.resolve(pathname), target)
}

async function processStartTime(pid: string) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const closingParen = stat.lastIndexOf(')')
    if (closingParen < 0) return { ok: false, error: `/proc/${pid}/stat has no process-name terminator` }
    const startTime = stat.slice(closingParen + 2).trim().split(/\s+/)[19]
    if (!/^\d+$/.test(startTime || '')) return { ok: false, error: `/proc/${pid}/stat has an invalid start time` }
    return { ok: true, startTime }
  } catch (error) {
    if (processErrorCode(error) === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: `/proc/${pid}/stat could not be read: ${errorText(error)}` }
  }
}

async function processLink(pid: string, name: string) {
  try {
    return { ok: true, path: await fs.readlink(`/proc/${pid}/${name}`) }
  } catch (error) {
    const code = processErrorCode(error)
    if (code === 'ENOENT' || code === 'ESRCH' || code === 'EINVAL') return { ok: true, path: null }
    return { ok: false, error: `/proc/${pid}/${name} could not be read: ${errorText(error)}`, code }
  }
}

async function processUsesWorktree(worktreePath: string) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    return { ok: false, error: 'process-usage inspection requires Linux /proc and a process UID' }
  }
  let target: string
  try {
    target = await fs.realpath(worktreePath)
  } catch (error) {
    return { ok: false, error: `worktree realpath could not be read: ${errorText(error)}` }
  }
  let entries
  try {
    entries = await fs.readdir('/proc')
  } catch (error) {
    return { ok: false, error: `/proc could not be listed: ${errorText(error)}` }
  }

  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue
    let status
    try {
      status = await fs.readFile(`/proc/${pid}/status`, 'utf8')
    } catch (error) {
      if (processErrorCode(error) === 'ENOENT') continue
      return { ok: false, error: `/proc/${pid}/status could not be read: ${errorText(error)}` }
    }
    const uidLine = status.split('\n').find((line) => line.startsWith('Uid:'))
    const uidValues = uidLine?.trim().split(/\s+/).slice(1).map(Number)
    if (!uidValues || uidValues.length < 4 || uidValues.some((value) => !Number.isInteger(value))) {
      return { ok: false, error: `/proc/${pid}/status has an invalid UID record` }
    }
    if (!uidValues.includes(process.getuid())) continue
    const processName = status.split('\n').find((line) => line.startsWith('Name:'))?.slice('Name:'.length).trim()
    const before = await processStartTime(pid)
    if (!before.ok) return { ok: false, error: before.error }
    if (before.gone) continue
    let usage = null
    for (const name of ['cwd', 'exe']) {
      const linked = await processLink(pid, name)
      if (!linked.ok) return { ok: false, error: `/proc/${pid} (${processName || 'unknown'})/${name} could not be read: ${linked.error}` }
      if (linked.path && processPathIsWithin(target, linked.path)) {
        usage = name
        break
      }
    }
    if (!usage) {
      let descriptors: string[] = []
      try {
        descriptors = await fs.readdir(`/proc/${pid}/fd`)
      } catch (error) {
        const code = processErrorCode(error)
        if (code === 'ENOENT') descriptors = []
        else return { ok: false, error: `/proc/${pid}/fd could not be listed: ${errorText(error)}` }
      }
      for (const descriptor of descriptors || []) {
        const linked = await processLink(pid, `fd/${descriptor}`)
        if (!linked.ok) return { ok: false, error: linked.error }
        if (linked.path && processPathIsWithin(target, linked.path)) {
          usage = `fd/${descriptor}`
          break
        }
      }
    }

    const after = await processStartTime(pid)
    if (!after.ok) return { ok: false, error: after.error }
    if (after.gone) continue
    if (after.startTime !== before.startTime) return { ok: false, error: `process ${pid} identity changed during worktree usage inspection` }
    if (usage) return { ok: true, used: true, pid, location: usage }
  }
  return { ok: true, used: false }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function gitObjectIdLength(repo: string): { ok: true, length: number } | { ok: false, code: string, error: string } {
  const result = git(repo, ['rev-parse', '--show-object-format'])
  if (!result.ok) return { ok: false, code: 'git-object-format-unreadable', error: commandDiagnostic('git', ['-C', repo, 'rev-parse', '--show-object-format'], result) }
  const format = result.stdout.trim()
  if (format === 'sha1') return { ok: true, length: 40 }
  if (format === 'sha256') return { ok: true, length: 64 }
  return { ok: false, code: 'git-object-format-unsupported', error: `unsupported Git object format: ${format || '<empty>'}` }
}

type PullRequest = {
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergedAt: string | null
  headRefName: string
  headRefOid: string
  baseRefName: string
  headRepository: { nameWithOwner: string } | null
  mergeCommit: { oid: string } | null
}

type PullRequestQuery = { ok: true, pulls: PullRequest[], truncated: boolean } | { ok: false, code: string, error: string }
type PullListValidation = { ok: true, pulls: PullRequest[] } | { ok: false, error: string }
type PullRequestContext = { ok: true, target: string, oidLength: number } | { ok: false, code: string, error: string, repository?: string }
type PullRequestEvidenceResult = {
  ok: true
  repository: string
  openPull: PullRequest | null
  match: PullRequest | null
  closedMatch: PullRequest | null
  mergeCommit: string | null
  prHead: string | null
  closedHead: string | null
  headRelation: 'exact' | 'ancestor' | null
} | { ok: false, code: string, error: string, repository?: string, mergeCommit?: string | null }
type CleanupEvidence =
  | { method: 'ancestry', default_ref: string, default_head: string, repository?: string, head_ref: string }
  | { method: 'github-merge-commit', pr: string, number: number, merged_at: string, merge_commit: string, pr_head: string, head_relation: 'exact' | 'ancestor', default_ref: string, default_head: string, repository?: string, head_ref: string }
  | { method: 'patch-equivalence', default_ref: string, default_head: string, commit_count: number, repository?: string, head_ref: string }
  | { method: 'aggregate-patch-equivalence', default_ref: string, default_head: string, merge_base: string, commit_count: number, changed_path_count: number, repository?: string, head_ref: string }
  | { method: 'closed-pr', pr: string, number: number, state: 'CLOSED', repository: string, head_repository: string, head_ref: string, pr_head: string, branch_head: string, head_relation: 'exact' | 'ancestor', base_ref: string, default_ref: string, default_head: string }
type CleanupEvidenceResolution =
  | { ok: false, code: string, error: string, repository?: string, pr_error?: { code: string, detail: string } }
  | { ok: true, evidence: CleanupEvidence | null, skip_reason?: string, detail?: string }

const PULL_REQUEST_BATCH_LIMIT = 1000
const PULL_REQUEST_BRANCH_LIMIT = 100
const PULL_REQUEST_FIELDS = 'number,url,state,mergedAt,headRefName,headRefOid,baseRefName,headRepository,mergeCommit'

function validatePullList(pulls: unknown, oidLength: number): PullListValidation {
  if (!Array.isArray(pulls)) return { ok: false, error: 'gh pr list response must be an array' }
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`)
  const validatedPulls: PullRequest[] = []
  const values: unknown[] = pulls
  for (const value of values) {
    if (!isRecord(value)) return { ok: false, error: 'gh pr list response contains an invalid pull object' }
    const number = value.number
    const url = value.url
    const state = value.state
    const mergedAt = value.mergedAt
    const headRefName = value.headRefName
    const headRefOid = value.headRefOid
    const baseRefName = value.baseRefName
    const headRepository = value.headRepository
    const mergeCommit = value.mergeCommit
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || typeof url !== 'string' || url.length === 0 || (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') || (mergedAt !== null && typeof mergedAt !== 'string')) {
      return { ok: false, error: 'gh pr list response contains an invalid pull object' }
    }
    if (typeof headRefName !== 'string' || headRefName.length === 0) return { ok: false, error: 'gh pr list headRefName is invalid' }
    if (typeof headRefOid !== 'string' || !oidPattern.test(headRefOid)) return { ok: false, error: 'gh pr list headRefOid is invalid' }
    if (typeof baseRefName !== 'string' || baseRefName.length === 0) return { ok: false, error: 'gh pr list baseRefName is invalid' }
    if ((state === 'MERGED') !== (mergedAt !== null)) return { ok: false, error: 'gh pr list state and mergedAt are inconsistent' }
    let normalizedHeadRepository: PullRequest['headRepository'] = null
    if (headRepository !== null) {
      if (!isRecord(headRepository)) return { ok: false, error: 'gh pr list headRepository is invalid' }
      const nameWithOwner = headRepository.nameWithOwner
      if (typeof nameWithOwner !== 'string' || nameWithOwner.length === 0) return { ok: false, error: 'gh pr list headRepository is invalid' }
      normalizedHeadRepository = { nameWithOwner }
    }
    let normalizedMergeCommit: PullRequest['mergeCommit'] = null
    if (mergeCommit !== null) {
      if (!isRecord(mergeCommit)) return { ok: false, error: 'gh pr list mergeCommit is invalid' }
      const oid = mergeCommit.oid
      if (typeof oid !== 'string' || !oidPattern.test(oid)) return { ok: false, error: 'gh pr list mergeCommit is invalid' }
      normalizedMergeCommit = { oid }
    }
    validatedPulls.push({
      number,
      url,
      state,
      mergedAt,
      headRefName,
      headRefOid,
      baseRefName,
      headRepository: normalizedHeadRepository,
      mergeCommit: normalizedMergeCommit,
    })
  }
  return { ok: true, pulls: validatedPulls }
}

function queryPullRequests(target: string, oidLength: number, limit: number, headBranch: string | null = null): PullRequestQuery {
  const args = ['pr', 'list', '--repo', target, '--state', 'all', '--limit', String(limit), '--json', PULL_REQUEST_FIELDS]
  if (headBranch) args.push('--head', headBranch)
  const response = run('gh', args, { timeout: 120_000 })
  if (!response.ok) return { ok: false, code: 'github-query-failed', error: (response.stderr || response.error || '').trim() }
  let decoded: unknown
  try {
    decoded = JSON.parse(response.stdout)
  } catch (error) {
    return { ok: false, code: 'github-invalid-json', error: errorText(error) }
  }
  const validatedPulls = validatePullList(decoded, oidLength)
  if (!validatedPulls.ok) return { ok: false, code: 'github-invalid-response', error: validatedPulls.error }
  const pulls = validatedPulls.pulls
  return { ok: true, pulls, truncated: pulls.length >= limit }
}

// closed PRは同一repository内の同名head branchに限って候補とし、local HEADがPR headと一致するか、その祖先であることを要求する。
// 同じrepositoryのopen PRがあれば、merge状態にかかわらずcleanupを止める。
function createPullRequestLookup(repo: string, defaultName: string, defaultRef: string) {
  let context: PullRequestContext | null = null
  let batch: PullRequestQuery | null = null
  function loadContext(): PullRequestContext {
    if (context) return context
    const remote = git(repo, ['config', '--get', 'remote.origin.url'])
    if (!remote.ok) return (context = { ok: false, code: 'missing-origin', error: remote.stderr.trim() })
    const target = ownerRepo(remote.stdout)
    if (!target) return (context = { ok: false, code: 'non-github-origin', error: remote.stdout.trim() })
    const objectFormat = gitObjectIdLength(repo)
    if (!objectFormat.ok) return (context = { ok: false, code: objectFormat.code, error: objectFormat.error, repository: target })
    return (context = { ok: true, target, oidLength: objectFormat.length })
  }
  function matchPulls(pulls: PullRequest[], target: string, branch: string, head: string): PullRequestEvidenceResult {
    const branchPulls = pulls.filter((pull) => pull.headRefName === branch)
    const openPull = branchPulls.find((pull) => pull.state === 'OPEN' && pull.headRepository?.nameWithOwner === target)
    if (openPull) return { ok: true, openPull, match: null, closedMatch: null, mergeCommit: null, prHead: null, closedHead: null, headRelation: null, repository: target }
    let unreachable: { pull: PullRequest, mergeCommit: string | null } | null = null
    for (const pull of branchPulls) {
      if (pull.state !== 'MERGED' || pull.baseRefName !== defaultName) continue
      const exactHead = pull.headRefOid === head
      const ancestorHead = !exactHead
        && git(repo, ['cat-file', '-e', `${pull.headRefOid}^{commit}`]).ok
        && git(repo, ['merge-base', '--is-ancestor', head, pull.headRefOid]).ok
      if (!exactHead && !ancestorHead) continue
      const mergeCommit = pull.mergeCommit?.oid || null
      const mergeCommitExists = Boolean(mergeCommit && git(repo, ['cat-file', '-e', `${mergeCommit}^{commit}`]).ok)
      const mergeCommitReachable = Boolean(mergeCommitExists && mergeCommit && git(repo, ['merge-base', '--is-ancestor', mergeCommit, defaultRef]).ok)
      if (mergeCommitReachable && mergeCommit) return { ok: true, match: pull, openPull: null, closedMatch: null, repository: target, mergeCommit, prHead: pull.headRefOid, headRelation: exactHead ? 'exact' : 'ancestor', closedHead: null }
      unreachable ||= { pull, mergeCommit }
    }
    if (unreachable) return { ok: false, code: 'merge-evidence-unreachable', error: `PR #${unreachable.pull.number} merge commit is not reachable from ${defaultRef}`, repository: target, mergeCommit: unreachable.mergeCommit }
    for (const pull of branchPulls) {
      if (pull.state !== 'CLOSED' || pull.mergedAt !== null || pull.headRepository?.nameWithOwner !== target) continue
      const exactHead = pull.headRefOid === head
      const ancestorHead = !exactHead
        && git(repo, ['cat-file', '-e', `${pull.headRefOid}^{commit}`]).ok
        && git(repo, ['merge-base', '--is-ancestor', head, pull.headRefOid]).ok
      if (exactHead || ancestorHead) {
        return {
          ok: true,
          closedMatch: pull,
          openPull: null,
          match: null,
          mergeCommit: null,
          repository: target,
          closedHead: head,
          headRelation: exactHead ? 'exact' : 'ancestor',
          prHead: null,
        }
      }
    }
    return { ok: true, match: null, openPull: null, closedMatch: null, mergeCommit: null, prHead: null, closedHead: null, headRelation: null, repository: target }
  }
  return function pullRequestEvidence(branch: string, head: string): PullRequestEvidenceResult {
    const ctx = loadContext()
    if (!ctx.ok) return ctx
    if (!batch) batch = queryPullRequests(ctx.target, ctx.oidLength, PULL_REQUEST_BATCH_LIMIT)
    if (!batch.ok) return { ...batch, repository: ctx.target }
    const matched = matchPulls(batch.pulls, ctx.target, branch, head)
    if (!batch.truncated || (matched.ok && matched.openPull)) return matched
    const single = queryPullRequests(ctx.target, ctx.oidLength, PULL_REQUEST_BRANCH_LIMIT, branch)
    if (!single.ok) return { ...single, repository: ctx.target }
    const branchMatch = matchPulls(single.pulls, ctx.target, branch, head)
    if (branchMatch.ok && branchMatch.openPull) return branchMatch
    if (single.truncated) {
      return {
        ok: false,
        code: 'github-query-truncated',
        error: `gh pr list returned at least ${PULL_REQUEST_BRANCH_LIMIT} records for head branch ${branch}`,
        repository: ctx.target,
      }
    }
    return branchMatch
  }
}

function openPullRequestGuard(branch: string, pr: PullRequestEvidenceResult) {
  if (pr.ok && pr.openPull) {
    return {
      ok: true as const,
      skip_reason: 'open-pull-request',
      detail: `open PR #${pr.openPull.number} protects ${branch}`,
      repository: pr.repository,
    }
  }
  if (!pr.ok && pr.repository && pr.code !== 'merge-evidence-unreachable') {
    return { ok: false as const, code: pr.code, error: pr.error, repository: pr.repository }
  }
  return { ok: true as const, skip_reason: null, repository: pr.repository }
}

function resolveCleanupEvidence(repo: string, branch: string, head: string, defaultRef: string, defaultHead: string, pullRequestEvidence: ReturnType<typeof createPullRequestLookup>): CleanupEvidenceResolution {
  const pr = pullRequestEvidence(branch, head)
  const protection = openPullRequestGuard(branch, pr)
  if (!protection.ok) return protection
  if (protection.skip_reason) {
    return {
      ok: true,
      evidence: null,
      skip_reason: protection.skip_reason,
      detail: protection.detail,
    }
  }
  if (pr.ok && pr.match) {
    if (!pr.mergeCommit || !pr.prHead || !pr.headRelation) return { ok: false, code: 'github-invalid-response', error: 'merged PR evidence is missing its merge commit or head relationship', repository: pr.repository }
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
        repository: pr.repository,
        head_ref: pr.match.headRefName,
      },
    }
  }

  const hasClosedPr = pr.ok && Boolean(pr.closedMatch)
  const patch = patchEquivalence(repo, head, defaultRef)
  if (!patch.ok && !hasClosedPr) {
    if (!pr.ok) {
      return {
        ok: false,
        code: 'patch-equivalence-query-failed',
        error: `${patch.error}; PR evidence unavailable: ${pr.error}`,
        repository: pr.repository,
        pr_error: { code: pr.code, detail: pr.error },
      }
    }
    return { ok: false, code: 'patch-equivalence-query-failed', error: patch.error }
  }
  if (patch.ok && patch.merged) {
    return {
      ok: true,
      evidence: {
        method: 'patch-equivalence',
        default_ref: defaultRef,
        default_head: defaultHead,
        commit_count: patch.commit_count,
        repository: pr.repository,
        head_ref: branch,
      },
    }
  }

  const aggregate = checkAggregatePatchEquivalence(repo, head, defaultRef, git)
  if (!aggregate.ok && !hasClosedPr) {
    const error = !aggregate.error ? 'aggregate patch-equivalence query failed' : aggregate.error
    if (!pr.ok) {
      return {
        ok: false,
        code: 'aggregate-patch-equivalence-query-failed',
        error: `${error}; PR evidence unavailable: ${pr.error}`,
        repository: pr.repository,
        pr_error: { code: pr.code, detail: pr.error },
      }
    }
    return { ok: false, code: 'aggregate-patch-equivalence-query-failed', error }
  }
  if (aggregate.ok && aggregate.merged) {
    return {
      ok: true,
      evidence: {
        method: 'aggregate-patch-equivalence',
        default_ref: defaultRef,
        default_head: defaultHead,
        merge_base: aggregate.merge_base,
        commit_count: aggregate.commit_count,
        changed_path_count: aggregate.changed_path_count,
        repository: pr.repository,
        head_ref: branch,
      },
    }
  }
  if (pr.ok && pr.closedMatch) {
    const headRepository = pr.closedMatch.headRepository?.nameWithOwner
    if (!headRepository || !pr.closedHead || !pr.headRelation) return { ok: false, code: 'github-invalid-response', error: 'closed PR evidence is missing its head repository or commit relationship', repository: pr.repository }
    return {
      ok: true,
      evidence: {
        method: 'closed-pr',
        pr: pr.closedMatch.url,
        number: pr.closedMatch.number,
        state: 'CLOSED',
        repository: pr.repository,
        head_repository: headRepository,
        head_ref: pr.closedMatch.headRefName,
        pr_head: pr.closedMatch.headRefOid,
        branch_head: pr.closedHead,
        head_relation: pr.headRelation,
        base_ref: pr.closedMatch.baseRefName,
        default_ref: defaultRef,
        default_head: defaultHead,
      },
    }
  }
  if (!pr.ok) return pr
  return { ok: true, evidence: null }
}

async function inspectRepository(repo: string, apply: boolean, explicitDefaultBranch: string | null, managedRoot: string | null) {
  const realRepo = await fs.realpath(repo)
  if (!apply) return inspectRepositoryUnderLock(realRepo, apply, explicitDefaultBranch, managedRoot)
  const lock = await acquireCleanupLock(realRepo)
  if (!lock.ok) return [{ repo: realRepo, action: 'error', reason: lock.code, detail: lock.error }]
  let results = []
  let inspectionError = null
  try {
    results = await inspectRepositoryUnderLock(realRepo, apply, explicitDefaultBranch, managedRoot)
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

async function inspectRepositoryUnderLock(realRepo: string, apply: boolean, explicitDefaultBranch: string | null, managedRoot: string | null) {
  const results: any[] = []
  const eligibleRoot = await resolveEligibleWorktreeRoot(realRepo, managedRoot)
  if (!eligibleRoot.ok) return [{ repo: realRepo, action: 'error', reason: 'eligible-worktree-root-query-failed', detail: eligibleRoot.error }]
  const realAllowedRoot = eligibleRoot.path
  const initialFences: any = apply ? await acquireInitialRegistrationFences(realRepo, realAllowedRoot) : { ok: true, fences: new Map(), allowedRoot: realAllowedRoot, release: async () => ({ ok: true }) }
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
  const originPrune = pruneOriginTrackingRefs(realRepo, apply)
  results.push(...originPrune.results)
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
  const pullRequestEvidence = createPullRequestLookup(realRepo, defaultInfo.name, defaultInfo.ref)
  const remoteDefault = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
  if (!remoteDefault.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: remoteDefault.code, detail: remoteDefault.error })
  if (remoteDefault.oid !== defaultHead) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'local-default-stale', detail: `${defaultInfo.ref}=${defaultHead}, remote=${remoteDefault.oid}` })
  if (dirtyRefresh?.skipped) {
    const finalSnapshot = readDefaultWorktreeSnapshot(realRepo, dirtyRefresh.default_worktree_path, dirtyRefresh.default_worktree)
    if (!finalSnapshot.ok) return prerequisiteFailure({ repo: realRepo, action: 'error', reason: 'default-branch-refresh-failed', detail: finalSnapshot.error })
    return prerequisiteFailure({ repo: realRepo, action: 'skip', severity: 'warn', reason: dirtyRefresh.code, detail: dirtyRefresh.error, dirty_status: dirtyRefresh.dirty_status })
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
    if (!realAllowedRoot || !isWithin(candidate, realAllowedRoot) || !isWithin(realCandidate, realAllowedRoot)) {
      results.push({ ...base, action: 'skip', reason: 'outside-managed-worktree-root' })
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
    const branchName = base.branch || ''
    const prGuard = openPullRequestGuard(branchName, pullRequestEvidence(branchName, item.head || ''))
    if (!prGuard.ok) {
      results.push({ ...base, action: 'error', reason: prGuard.code, detail: prGuard.error, repository: prGuard.repository })
      continue
    }
    if (prGuard.skip_reason) {
      results.push({ ...base, action: 'skip', reason: prGuard.skip_reason, detail: prGuard.detail })
      continue
    }
    const ancestry = git(realRepo, ['merge-base', '--is-ancestor', item.head || '', defaultInfo.ref]).ok
    let evidence: CleanupEvidence | null = ancestry ? { method: 'ancestry', default_ref: defaultInfo.ref, default_head: defaultHead, repository: prGuard.repository, head_ref: branchName } : null
    if (!evidence) {
      const resolved = resolveCleanupEvidence(realRepo, branchName, item.head || '', defaultInfo.ref, defaultHead, pullRequestEvidence)
      if (!resolved.ok) {
        results.push({ ...base, action: 'error', reason: resolved.code, detail: resolved.error, repository: resolved.repository, pr_error: resolved.pr_error })
        continue
      }
      if (resolved.skip_reason) {
        results.push({ ...base, action: 'skip', reason: resolved.skip_reason, detail: resolved.detail })
        continue
      }
      evidence = resolved.evidence
    }
    if (!evidence) {
      results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found' })
      continue
    }
    if (evidence.method === 'closed-pr') {
      const recovery = closedPrRecoveryRef(realRepo, item.branchRef || '', item.head || '')
      if (!recovery.ok || !recovery.ref) {
        results.push({
          ...base,
          action: 'skip',
          reason: recovery.ok ? 'closed-pr-local-commit-not-recoverable' : 'closed-pr-recovery-ref-check-unavailable',
          detail: recovery.ok ? 'no other ref preserves this unmerged commit' : recovery.error,
          evidence,
        })
        continue
      }
    }

    const processUsage = await processUsesWorktree(realCandidate)
    if (!processUsage.ok) {
      results.push({ ...base, action: 'skip', reason: 'worktree-process-check-unavailable', detail: processUsage.error, next_action: processNextAction('worktree-process-check-unavailable') })
      continue
    }
    if (processUsage.used) {
      results.push({ ...base, action: 'skip', reason: 'worktree-in-use', detail: `pid ${processUsage.pid} uses ${processUsage.location}`, next_action: processNextAction('worktree-in-use') })
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
      const patchError = cleanupEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead)
      if (patchError) {
        results.push({ ...base, action: 'error', reason: 'patch-equivalence-changed-before-remove', detail: patchError, evidence })
        continue
      }
    }
    if (evidence.method === 'aggregate-patch-equivalence') {
      const patchError = cleanupEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead)
      if (patchError) {
        results.push({ ...base, action: 'error', reason: 'aggregate-patch-equivalence-changed-before-remove', detail: patchError, evidence })
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
    if (evidence.method === 'closed-pr') {
      const closedPrError = cleanupEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead)
      if (closedPrError) {
        results.push({ ...base, action: 'error', reason: 'closed-pr-evidence-changed-before-remove', detail: closedPrError, evidence })
        continue
      }
    }
    if (!apply) {
      results.push({ ...base, action: 'would-delete', reason: cleanupReason(evidence), evidence, compose, ignored_files: ignoredBeforeQuarantine.stdout.length > 0 ? ignoredFilesDetail(ignoredBeforeQuarantine) : undefined })
      continue
    }
    const quarantineParent = path.dirname(realCandidate)
    if (quarantineParent !== realAllowedRoot && !isWithin(quarantineParent, realAllowedRoot)) {
      results.push({ ...base, action: 'error', reason: 'quarantine-parent-outside-managed-root', evidence })
      continue
    }
    const quarantine = path.join(quarantineParent, `.cleanup-${path.basename(candidate)}-${randomBytes(16).toString('hex')}`)
    const movedToQuarantine = git(realRepo, ['worktree', 'move', '-f', '-f', candidate, quarantine])
    if (!movedToQuarantine.ok) {
      registrationFenceFailure = true
      results.push({ ...base, action: 'error', reason: 'worktree-quarantine-move-failed', detail: movedToQuarantine.stderr.trim(), evidence })
      continue
    }
    const restoreQuarantine = async () => {
      const moveArgs = ['worktree', 'move', '-f', '-f', quarantine, candidate]
      const moved = git(realRepo, moveArgs)
      const moveError = moved.ok ? '' : `; move command failed: ${commandDiagnostic('git', ['-C', realRepo, ...moveArgs], moved)}`
      const failRestore = (error: string) => {
        initialFence.retain = true
        registrationFenceFailure = true
        return { ok: false, stderr: `${error}${moveError}` }
      }
      const listingArgs = ['worktree', 'list', '--porcelain', '-z']
      const listing = git(realRepo, listingArgs)
      if (!listing.ok) return failRestore(commandDiagnostic('git', ['-C', realRepo, ...listingArgs], listing))
      const registrations = parseWorktrees(listing.stdout)
      const restoredRegistration = registrations.find((worktree) => path.resolve(worktree.path) === path.resolve(candidate))
      const quarantineRegistration = registrations.find((worktree) => path.resolve(worktree.path) === path.resolve(quarantine))
      if (!restoredRegistration || quarantineRegistration) return failRestore(`restore registration read-back failed: original path ${candidate} ${restoredRegistration ? 'is' : 'is not'} registered; quarantine path ${quarantine} ${quarantineRegistration ? 'is' : 'is not'} registered`)
      if (restoredRegistration.locked !== INITIAL_REGISTRATION_LOCK_REASON) return failRestore(`restored worktree registration lock changed: ${restoredRegistration.locked || '<missing>'} != ${INITIAL_REGISTRATION_LOCK_REASON}`)
      let restoredRealPath
      try {
        restoredRealPath = await fs.realpath(candidate)
      } catch (error) {
        return failRestore(`restored worktree path could not be resolved: ${errorText(error)}`)
      }
      if (restoredRealPath !== realCandidate) return failRestore(`restored worktree path changed: ${restoredRealPath} != ${realCandidate}`)
      try {
        await fs.lstat(quarantine)
        return failRestore(`quarantine path remains after restore: ${quarantine}`)
      } catch (error) {
        if (processErrorCode(error) !== 'ENOENT') return failRestore(`quarantine path could not be verified after restore: ${errorText(error)}`)
      }
      const registration = await captureWorktreeRegistrationIdentity(candidate)
      const registrationError = registrationIdentityMismatch(registrationBeforeQuarantine, registration, 'restored worktree registration')
      if (registrationError) return failRestore(registrationError)
      const restoredHead = git(candidate, ['rev-parse', '--verify', 'HEAD'])
      const restoredBranch = git(candidate, ['symbolic-ref', '-q', 'HEAD'])
      const branchHead = git(realRepo, ['rev-parse', '--verify', item.branchRef || ''])
      if (!restoredHead.ok || restoredHead.stdout.trim() !== item.head) return failRestore(`restored worktree HEAD mismatch: ${restoredHead.ok ? restoredHead.stdout.trim() : restoredHead.stderr.trim()} != ${item.head}`)
      if (!restoredBranch.ok || restoredBranch.stdout.trim() !== item.branchRef) return failRestore(`restored worktree branch mismatch: ${restoredBranch.ok ? restoredBranch.stdout.trim() : restoredBranch.stderr.trim()} != ${item.branchRef}`)
      if (!branchHead.ok || branchHead.stdout.trim() !== item.head) return failRestore(`restored branch ref mismatch: ${branchHead.ok ? branchHead.stdout.trim() : branchHead.stderr.trim()} != ${item.head}`)
      return { ok: true, stderr: '' }
    }
    const quarantinedHead = git(quarantine, ['rev-parse', '--verify', 'HEAD'])
    const quarantinedBranch = git(quarantine, ['symbolic-ref', '-q', 'HEAD'])
    const registrationAfterQuarantine = await captureWorktreeRegistrationIdentity(quarantine)
    const registrationAfterQuarantineError = registrationIdentityMismatch(registrationBeforeQuarantine, registrationAfterQuarantine, 'quarantine worktree registration')
    if (!quarantinedHead.ok || quarantinedHead.stdout.trim() !== item.head || !quarantinedBranch.ok || quarantinedBranch.stdout.trim() !== item.branchRef || registrationAfterQuarantineError) {
      if (registrationAfterQuarantineError) {
        initialFence.retain = true
        registrationFenceFailure = true
      }
      const restored = registrationAfterQuarantineError ? { ok: false, stderr: `quarantine retained: ${registrationAfterQuarantineError}` } : await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: registrationAfterQuarantineError ? 'worktree-registration-changed-after-quarantine' : 'worktree-head-or-branch-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const processUsageAfterQuarantine = await processUsesWorktree(quarantine)
    if (!processUsageAfterQuarantine.ok || processUsageAfterQuarantine.used) {
      const processReason = processUsageAfterQuarantine.ok ? 'worktree-in-use' : 'worktree-process-check-unavailable'
      const processDetail = processUsageAfterQuarantine.ok
        ? `pid ${processUsageAfterQuarantine.pid} uses ${processUsageAfterQuarantine.location}`
        : processUsageAfterQuarantine.error
      const processFailure = { action: 'skip', reason: processReason, detail: processDetail, next_action: processNextAction(processReason) }
      const restored = await restoreQuarantine()
      if (!restored.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
        results.push({ ...base, action: 'error', reason: 'worktree-process-check-failed', detail: `${processFailure.detail}; quarantine restore failed: ${restored.stderr.trim()}`, next_action: processNextAction('worktree-process-check-failed'), evidence })
      } else {
        results.push({ ...base, ...processFailure, evidence })
      }
      continue
    }
    const statusBeforeRemove = git(quarantine, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
    if (!statusBeforeRemove.ok) {
      const restored = await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'status-recheck-failed-before-remove', detail: `${statusBeforeRemove.stderr.trim()}${restored.ok ? '' : `; restore failed: ${restored.stderr.trim()}`}`, evidence })
      continue
    }
    if (statusBeforeRemove.stdout.length > 0) {
      const restored = await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-became-dirty-before-remove', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const ignoredAfterQuarantine = ignoredFiles(quarantine)
    if (!ignoredAfterQuarantine.ok) {
      const restored = await restoreQuarantine()
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
      const restored = await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-state-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const remoteAfterQuarantine = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
    if (!remoteAfterQuarantine.ok || remoteAfterQuarantine.oid !== defaultHead) {
      const restored = await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'remote-default-changed-after-quarantine', detail: `${remoteAfterQuarantine.ok ? `${remoteAfterQuarantine.oid} != ${defaultHead}` : remoteAfterQuarantine.error}${restored.ok ? '' : `; restore failed: ${restored.stderr.trim()}`}`, evidence })
      continue
    }
    const mergeEvidenceStillValid = cleanupEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead, evidence.method !== 'ancestry') === null
    if (!mergeEvidenceStillValid) {
      const restored = await restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    if (ignoredFilesPresent) {
      const processUsageBeforeClean = await processUsesWorktree(quarantine)
      if (!processUsageBeforeClean.ok || processUsageBeforeClean.used) {
        const processReason = processUsageBeforeClean.ok ? 'worktree-in-use' : 'worktree-process-check-unavailable'
        const processDetail = processUsageBeforeClean.ok
          ? `pid ${processUsageBeforeClean.pid} uses ${processUsageBeforeClean.location}`
          : processUsageBeforeClean.error
        const processFailure = { action: 'skip', reason: processReason, detail: processDetail, next_action: processNextAction(processReason) }
        const restored = await restoreQuarantine()
        if (!restored.ok) {
          initialFence.retain = true
          registrationFenceFailure = true
          results.push({ ...base, action: 'error', reason: 'worktree-process-check-failed', detail: `${processFailure.detail}; quarantine restore failed: ${restored.stderr.trim()}`, next_action: processNextAction('worktree-process-check-failed'), evidence })
        } else {
          results.push({ ...base, ...processFailure, evidence })
        }
        continue
      }
      const cleanArgs = ['clean', '-ffdX']
      const cleaned = git(quarantine, cleanArgs)
      if (!cleaned.ok) {
        const restored = await restoreQuarantine()
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
        const restored = await restoreQuarantine()
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
      const mergeEvidenceAfterClean = cleanupEvidenceError(realRepo, item.branchRef || '', item.head || '', defaultInfo.ref, evidence, defaultHead) === null
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
        const restored = await restoreQuarantine()
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
    let contentLocks: Awaited<ReturnType<typeof acquireWorktreeLocks>> | null = null
    const releaseContentLocks = async (consumed = false) => {
      if (!contentLocks || !('release' in contentLocks) || typeof contentLocks.release !== 'function') return { ok: true }
      const heldLocks = contentLocks
      contentLocks = null
      return heldLocks.release(consumed ? new Set(heldLocks.paths) : undefined)
    }
    const beforeCommit = async () => {
      const acquiredLocks = await acquireWorktreeLocks([{ path: quarantine }], ['HEAD', 'index'])
      if (!acquiredLocks.ok) return { ok: false, reason: 'worktree-content-lock-failed', error: acquiredLocks.error }
      contentLocks = acquiredLocks
      const identity = await verifyWorktreeIdentityBeforeRemove(realRepo, quarantine, item.head || '', item.branchRef || '', realAllowedRoot, registrationBeforeQuarantine, INITIAL_REGISTRATION_LOCK_REASON)
      if (!identity.ok) {
        const released = await releaseContentLocks()
        if (!released.ok) {
          initialFence.retain = true
          registrationFenceFailure = true
        }
        return { ok: false, reason: 'worktree-identity-changed-before-remove', error: `${identity.error}${released.ok ? '' : `; content lock release failed: ${released.error}`}` }
      }
      const processUsageBeforeRemove = await processUsesWorktree(quarantine)
      if (!processUsageBeforeRemove.ok || processUsageBeforeRemove.used) {
        const processDetail = processUsageBeforeRemove.ok
          ? `pid ${processUsageBeforeRemove.pid} uses ${processUsageBeforeRemove.location}`
          : processUsageBeforeRemove.error
        const released = await releaseContentLocks()
        if (!released.ok) {
          initialFence.retain = true
          registrationFenceFailure = true
          return { ok: false, reason: 'worktree-content-lock-release-failed', error: `${processDetail}; content lock release failed: ${released.error}` }
        }
        return {
          ok: false,
          reason: processUsageBeforeRemove.ok ? 'worktree-in-use' : 'worktree-process-check-unavailable',
          error: processDetail,
        }
      }
      return { ok: true }
    }
    const beforeRefCommit = async () => {
      const removeArgs = ['worktree', 'remove', '-f', '-f', quarantine]
      const removed = git(realRepo, removeArgs)
      if (!removed.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
        return {
          ok: false,
          reason: 'worktree-remove-failed',
          error: `${commandDiagnostic('git', ['-C', realRepo, ...removeArgs], removed)}; quarantine registration lock retained for manual inspection`,
        }
      }
      const consumedContentLocks = await releaseContentLocks(true)
      if (!consumedContentLocks.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
        return { ok: false, reason: 'worktree-content-lock-release-failed', error: consumedContentLocks.error }
      }
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
        initialFence.retain = true
        registrationFenceFailure = true
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
    const afterAbort = async () => {
      const released = await releaseContentLocks()
      if (!released.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
      }
      return released
    }
    const branchSafety = await deleteLocalBranchSafely(realRepo, headLockRecords, item.branchRef, item.head, defaultInfo.ref, defaultHead, evidence, quarantine, beforeCommit, beforeRefCommit, afterAbort)
    if (!branchSafety.ok) {
      if (branchSafety.reason === 'worktree-in-use' || branchSafety.reason === 'worktree-process-check-unavailable') {
        const restored = await restoreQuarantine()
        if (!restored.ok) {
          initialFence.retain = true
          registrationFenceFailure = true
          results.push({ ...base, action: 'error', reason: 'worktree-process-check-failed', detail: `${branchSafety.detail}; quarantine restore failed: ${restored.stderr.trim()}`, next_action: processNextAction('worktree-process-check-failed'), evidence, branch_delete_method: branchSafety.branch_delete_method })
        } else {
          results.push({ ...base, action: 'skip', reason: branchSafety.reason, detail: branchSafety.detail, next_action: processNextAction(branchSafety.reason), evidence, branch_delete_method: branchSafety.branch_delete_method })
        }
        continue
      }
      if (branchSafety.reason === 'worktree-remove-failed') {
        initialFence.retain = true
        registrationFenceFailure = true
        results.push({ ...base, action: 'error', reason: branchSafety.reason, detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
        continue
      }
      if (branchSafety.reason.startsWith('worktree-')) registrationFenceFailure = true
      const restored = await restoreQuarantine()
      if (!restored.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
        results.push({ ...base, action: 'error', reason: branchSafety.reason, detail: `${branchSafety.detail}; quarantine restore failed: ${restored.stderr.trim()}`, evidence, branch_delete_method: branchSafety.branch_delete_method })
      } else {
        results.push({ ...base, action: 'error', reason: branchSafety.reason, detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
      }
      continue
    }
    if (branchSafety.branch_retained) {
      const restored = await restoreQuarantine()
      if (!restored.ok) {
        initialFence.retain = true
        registrationFenceFailure = true
        results.push({ ...base, action: 'error', reason: 'closed-pr-worktree-restore-failed', detail: `${branchSafety.detail}; quarantine restore failed: ${restored.stderr.trim()}`, evidence, branch_delete_method: branchSafety.branch_delete_method })
      } else {
        results.push({ ...base, action: 'skip', reason: branchSafety.branch_retained_reason || 'closed-pr-local-commit-not-recoverable', detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
      }
      continue
    }
    results.push({ ...base, action: 'deleted', reason: cleanupReason(evidence), evidence, branch_deleted: !branchSafety.branch_retained, branch_retained_reason: branchSafety.branch_retained_reason, detail: branchSafety.detail, branch_delete_method: branchSafety.branch_delete_method, ignored_files_removed: ignoredFilesRemoved })
  }
  if (registrationFenceFailure) return results
  const worktreeBranchRefs = new Set(worktrees.map((item) => item.branchRef).filter(Boolean))
  results.push(...await cleanupUnattachedMergedBranches(realRepo, apply, explicitDefaultBranch, defaultInfo, defaultHead, worktreeBranchRefs, pullRequestEvidence, initialBranchHeads))
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

// Local branches that are not checked out in any worktree follow the same cleanup policy as
// worktree candidates: the tip is an ancestor of the default branch, is an ancestor of a
// merged GitHub PR head with a reachable merge commit, matches an exactly related closed PR,
// has all commits patch-equivalent to the default branch, or has its complete aggregate net patch
// from the merge base in the default tree.
// Branches that were attached to a worktree at the start of this run are handled (or kept) by the
// worktree pass and are not reconsidered here.
async function cleanupUnattachedMergedBranches(realRepo: any, apply: any, explicitDefaultBranch: any, defaultInfo: any, defaultHead: any, worktreeBranchRefs: any, pullRequestEvidence: any, initialBranchHeads: any) {
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
    const prGuard = openPullRequestGuard(base.branch, pullRequestEvidence(base.branch, oid))
    if (!prGuard.ok) {
      results.push({ ...base, action: 'error', reason: prGuard.code, detail: prGuard.error, repository: prGuard.repository })
      continue
    }
    if (prGuard.skip_reason) {
      results.push({ ...base, action: 'skip', reason: prGuard.skip_reason, detail: prGuard.detail })
      continue
    }
    const ancestry = git(realRepo, ['merge-base', '--is-ancestor', oid, defaultInfo.ref]).ok
    let evidence: CleanupEvidence | null = ancestry ? { method: 'ancestry', default_ref: defaultInfo.ref, default_head: defaultHead, repository: prGuard.repository, head_ref: base.branch } : null
    if (!evidence) {
      const resolved = resolveCleanupEvidence(realRepo, base.branch, oid, defaultInfo.ref, defaultHead, pullRequestEvidence)
      if (!resolved.ok) {
        if (resolved.code === 'patch-equivalence-query-failed' || resolved.code === 'aggregate-patch-equivalence-query-failed') {
          results.push({ ...base, action: 'error', reason: resolved.code, detail: resolved.error, repository: resolved.repository, pr_error: resolved.pr_error })
        } else if (resolved.repository && resolved.code !== 'merge-evidence-unreachable') {
          results.push({ ...base, action: 'error', reason: resolved.code, detail: resolved.error, repository: resolved.repository })
        } else {
          // Without merge evidence the branch is kept. Unattached branches are often local work or
          // live in non-GitHub repositories, so an unavailable PR lookup is not reported as an error.
          results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found', merge_evidence_error: { code: resolved.code, detail: resolved.error, repository: resolved.repository } })
        }
        continue
      }
      if (resolved.skip_reason) {
        results.push({ ...base, action: 'skip', reason: resolved.skip_reason, detail: resolved.detail })
        continue
      }
      evidence = resolved.evidence
    }
    if (!evidence) {
      results.push({ ...base, action: 'skip', reason: 'merge-evidence-not-found' })
      continue
    }
    if (evidence.method === 'closed-pr') {
      const recovery = closedPrRecoveryRef(realRepo, ref, oid)
      if (!recovery.ok || !recovery.ref) {
        results.push({
          ...base,
          action: 'skip',
          reason: recovery.ok ? 'closed-pr-local-commit-not-recoverable' : 'closed-pr-recovery-ref-check-unavailable',
          detail: recovery.ok ? 'no other ref preserves this unmerged commit' : recovery.error,
          evidence,
        })
        continue
      }
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
    const evidenceError = cleanupEvidenceError(realRepo, ref, oid, defaultInfo.ref, evidence, defaultHead, !apply || evidence.method !== 'ancestry')
    if (evidenceError) {
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-before-delete', detail: evidenceError, evidence })
      continue
    }
    if (!apply) {
      results.push({ ...base, action: 'would-delete', reason: cleanupReason(evidence), evidence })
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
    if (branchSafety.branch_retained) {
      results.push({ ...base, action: 'skip', reason: branchSafety.branch_retained_reason || 'closed-pr-local-commit-not-recoverable', detail: branchSafety.detail, evidence, branch_delete_method: branchSafety.branch_delete_method })
      continue
    }
    results.push({ ...base, action: 'deleted', reason: cleanupReason(evidence), evidence, branch_delete_method: branchSafety.branch_delete_method })
  }
  return results
}

function resultTarget(item) {
  if (item.path) return item.path
  if (item.target === 'branch') return `${item.repo} (branch ${item.branch})`
  if (item.target === 'remote-tracking-ref') return `${item.repo} (${item.branch})`
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
  if (item.reason === 'stale-origin-tracking-ref') return 'origin上で削除済みのbranchに対応するlocal tracking refです'
  if (item.reason === 'dirty') return '対象worktreeに未commit変更があります'
  if (item.reason === 'locked') return `対象worktreeがロックされています${item.detail ? `: ${item.detail}` : ''}`
  return item.detail ? item.detail.replaceAll(/\s+/g, ' ').trim() : '詳細情報はありません'
}

function processNextAction(reason: string) {
  if (reason === 'worktree-process-check-unavailable') return '/procのアクセス制限が解消したか、対象processの状態を確認できる環境で再実行してください'
  if (reason === 'worktree-in-use') return '対象worktreeを使用中のprocessがあるため削除をskipしました。process終了後に再実行してください'
  if (reason === 'worktree-process-check-failed') return 'quarantine pathとworktree registrationを確認し、安全な復旧手順を判断してください'
  return null
}

function cronNextStep(item) {
  if (item.reason === 'worktree-process-check-unavailable') return `processの使用状況を確認できなかったため削除をskipしました。${processNextAction(item.reason)}`
  if (item.reason === 'worktree-in-use') return processNextAction(item.reason)
  if (item.reason === 'worktree-process-check-failed') return processNextAction(item.reason)
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
  const importantReasons = new Set(['empty-repository', 'prunable', 'stale-origin-tracking-ref', 'origin-tracking-ref-prune-query-failed', 'origin-tracking-ref-prune-failed', 'origin-tracking-ref-prune-readback-failed', 'default-branch-dirty', 'dirty', 'locked', 'worktree-in-use', 'worktree-process-check-unavailable', 'ignored-files-query-failed', 'ignored-files-query-failed-after-quarantine', 'ignored-files-clean-failed', 'ignored-files-clean-unverified', 'worktree-state-changed-after-ignored-clean', 'missing-origin', 'non-github-origin', 'no-merge-evidence', 'open-pull-request', 'closed-pr-branch-retained', 'closed-pr-local-commit-not-recoverable', 'closed-pr-recovery-ref-check-unavailable', 'closed-pr-evidence-changed-before-remove', 'merge-evidence-unreachable', 'github-query-failed', 'github-invalid-json', 'github-invalid-response', 'git-object-format-unreadable', 'git-object-format-unsupported', 'status-failed', 'candidate-realpath-failed', 'cleanup-lock-path-failed', 'cleanup-lock-unavailable', 'cleanup-lock-initialize-failed', 'cleanup-lock-release-failed', 'worktree-prune-failed', 'worktree-prune-unresolved', 'worktree-list-after-prune-failed', 'branch-head-changed-before-remove', 'patch-equivalence-query-failed', 'patch-equivalence-changed-before-remove', 'aggregate-patch-equivalence-query-failed', 'aggregate-patch-equivalence-changed-before-remove', 'worktree-identity-changed-before-remove', 'worktree-registration-fence-failed', 'worktree-registration-fence-release-failed', 'worktree-registration-identity-failed', 'worktree-registration-changed-after-quarantine', 'worktree-content-lock-failed', 'worktree-content-lock-release-failed', 'worktree-quarantine-move-failed', 'worktree-head-or-branch-changed-after-quarantine', 'status-recheck-failed-before-remove', 'worktree-became-dirty-before-remove', 'worktree-remove-failed', 'worktree-remove-unverified', 'branch-created-during-cleanup', 'branch-head-changed-during-cleanup', 'branch-still-used', 'compose-query-failed', 'compose-inspect-failed', 'compose-identity-mismatch', 'compose-down-failed', 'compose-containers-still-running'])
  const report = summary.results.filter((item) => item.action === 'deleted' || item.action === 'error' || item.severity === 'warn' || importantReasons.has(item.reason))
  if (report.length === 0) return '[SILENT]\n'
  const lines = ['## repository cleanup']
  for (const item of report) {
    const target = resultTarget(item)
    const evidence = item.evidence?.pr ? ` (${item.evidence.pr})` : ''
    const detail = item.detail && !isDefaultBranchWorktreeDirty(item) ? ` — ${item.detail.replaceAll(/\s+/g, ' ').trim()}` : ''
    const ignored = item.ignored_files_removed
      ? ` — ignored removed: ${item.ignored_files_removed.before_quarantine} before quarantine, ${item.ignored_files_removed.after_quarantine} after quarantine`
      : ''
    const action = item.severity === 'warn' ? 'warn' : item.action
    lines.push(`- ${action}: ${target} — ${item.reason}${evidence}${detail}${ignored}`)
    if (item.action === 'error' || item.severity === 'warn' || item.reason === 'worktree-process-check-unavailable' || item.reason === 'worktree-in-use') {
      lines.push(`  原因: ${cronCause(item)}`)
      if (isDefaultBranchWorktreeDirty(item)) lines.push(`  検出: ${item.dirty_status || '変更内容を読み取れませんでした'}`)
      const nextStep = cronNextStep(item)
      if (nextStep) lines.push(`  対応: ${nextStep}`)
    }
  }
  const worktreePruneSummary = summary.mode === 'dry-run' ? `stale worktree metadata prune予定: ${summary.would_prune}` : `stale worktree metadata prune済み: ${summary.pruned}`
  const originPruneSummary = summary.mode === 'dry-run' ? `origin tracking refs prune予定: ${summary.would_prune_origin_tracking_refs}` : `origin tracking refs prune済み: ${summary.origin_tracking_refs_pruned}`
  lines.push('', `worktree削除: ${summary.deleted} / ${worktreePruneSummary} / ${originPruneSummary} / 警告: ${summary.warnings} / エラー: ${summary.errors} / 要確認skip: ${report.filter((item: { action: string }) => item.action === 'skip').length}`)
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
  const managedRoot = values.root || config.configuredRoot || null
  for (const repo of repos) results.push(...await inspectRepository(repo, apply, explicitDefaultBranch, managedRoot))
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    root,
    repositories_checked: repos.length,
    candidates: results.length,
    deleted: results.filter((item) => item.action === 'deleted').length,
    pruned: results.filter((item) => item.action === 'pruned' && item.target !== 'remote-tracking-ref').length,
    would_delete: results.filter((item) => item.action === 'would-delete').length,
    would_prune: results.filter((item) => item.action === 'would-prune' && item.target !== 'remote-tracking-ref').length,
    origin_tracking_refs_pruned: results.filter((item) => item.action === 'pruned' && item.target === 'remote-tracking-ref').length,
    would_prune_origin_tracking_refs: results.filter((item) => item.action === 'would-prune' && item.target === 'remote-tracking-ref').length,
    pruned_remote_refs: results.filter((item) => item.action === 'pruned' && item.target === 'remote-tracking-ref').length,
    would_prune_remote_refs: results.filter((item) => item.action === 'would-prune' && item.target === 'remote-tracking-ref').length,
    skipped: results.filter((item) => item.action === 'skip').length,
    warnings: results.filter((item) => 'severity' in item && item.severity === 'warn').length,
    errors: results.filter((item) => item.action === 'error').length,
    results
  }
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else if (cron) process.stdout.write(renderCron(summary))
  else {
    process.stdout.write(`Repository cleanup (${summary.mode}): ${summary.repositories_checked} repos, ${summary.deleted} worktrees deleted, ${summary.origin_tracking_refs_pruned} origin tracking refs pruned, ${summary.would_delete} would delete, ${summary.would_prune_origin_tracking_refs} origin refs would prune, ${summary.errors} errors\n`)
    for (const item of results) process.stdout.write(`${item.action.toUpperCase()} ${resultTarget(item)}: ${item.reason}\n`)
  }
  process.exitCode = summary.errors > 0 ? 1 : 0
}

main().catch((error) => {
  process.stderr.write(`clean-merged-branches: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
