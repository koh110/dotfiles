#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { loadCleanMergedWorktreesConfig } from './clean-merged-worktrees-config.ts'

const config = loadCleanMergedWorktreesConfig()

function usage() {
  process.stdout.write(`Usage: clean-merged-worktrees [--root DIR] [--repo DIR ...] [--default-branch NAME] [--apply] [--json|--cron]\n\nDefault is dry-run. GIT_REPOSITORIES_ROOT defaults to $HOME/dev. Stale worktree registrations are pruned first; only clean, unlocked worktrees under <repo>/.worktree are eligible for removal. Ignored files are preserved and reported as a skip.\nThe default branch must come from origin/HEAD unless explicitly supplied. A worktree is removed when its HEAD is an ancestor of that branch, or exactly matches a merged GitHub PR commit. Remote branches are never deleted.\n`)
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

function git(repo, args) {
  return run('git', ['-C', repo, ...args])
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
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
  const lockPath = path.join(commonDirPath, 'clean-merged-worktrees.lock')
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

function parseWorktrees(output) {
  const records = []
  let current = {}
  for (const token of output.split('\0')) {
    if (!token) {
      if (current.path) records.push(current)
      current = {}
      continue
    }
    const space = token.indexOf(' ')
    const key = space === -1 ? token : token.slice(0, space)
    const value = space === -1 ? true : token.slice(space + 1)
    if (key === 'worktree') current.path = value
    else if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branchRef = value
    else if (key === 'locked') current.locked = value === true ? '' : value
    else if (key === 'prunable') current.prunable = value === true ? '' : value
  }
  if (current.path) records.push(current)
  return records
}

function pruneWorktreeRegistrations(repo, apply) {
  const args = apply ? ['worktree', 'prune', '-v'] : ['worktree', 'prune', '--dry-run', '-v']
  const result = git(repo, args)
  return result.ok
    ? { ok: true, args, output: result.stdout.trim() }
    : { ok: false, args, error: commandDiagnostic('git', ['-C', repo, ...args], result) }
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

function validatePullList(pulls) {
  if (!Array.isArray(pulls)) return 'gh pr list response must be an array'
  for (const pull of pulls) {
    if (!isRecord(pull) || !Number.isInteger(pull.number) || pull.number < 1 || typeof pull.url !== 'string' || pull.url.length === 0 || (pull.mergedAt !== null && typeof pull.mergedAt !== 'string')) {
      return 'gh pr list response contains an invalid pull object'
    }
  }
  return null
}

function validatePullDetail(detail, oidLength) {
  if (!isRecord(detail) || !Array.isArray(detail.commits)) return 'gh pr view response must contain a commits array'
  const oidPattern = new RegExp(`^[0-9a-f]{${oidLength}}$`)
  if (detail.commits.some((commit) => !isRecord(commit) || typeof commit.oid !== 'string' || !oidPattern.test(commit.oid))) return 'gh pr view commits contain an invalid object ID'
  if (detail.mergeCommit !== null && (!isRecord(detail.mergeCommit) || typeof detail.mergeCommit.oid !== 'string' || !oidPattern.test(detail.mergeCommit.oid))) return 'gh pr view mergeCommit is invalid'
  return null
}

function mergedPrEvidence(repo, branch, defaultName, defaultRef, head) {
  const remote = git(repo, ['config', '--get', 'remote.origin.url'])
  if (!remote.ok) return { ok: false, code: 'missing-origin', error: remote.stderr.trim() }
  const target = ownerRepo(remote.stdout)
  if (!target) return { ok: false, code: 'non-github-origin', error: remote.stdout.trim() }
  const objectFormat = gitObjectIdLength(repo)
  if (!objectFormat.ok) return { ok: false, code: objectFormat.code, error: objectFormat.error, repository: target }
  const response = run('gh', ['pr', 'list', '--repo', target, '--state', 'merged', '--head', branch, '--base', defaultName, '--limit', '100', '--json', 'number,url,mergedAt'])
  if (!response.ok) return { ok: false, code: 'github-query-failed', error: (response.stderr || response.error || '').trim(), repository: target }
  let pulls
  try {
    pulls = JSON.parse(response.stdout)
  } catch (error) {
    return { ok: false, code: 'github-invalid-json', error: errorText(error), repository: target }
  }
  const pullListError = validatePullList(pulls)
  if (pullListError) return { ok: false, code: 'github-invalid-response', error: pullListError, repository: target }
  let unreachable = null
  for (const pull of pulls) {
    const details = run('gh', ['pr', 'view', '--repo', target, String(pull.number), '--json', 'commits,mergeCommit'])
    if (!details.ok) return { ok: false, code: 'github-query-failed', error: (details.stderr || details.error || '').trim(), repository: target }
    let detail
    try {
      detail = JSON.parse(details.stdout)
    } catch (error) {
      return { ok: false, code: 'github-invalid-json', error: errorText(error), repository: target }
    }
    const pullDetailError = validatePullDetail(detail, objectFormat.length)
    if (pullDetailError) return { ok: false, code: 'github-invalid-response', error: pullDetailError, repository: target }
    const mergedHead = (detail.commits || []).at(-1)?.oid
    if (mergedHead !== head) continue
    const mergeCommit = detail.mergeCommit?.oid
    const mergeCommitExists = mergeCommit && git(repo, ['cat-file', '-e', `${mergeCommit}^{commit}`]).ok
    const mergeCommitReachable = mergeCommitExists && git(repo, ['merge-base', '--is-ancestor', mergeCommit, defaultRef]).ok
    if (mergeCommitReachable) return { ok: true, match: pull, repository: target, mergedHead, mergeCommit }
    unreachable = { pull, mergeCommit: mergeCommit || null }
  }
  if (unreachable) return { ok: false, code: 'merge-evidence-unreachable', error: `PR #${unreachable.pull.number} merge commit is not reachable from ${defaultRef}`, repository: target, mergeCommit: unreachable.mergeCommit }
  return { ok: true, match: null, repository: target }
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
  const results = []
  const listing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
  if (!listing.ok) return [{ repo: realRepo, action: 'error', reason: 'worktree-list-failed', detail: listing.stderr.trim() }]
  let worktrees = parseWorktrees(listing.stdout)
  let rootRecord = worktrees.find((item) => path.resolve(item.path) === realRepo)
  if (!rootRecord) return [{ repo: realRepo, action: 'error', reason: 'root-worktree-not-found' }]
  let candidateWorktrees = worktrees.filter((item) => path.resolve(item.path) !== realRepo)
  const initialPrunable = candidateWorktrees.filter((item) => item.prunable !== undefined)
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
  if (candidateWorktrees.length === 0) return results
  const defaultInfo = defaultBranch(realRepo, explicitDefaultBranch)
  if (!defaultInfo) return [...results, { repo: realRepo, action: 'error', reason: 'default-branch-not-found' }]
  const defaultHeadResult = git(realRepo, ['rev-parse', '--verify', defaultInfo.ref])
  if (!defaultHeadResult.ok) return [...results, { repo: realRepo, action: 'error', reason: 'default-ref-unreadable' }]
  const defaultHead = defaultHeadResult.stdout.trim()
  const remoteDefault = remoteDefaultState(realRepo, defaultInfo.name, Boolean(explicitDefaultBranch))
  if (!remoteDefault.ok) return [...results, { repo: realRepo, action: 'error', reason: remoteDefault.code, detail: remoteDefault.error }]
  if (remoteDefault.oid !== defaultHead) return [...results, { repo: realRepo, action: 'error', reason: 'local-default-stale', detail: `${defaultInfo.ref}=${defaultHead}, remote=${remoteDefault.oid}` }]
  const allowedRoot = path.join(realRepo, '.worktree')
  let realAllowedRoot = null
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
      results.push({ ...base, action: 'error', reason: 'candidate-realpath-failed', detail: error.message })
      continue
    }
    if (!realAllowedRoot || !isWithin(realCandidate, realAllowedRoot)) {
      results.push({ ...base, action: 'skip', reason: 'outside-repo-worktree-root' })
      continue
    }
    if (item.locked !== undefined) {
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
    if (ignoredBeforeQuarantine.stdout.length > 0) {
      results.push({ ...base, action: 'skip', reason: 'ignored-files-present', detail: ignoredFilesDetail(ignoredBeforeQuarantine) })
      continue
    }

    const ancestry = git(realRepo, ['merge-base', '--is-ancestor', item.head, defaultInfo.ref]).ok
    let evidence = ancestry ? { method: 'ancestry', default_ref: defaultInfo.ref, default_head: defaultHead } : null
    if (!evidence) {
      const pr = mergedPrEvidence(realRepo, base.branch, defaultInfo.name, defaultInfo.ref, item.head)
      if (!pr.ok) {
        results.push({ ...base, action: 'error', reason: pr.code, detail: pr.error, repository: pr.repository })
        continue
      }
      if (pr.match) evidence = { method: 'github-merge-commit', pr: pr.match.url, number: pr.match.number, merged_at: pr.match.mergedAt, merge_commit: pr.mergeCommit, default_ref: defaultInfo.ref, default_head: defaultHead }
    }
    if (!evidence) {
      results.push({ ...base, action: 'skip', reason: 'not-merged' })
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
    const compose = composeTeardownForWorktree(candidate, apply)
    if (!compose.ok) {
      results.push({ ...base, action: 'error', reason: compose.code, detail: compose.error, evidence, compose })
      continue
    }
    if (!apply) {
      results.push({ ...base, action: 'would-delete', reason: 'merged', evidence, compose })
      continue
    }
    const quarantine = path.join(realAllowedRoot, `.cleanup-${path.basename(candidate)}-${randomBytes(16).toString('hex')}`)
    const movedToQuarantine = git(realRepo, ['worktree', 'move', candidate, quarantine])
    if (!movedToQuarantine.ok) {
      results.push({ ...base, action: 'error', reason: 'worktree-quarantine-move-failed', detail: movedToQuarantine.stderr.trim(), evidence })
      continue
    }
    const restoreQuarantine = () => git(realRepo, ['worktree', 'move', quarantine, candidate])
    const quarantinedHead = git(quarantine, ['rev-parse', '--verify', 'HEAD'])
    const quarantinedBranch = git(quarantine, ['symbolic-ref', '-q', 'HEAD'])
    if (!quarantinedHead.ok || quarantinedHead.stdout.trim() !== item.head || !quarantinedBranch.ok || quarantinedBranch.stdout.trim() !== item.branchRef) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-head-or-branch-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
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
    if (ignoredAfterQuarantine.stdout.length > 0) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-became-ignored-before-remove', detail: `${ignoredFilesDetail(ignoredAfterQuarantine)}; ${appendRestoreDiagnostic('ignored files appeared after quarantine', 'git', ['-C', realRepo, 'worktree', 'move', quarantine, candidate], restored)}`, evidence })
      continue
    }
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
    if (!statusAfterQuarantine.ok || statusAfterQuarantine.stdout.length > 0 || !headAfterQuarantine.ok || headAfterQuarantine.stdout.trim() !== item.head || !branchAfterQuarantine.ok || branchAfterQuarantine.stdout.trim() !== item.branchRef || !refAfterQuarantine.ok || refAfterQuarantine.stdout.trim() !== item.head || !defaultAfterQuarantine.ok || defaultAfterQuarantine.stdout.trim() !== defaultHead || !registeredAfterQuarantine || registeredAfterQuarantine.locked !== undefined || realQuarantineAfterQuarantine !== path.resolve(quarantine) || !isWithin(realQuarantineAfterQuarantine, realAllowedRoot)) {
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
    const mergeEvidenceStillValid = evidence.method === 'ancestry'
      ? git(realRepo, ['merge-base', '--is-ancestor', item.head, defaultInfo.ref]).ok
      : git(realRepo, ['merge-base', '--is-ancestor', evidence.merge_commit, defaultInfo.ref]).ok
    if (!mergeEvidenceStillValid) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'merge-evidence-changed-after-quarantine', detail: restored.ok ? undefined : `restore failed: ${restored.stderr.trim()}`, evidence })
      continue
    }
    const removed = git(realRepo, ['worktree', 'remove', quarantine])
    if (!removed.ok) {
      const restored = restoreQuarantine()
      results.push({ ...base, action: 'error', reason: 'worktree-remove-failed', detail: `${removed.stderr.trim()}${restored.ok ? '' : `; restore failed: ${restored.stderr.trim()}`}`, evidence })
      continue
    }
    const verifyListing = git(realRepo, ['worktree', 'list', '--porcelain', '-z'])
    const stillPresent = verifyListing.ok && parseWorktrees(verifyListing.stdout).some((worktree) => path.resolve(worktree.path) === path.resolve(quarantine))
    if (!verifyListing.ok || stillPresent) {
      results.push({ ...base, action: 'error', reason: 'worktree-remove-unverified', evidence })
      continue
    }
    const branchStillUsed = parseWorktrees(verifyListing.stdout).some((worktree) => worktree.branchRef === item.branchRef)
    if (branchStillUsed) {
      results.push({ ...base, action: 'error', reason: 'branch-still-used', evidence })
      continue
    }
    if (evidence.method !== 'ancestry') {
      results.push({ ...base, action: 'deleted', reason: 'merged-worktree-removed-branch-retained', evidence, branch_delete_method: 'retained-non-ancestry-branch' })
      continue
    }
    const refBeforeBranchDelete = git(realRepo, ['rev-parse', '--verify', item.branchRef])
    if (!refBeforeBranchDelete.ok || refBeforeBranchDelete.stdout.trim() !== item.head) {
      results.push({ ...base, action: 'deleted', reason: 'merged-worktree-removed-branch-changed-and-retained', evidence, branch_delete_method: 'retained-after-oid-recheck' })
      continue
    }
    // `git branch -d` performs its own in-use and merged-at-execution checks. If the ref
    // changes after our OID check, an unmerged replacement is refused; a merged replacement
    // still satisfies this cleanup policy. Do not replace this with force/update-ref deletion.
    const deleted = git(realRepo, ['branch', '-d', base.branch])
    if (!deleted.ok) {
      results.push({ ...base, action: 'deleted', reason: 'merged-worktree-removed-branch-in-use-or-unmerged-and-retained', detail: deleted.stderr.trim(), evidence, branch_delete_method: 'git-branch-d-refused' })
      continue
    }
    results.push({ ...base, action: 'deleted', reason: 'merged', evidence, branch_delete_method: 'git-branch-d-with-worktree-and-merge-safety' })
  }
  return results
}

function renderCron(summary) {
  const importantReasons = new Set(['empty-repository', 'prunable', 'dirty', 'locked', 'ignored-files-present', 'ignored-files-query-failed', 'ignored-files-query-failed-after-quarantine', 'worktree-became-ignored-before-remove', 'missing-origin', 'non-github-origin', 'no-merge-evidence', 'merge-evidence-unreachable', 'github-query-failed', 'github-invalid-json', 'github-invalid-response', 'git-object-format-unreadable', 'git-object-format-unsupported', 'status-failed', 'candidate-realpath-failed', 'cleanup-lock-path-failed', 'cleanup-lock-unavailable', 'cleanup-lock-initialize-failed', 'cleanup-lock-release-failed', 'worktree-prune-failed', 'worktree-prune-unresolved', 'worktree-list-after-prune-failed', 'branch-head-changed-before-remove', 'worktree-quarantine-move-failed', 'worktree-head-or-branch-changed-after-quarantine', 'status-recheck-failed-before-remove', 'worktree-became-dirty-before-remove', 'worktree-remove-failed', 'worktree-remove-unverified', 'branch-still-used', 'compose-query-failed', 'compose-inspect-failed', 'compose-identity-mismatch', 'compose-down-failed', 'compose-containers-still-running'])
  const report = summary.results.filter((item) => item.action === 'deleted' || item.action === 'error' || importantReasons.has(item.reason))
  if (report.length === 0) return '[SILENT]\n'
  const lines = ['## merged worktree cleanup']
  for (const item of report) {
    const target = item.path || item.repo
    const evidence = item.evidence?.pr ? ` (${item.evidence.pr})` : ''
    const detail = item.detail ? ` — ${item.detail.replaceAll(/\s+/g, ' ').trim()}` : ''
    lines.push(`- ${item.action}: ${target} — ${item.reason}${evidence}${detail}`)
  }
  const pruneSummary = summary.mode === 'dry-run' ? `prune予定: ${summary.would_prune}` : `prune済み: ${summary.pruned}`
  lines.push('', `削除: ${summary.deleted} / ${pruneSummary} / エラー: ${summary.errors} / 要確認skip: ${report.filter((item) => item.action === 'skip').length}`)
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
  const results = []
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
    errors: results.filter((item) => item.action === 'error').length,
    results
  }
  if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  else if (cron) process.stdout.write(renderCron(summary))
  else {
    process.stdout.write(`Merged worktree cleanup (${summary.mode}): ${summary.repositories_checked} repos, ${summary.deleted} deleted, ${summary.would_delete} would delete, ${summary.errors} errors\n`)
    for (const item of results) process.stdout.write(`${item.action.toUpperCase()} ${item.path || item.repo}: ${item.reason}\n`)
  }
  process.exitCode = summary.errors > 0 ? 1 : 0
}

main().catch((error) => {
  process.stderr.write(`clean-merged-worktrees: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
})
