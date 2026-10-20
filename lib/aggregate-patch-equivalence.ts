import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type GitResult = {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  error: string | null
}

type GitOptions = {
  input?: string
  env?: Record<string, string | undefined>
}

type GitRunner = (repo: string, args: string[], options?: GitOptions) => GitResult

type AggregatePatchResult = {
  ok: true
  merged: boolean
  reason?: string
  merge_base?: string
  commit_count?: number
  changed_path_count?: number
} | {
  ok: false
  error: string
}

function commandError(args: string[], result: GitResult) {
  const detail = result.stderr.trim() || result.error || `exit status ${result.status ?? 'unknown'}`
  return `git ${args.join(' ')}: ${detail}`
}

function failed(error: string): AggregatePatchResult {
  return { ok: false, error }
}

export function aggregatePatchEquivalence(repo: string, expectedHead: string, defaultRef: string, git: GitRunner): AggregatePatchResult {
  const baseArgs = ['merge-base', '--all', defaultRef, expectedHead]
  const baseResult = git(repo, baseArgs)
  if (!baseResult.ok) {
    if (baseResult.status === 1 && !baseResult.stderr && !baseResult.error) {
      return { ok: true, merged: false, reason: 'no-common-base' }
    }
    return failed(commandError(baseArgs, baseResult))
  }
  const mergeBases = baseResult.stdout.trim().split(/\r?\n/)
  if (mergeBases.length !== 1) {
    return failed(`git ${baseArgs.join(' ')} returned multiple best merge bases; aggregate patch is ambiguous`)
  }
  const mergeBase = mergeBases[0] ?? ''
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase)) {
    return failed(`git ${baseArgs.join(' ')} returned an invalid commit OID`)
  }

  const patchArgs = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', mergeBase, expectedHead]
  const patch = git(repo, patchArgs)
  if (!patch.ok) return failed(commandError(patchArgs, patch))

  const pathsArgs = ['diff', '--name-only', '-z', '--no-renames', mergeBase, expectedHead]
  const paths = git(repo, pathsArgs)
  if (!paths.ok) return failed(commandError(pathsArgs, paths))
  const changedPathCount = paths.stdout.split('\0').filter(Boolean).length
  if (changedPathCount === 0 || patch.stdout.length === 0) {
    return { ok: true, merged: false, reason: 'empty-net-diff', merge_base: mergeBase, commit_count: 0, changed_path_count: changedPathCount }
  }

  const countArgs = ['rev-list', '--no-merges', '--count', `${defaultRef}..${expectedHead}`]
  const countResult = git(repo, countArgs)
  if (!countResult.ok) return failed(commandError(countArgs, countResult))
  const countText = countResult.stdout.trim()
  if (!/^\d+$/.test(countText)) return failed(`git ${countArgs.join(' ')} returned an invalid commit count`)
  const commitCount = Number(countText)
  if (!Number.isSafeInteger(commitCount)) return failed(`git ${countArgs.join(' ')} returned an unsafe commit count`)

  let tempDirectory = ''
  let tempIdentity: { dev: number; ino: number } | null = null
  let outcome: AggregatePatchResult = failed('aggregate patch check did not run')
  try {
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'clean-merged-branches-index-'))
    const tempStat = lstatSync(tempDirectory)
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) {
      outcome = failed('temporary index directory is not a real directory')
    } else {
      tempIdentity = { dev: tempStat.dev, ino: tempStat.ino }
      const env = { GIT_INDEX_FILE: path.join(tempDirectory, 'index'), LC_ALL: 'C' }
      const readTreeArgs = ['read-tree', defaultRef]
      const readTree = git(repo, readTreeArgs, { env })
      if (!readTree.ok) {
        outcome = failed(commandError(readTreeArgs, readTree))
      } else {
        const applyArgs = ['apply', '--cached', '--reverse', '--check', '--binary', '--verbose', '--whitespace=nowarn']
        const reverseCheck = git(repo, applyArgs, { input: patch.stdout, env })
        const reverseOutput = `${reverseCheck.stdout}\n${reverseCheck.stderr}`
        const relocatedHunk = reverseOutput.split(/\r?\n/).some((line) => {
          return /^\s*Hunk #\d+ succeeded\b.*\b(?:offset|fuzz)\b/i.test(line)
        })
        if (reverseCheck.ok && relocatedHunk) {
          outcome = failed('aggregate reverse patch required offset or fuzz; patch placement is ambiguous')
        } else if (reverseCheck.ok) {
          outcome = { ok: true, merged: true, merge_base: mergeBase, commit_count: commitCount, changed_path_count: changedPathCount }
        } else if (reverseCheck.status === 1 && !reverseCheck.error) {
          outcome = { ok: true, merged: false, reason: 'aggregate-patch-not-present', merge_base: mergeBase, commit_count: commitCount, changed_path_count: changedPathCount }
        } else {
          outcome = failed(commandError(applyArgs, reverseCheck))
        }
      }
    }
  } catch (error) {
    outcome = failed(`aggregate patch temporary-index operation failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (tempDirectory) {
    try {
      const current = lstatSync(tempDirectory)
      if (!tempIdentity || !current.isDirectory() || current.isSymbolicLink() || current.dev !== tempIdentity.dev || current.ino !== tempIdentity.ino) {
        return failed('temporary index directory identity changed; preserving it for inspection')
      }
      rmSync(tempDirectory, { recursive: true })
    } catch (error) {
      return failed(`temporary index directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return outcome
}
