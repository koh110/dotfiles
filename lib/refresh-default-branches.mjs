#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(process.env.GIT_REPOSITORIES_ROOT || join(process.env.HOME, 'dev'))
const run = (cwd, command, args) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120_000,
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || '',
  }
}
const git = (cwd, ...args) => run(cwd, 'git', args)
const oneLine = (text) => text.split('\n').filter(Boolean).at(-1) || ''

function defaultBranchForRepo(repo) {
  const advertisedHead = git(repo, 'ls-remote', '--symref', 'origin', 'HEAD')
  if (advertisedHead.code === 0) {
    const line = advertisedHead.stdout.split('\n').find(
      (candidate) => candidate.startsWith('ref: refs/heads/') && candidate.endsWith('\tHEAD'),
    )
    if (line) {
      return { code: 0, branch: line.slice('ref: refs/heads/'.length, -'\tHEAD'.length) }
    }
  }

  let originHead = git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  if (originHead.code !== 0 || !originHead.stdout.startsWith('origin/')) {
    const setHead = git(repo, 'remote', 'set-head', 'origin', '--auto')
    if (setHead.code === 0) {
      originHead = git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    }
  }
  if (originHead.code === 0 && originHead.stdout.startsWith('origin/')) {
    return { code: 0, branch: originHead.stdout.slice('origin/'.length) }
  }
  return {
    code: 1,
    detail: 'origin/HEADを解決できません',
    command: `git -C ${repo} remote set-head origin --auto`,
  }
}

function worktreeForBranch(repo, branch) {
  const listing = git(repo, 'worktree', 'list', '--porcelain')
  if (listing.code !== 0) return null
  let path = null
  for (const line of listing.stdout.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    if (line === `branch refs/heads/${branch}`) return path
  }
  return null
}

function rebaseInProgress(repo) {
  return ['rebase-merge', 'rebase-apply'].some((state) => {
    const pathResult = git(repo, 'rev-parse', '--git-path', state)
    return pathResult.code === 0 && existsSync(resolve(repo, pathResult.stdout))
  })
}

function updateDefaultBranch(repo, defaultBranch) {
  const defaultWorktree = worktreeForBranch(repo, defaultBranch)
  if (defaultWorktree) {
    const before = git(defaultWorktree, 'rev-parse', 'HEAD')
    const hadRebase = rebaseInProgress(defaultWorktree)
    const pull = git(defaultWorktree, 'pull', '--rebase', 'origin', defaultBranch)
    if (pull.code !== 0) {
      let abort = { code: 0, stdout: '', stderr: '' }
      if (!hadRebase && rebaseInProgress(defaultWorktree)) {
        abort = git(defaultWorktree, 'rebase', '--abort')
      }
      return {
        code: 1,
        detail: `${oneLine(pull.stderr || pull.stdout) || 'default branchの更新に失敗しました'}${abort.code === 0 ? '' : `（rebase --abortにも失敗: ${oneLine(abort.stderr || abort.stdout)}）`}`,
        command: `git -C ${defaultWorktree} pull --rebase origin ${defaultBranch}`,
      }
    }
    const after = git(defaultWorktree, 'rev-parse', 'HEAD')
    return {
      code: 0,
      changed: before.code !== 0 || after.code !== 0 ? Boolean(pull.stdout) : before.stdout !== after.stdout,
      worktree: defaultWorktree,
    }
  }

  const localRef = `refs/heads/${defaultBranch}`
  const remoteRef = `refs/remotes/origin/${defaultBranch}`
  const local = git(repo, 'show-ref', '--verify', '--quiet', localRef)
  if (local.code === 0) {
    const ancestor = git(repo, 'merge-base', '--is-ancestor', localRef, remoteRef)
    if (ancestor.code !== 0) {
      return {
        code: 1,
        detail: `local ${defaultBranch} が origin/${defaultBranch} より先行または分岐しています`,
        command: `git -C ${repo} branch --ff-only ${defaultBranch} origin/${defaultBranch}`,
      }
    }
    const before = git(repo, 'rev-parse', localRef)
    const moved = git(repo, 'branch', '--force', defaultBranch, remoteRef)
    if (moved.code !== 0) {
      return { code: 1, detail: oneLine(moved.stderr || moved.stdout) || 'local default branchの更新に失敗しました' }
    }
    return { code: 0, changed: before.stdout !== git(repo, 'rev-parse', localRef).stdout }
  }

  const created = git(repo, 'branch', defaultBranch, remoteRef)
  if (created.code !== 0) {
    return { code: 1, detail: oneLine(created.stderr || created.stdout) || 'local default branchの作成に失敗しました' }
  }
  return { code: 0, changed: true }
}

let rootEntries
try {
  rootEntries = readdirSync(root, { withFileTypes: true })
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error(`repository rootを読み込めません: ${root} — ${detail}`)
  process.exit(1)
}

const repos = rootEntries
  .filter((entry) => entry.isDirectory() && entry.name !== 'tmp' && !entry.name.startsWith('.'))
  .map((entry) => join(root, entry.name))
  .filter((path) => {
    try { return statSync(join(path, '.git')).isDirectory() || statSync(join(path, '.git')).isFile() }
    catch { return false }
  })

const events = []
for (const repo of repos) {
  const name = repo.slice(root.length + 1)
  const top = git(repo, 'rev-parse', '--show-toplevel')
  if (top.code !== 0 || resolve(top.stdout) !== repo) continue

  const branch = git(repo, 'branch', '--show-current')
  if (branch.code !== 0 || !branch.stdout) {
    events.push({ name, state: 'failure', detail: 'root checkoutがdetached HEADです' })
    continue
  }

  const head = git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD')
  if (head.code !== 0) {
    const remoteHeads = git(repo, 'ls-remote', '--heads', 'origin')
    if (remoteHeads.code === 0 && !remoteHeads.stdout) {
      events.push({
        name,
        state: 'skipped',
        detail: 'ローカル・originともにcommitがない空のrepositoryのためスキップ',
      })
      continue
    }
  }

  const resolvedDefaultBranch = defaultBranchForRepo(repo)
  if (resolvedDefaultBranch.code !== 0) {
    events.push({ name, state: 'failure', detail: resolvedDefaultBranch.detail, command: resolvedDefaultBranch.command })
    continue
  }

  const defaultBranch = resolvedDefaultBranch.branch
  const fetch = git(repo, 'fetch', '--no-tags', 'origin', `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`)
  if (fetch.code !== 0) {
    events.push({
      name,
      state: 'failure',
      detail: oneLine(fetch.stderr || fetch.stdout) || 'default branchのfetchに失敗しました',
      command: `git -C ${repo} fetch --no-tags origin refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    })
    continue
  }

  const updatedDefault = updateDefaultBranch(repo, defaultBranch)
  if (updatedDefault.code !== 0) {
    events.push({ name, state: 'failure', detail: updatedDefault.detail, command: updatedDefault.command })
    continue
  }

  if (branch.stdout === defaultBranch) {
    if (updatedDefault.changed) {
      events.push({ name, state: 'updated', detail: `${defaultBranch}をorigin/${defaultBranch}へ更新` })
    }
    continue
  }

  const before = git(repo, 'rev-parse', 'HEAD')
  const hadRebase = rebaseInProgress(repo)
  const rebase = git(repo, 'rebase', defaultBranch)
  if (rebase.code !== 0) {
    let abort = { code: 0, stdout: '', stderr: '' }
    if (!hadRebase && rebaseInProgress(repo)) {
      abort = git(repo, 'rebase', '--abort')
    }
    const detail = oneLine(rebase.stderr || rebase.stdout) || 'rebaseに失敗しました'
    events.push({
      name,
      state: 'failure',
      detail: `${detail}${abort.code === 0 ? '' : `（rebase --abortにも失敗: ${oneLine(abort.stderr || abort.stdout)}）`}`,
      command: `git -C ${repo} rebase ${defaultBranch}`,
    })
    continue
  }
  const after = git(repo, 'rev-parse', 'HEAD')
  if (before.stdout !== after.stdout || updatedDefault.changed) {
    events.push({
      name,
      state: 'updated',
      detail: `${branch.stdout}を${defaultBranch}へrebase (${before.stdout.slice(0, 8)} → ${after.stdout.slice(0, 8)})`,
    })
  }
}

if (events.length === 0) process.exit(0)
console.log(`対象 repository: ${repos.length}件`)
for (const event of events) {
  const label = event.state === 'updated' ? '更新' : event.state === 'failure' ? '失敗' : 'スキップ'
  console.log(`- ${event.name}: ${label} — ${event.detail}`)
  if (event.command) console.log(`  - 実行コマンド: \`${event.command}\``)
}
if (events.some((event) => event.state === 'failure')) process.exitCode = 1
