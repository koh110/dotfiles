import { spawn } from 'node:child_process'
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

type AfterDiffSpawn = (child: ReturnType<typeof spawn>, indexPath: string) => void

type AggregatePatchResult =
  | {
      ok: true
      merged: true
      merge_base: string
      commit_count: number
      changed_path_count: number
    }
  | {
      ok: true
      merged: false
      reason: string
      merge_base?: string
      commit_count?: number
      changed_path_count?: number
    }
  | {
      ok: false
      error: string
      terminationUnconfirmed?: true
    }

type ProcessState = {
  closed: boolean
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  outputBytes: number
  error: string | null
}

const DIAGNOSTIC_OUTPUT_LIMIT = 16 * 1024 * 1024
const PATCH_PIPELINE_TIMEOUT = 30_000
const TERMINATION_GRACE = 1_000
const TERMINATION_CONFIRMATION_TIMEOUT = 5_000

function commandError(args: string[], result: GitResult) {
  const detail = result.stderr.trim() || result.error || `exit status ${result.status ?? 'unknown'}`
  return `git ${args.join(' ')}: ${detail}`
}

function failed(error: string) {
  return { ok: false, error } satisfies AggregatePatchResult
}

export function classifyAggregatePatchFailure(
  result: AggregatePatchResult,
  closedPrAvailable: boolean,
) {
  if (result.ok) return { action: 'continue' } as const
  if (result.terminationUnconfirmed === true) {
    return {
      action: 'error',
      code: 'aggregate-patch-process-termination-unconfirmed',
      error: result.error,
    } as const
  }
  if (closedPrAvailable) return { action: 'closed-pr-fallback' } as const
  return {
    action: 'error',
    code: 'aggregate-patch-equivalence-query-failed',
    error: result.error,
  } as const
}

function tryLaunchProcess<T>(launch: () => T) {
  try {
    return { child: launch() }
  } catch (error) {
    return { error }
  }
}

async function streamAggregatePatch(
  repo: string,
  patchArgs: string[],
  applyArgs: string[],
  environment: Record<string, string | undefined> | undefined,
  applyEnvironment: Record<string, string | undefined>,
  afterDiffSpawn?: AfterDiffSpawn,
) {
  const indexPath = applyEnvironment.GIT_INDEX_FILE
  if (!indexPath) throw new Error('temporary index path is missing')
  const diff = spawn('git', ['-C', repo, ...patchArgs], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const diffEvents = diff
  const reverseLaunch = tryLaunchProcess(() => {
    afterDiffSpawn?.(diff, indexPath)
    return spawn('git', ['-C', repo, ...applyArgs], {
      env: applyEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  })
  if ('error' in reverseLaunch) {
    const launchError = `git apply launch failed synchronously: ${reverseLaunch.error instanceof Error ? reverseLaunch.error.message : String(reverseLaunch.error)}`
    let closed = false
    let childError: string | null = null
    let resolveClosed: (confirmed: boolean) => void
    const childClosed = new Promise<boolean>((resolve) => {
      resolveClosed = resolve
    })
    diffEvents.once('error', (error: Error) => {
      childError = error.message
    })
    diffEvents.once('close', () => {
      closed = true
      resolveClosed(true)
    })
    const escalationTimer = setTimeout(() => {
      if (!closed) {
        try {
          diff.kill('SIGKILL')
        } catch {
          // The confirmation timeout below keeps the result fail-closed.
        }
      }
    }, TERMINATION_GRACE)
    const confirmationTimer = setTimeout(() => {
      resolveClosed(false)
    }, TERMINATION_CONFIRMATION_TIMEOUT)
    try {
      diff.kill('SIGTERM')
    } catch {
      // Escalate and preserve the temporary index if the child does not close.
    }
    const terminationConfirmed = await childClosed
    clearTimeout(escalationTimer)
    clearTimeout(confirmationTimer)
    const failure = `${launchError}${childError ? `; git diff child error: ${childError}` : ''}${terminationConfirmed ? '' : '; git diff child termination could not be confirmed'}`
    return {
      diff: { ok: false, status: null, stdout: '', stderr: '', error: failure },
      reverse: { ok: false, status: null, stdout: '', stderr: '', error: launchError },
      patchBytes: 0,
      inputClosedEarly: false,
      terminationConfirmed,
      failure,
    }
  }
  const reverse = reverseLaunch.child
  const reverseEvents = reverse
  const diffState: ProcessState = {
    closed: false,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    error: null,
  }
  const reverseState: ProcessState = {
    closed: false,
    status: null,
    signal: null,
    stdout: '',
    stderr: '',
    outputBytes: 0,
    error: null,
  }
  let terminationReason: string | null = null
  let patchBytes = 0
  let applyInputClosed = false
  let inputClosedEarly = false
  let diffOutputEnded = false
  let resolveUnconfirmedTermination: () => void
  const unconfirmedTermination = new Promise<void>((resolve) => {
    resolveUnconfirmedTermination = resolve
  })
  let escalationTimer: ReturnType<typeof setTimeout> | null = null
  let unconfirmedTimer: ReturnType<typeof setTimeout> | null = null
  function terminate(reason: string) {
    if (terminationReason) return
    terminationReason = reason
    diff.kill('SIGTERM')
    reverse.kill('SIGTERM')
    escalationTimer = setTimeout(() => {
      diff.kill('SIGKILL')
      reverse.kill('SIGKILL')
    }, TERMINATION_GRACE)
    unconfirmedTimer = setTimeout(resolveUnconfirmedTermination, TERMINATION_CONFIRMATION_TIMEOUT)
  }
  let resolveDiffClosed: () => void
  let resolveReverseClosed: () => void
  const diffClosed = new Promise<void>((resolve) => {
    resolveDiffClosed = resolve
  })
  const reverseClosed = new Promise<void>((resolve) => {
    resolveReverseClosed = resolve
  })
  diffEvents.on('error', (error: Error) => {
    diffState.error = error.message
    terminate(`git diff launch failed: ${error.message}`)
  })
  reverseEvents.once('error', (error: Error) => {
    reverseState.error = error.message
    terminate(`git apply launch failed: ${error.message}`)
  })
  diffEvents.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
    diffState.closed = true
    diffState.status = status
    diffState.signal = signal
    if (!diffOutputEnded && !terminationReason) {
      diffState.error = 'git diff stdout closed before the complete patch was streamed'
      terminate(diffState.error)
    }
    resolveDiffClosed()
  })
  reverseEvents.once('close', (status: number | null, signal: NodeJS.Signals | null) => {
    reverseState.closed = true
    reverseState.status = status
    reverseState.signal = signal
    resolveReverseClosed()
  })

  const diffStdout = diff.stdout
  const diffStderr = diff.stderr
  const reverseStdin = reverse.stdin
  const reverseStdout = reverse.stdout
  const reverseStderr = reverse.stderr
  if (!diffStdout || !diffStderr || !reverseStdin || !reverseStdout || !reverseStderr) {
    terminate('git patch pipeline pipes could not be created')
  } else {
    function capture(state: ProcessState, channel: 'stdout' | 'stderr', label: string) {
      return (chunk: Buffer) => {
        if (terminationReason) return
        if (state.outputBytes + chunk.length > DIAGNOSTIC_OUTPUT_LIMIT) {
          terminate(`${label} diagnostic output exceeded ${DIAGNOSTIC_OUTPUT_LIMIT} bytes`)
          return
        }
        state.outputBytes += chunk.length
        state[channel] += chunk.toString('utf8')
      }
    }
    diffStderr.on('data', capture(diffState, 'stderr', 'git diff'))
    reverseStdout.on('data', capture(reverseState, 'stdout', 'git apply'))
    reverseStderr.on('data', capture(reverseState, 'stderr', 'git apply'))
    diffStderr.on('error', (error) => {
      diffState.error = error.message
      terminate(`git diff stderr stream failed: ${error.message}`)
    })
    reverseStdout.on('error', (error) => {
      reverseState.error = error.message
      terminate(`git apply stdout stream failed: ${error.message}`)
    })
    reverseStderr.on('error', (error) => {
      reverseState.error = error.message
      terminate(`git apply stderr stream failed: ${error.message}`)
    })
    function closeApplyInput() {
      if (applyInputClosed) return
      applyInputClosed = true
      if (!diffOutputEnded) {
        inputClosedEarly = true
        diffStdout.resume()
      }
    }
    reverseStdin.on('error', (error) => {
      const code = 'code' in error ? error.code : null
      if (code === 'EPIPE') {
        closeApplyInput()
        return
      }
      reverseState.error = error.message
      terminate(`git apply stdin stream failed: ${error.message}`)
    })
    reverseStdin.on('close', closeApplyInput)
    diffStdout.on('data', (chunk: Buffer) => {
      patchBytes += chunk.length
      if (!Number.isSafeInteger(patchBytes)) {
        terminate('aggregate patch byte count exceeded the safe integer range')
        return
      }
      if (applyInputClosed || terminationReason) return
      try {
        if (!reverseStdin.write(chunk)) {
          diffStdout.pause()
          reverseStdin.once('drain', () => {
            if (!applyInputClosed && !terminationReason) diffStdout.resume()
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        reverseState.error = detail
        terminate(`git apply stdin write failed: ${detail}`)
      }
    })
    diffStdout.once('end', () => {
      diffOutputEnded = true
      if (!applyInputClosed) reverseStdin.end()
    })
    diffStdout.once('error', (error) => {
      diffState.error = error.message
      terminate(`git diff stdout stream failed: ${error.message}`)
    })
    diffStdout.once('close', () => {
      if (!diffOutputEnded && !terminationReason) {
        diffState.error = 'git diff stdout closed before the complete patch was streamed'
        terminate(diffState.error)
      }
    })
  }

  const timeoutTimer = setTimeout(() => {
    terminate(`git patch pipeline timed out after ${PATCH_PIPELINE_TIMEOUT}ms`)
  }, PATCH_PIPELINE_TIMEOUT)
  const allChildrenClosed = Promise.all([diffClosed, reverseClosed]).then(() => {
    return true
  })
  const terminationConfirmed = await Promise.race([
    allChildrenClosed,
    unconfirmedTermination.then(() => {
      return false
    }),
  ])
  clearTimeout(timeoutTimer)
  if (escalationTimer) clearTimeout(escalationTimer)
  if (unconfirmedTimer) clearTimeout(unconfirmedTimer)
  function resultFor(state: ProcessState) {
    const errors: string[] = []
    if (state.error) errors.push(state.error)
    if (terminationReason) errors.push(terminationReason)
    if (state.signal && !terminationReason) errors.push(`process terminated by ${state.signal}`)
    return {
      ok: terminationConfirmed && state.closed && state.status === 0 && errors.length === 0,
      status: state.status,
      stdout: state.stdout,
      stderr: state.stderr,
      error: errors.length > 0 ? errors.join('; ') : null,
    }
  }
  return {
    diff: resultFor(diffState),
    reverse: resultFor(reverseState),
    patchBytes,
    inputClosedEarly,
    terminationConfirmed,
    failure: terminationReason,
  }
}

export async function aggregatePatchEquivalence(
  repo: string,
  expectedHead: string,
  defaultRef: string,
  git: GitRunner,
  environment?: Record<string, string | undefined>,
  afterDiffSpawn?: AfterDiffSpawn,
) {
  const baseArgs = ['merge-base', '--all', defaultRef, expectedHead]
  const baseResult = git(repo, baseArgs)
  if (!baseResult.ok) {
    if (baseResult.status === 1 && !baseResult.stderr && !baseResult.error) {
      return { ok: true, merged: false, reason: 'no-common-base' } satisfies AggregatePatchResult
    }
    return failed(commandError(baseArgs, baseResult))
  }
  const mergeBases = baseResult.stdout.trim().split(/\r?\n/)
  if (mergeBases.length !== 1) {
    return failed(
      `git ${baseArgs.join(' ')} returned multiple best merge bases; aggregate patch is ambiguous`,
    )
  }
  const mergeBase = mergeBases[0] ?? ''
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(mergeBase)) {
    return failed(`git ${baseArgs.join(' ')} returned an invalid commit OID`)
  }

  const pathsArgs = ['diff', '--name-only', '-z', '--no-renames', mergeBase, expectedHead]
  const paths = git(repo, pathsArgs)
  if (!paths.ok) return failed(commandError(pathsArgs, paths))
  const changedPathCount = paths.stdout.split('\0').filter(Boolean).length
  if (changedPathCount === 0) {
    return {
      ok: true,
      merged: false,
      reason: 'empty-net-diff',
      merge_base: mergeBase,
      commit_count: 0,
      changed_path_count: changedPathCount,
    } satisfies AggregatePatchResult
  }

  const countArgs = ['rev-list', '--no-merges', '--count', `${defaultRef}..${expectedHead}`]
  const countResult = git(repo, countArgs)
  if (!countResult.ok) return failed(commandError(countArgs, countResult))
  const countText = countResult.stdout.trim()
  if (!/^\d+$/.test(countText))
    return failed(`git ${countArgs.join(' ')} returned an invalid commit count`)
  const commitCount = Number(countText)
  if (!Number.isSafeInteger(commitCount))
    return failed(`git ${countArgs.join(' ')} returned an unsafe commit count`)

  let tempDirectory = ''
  let tempIdentity: { dev: number; ino: number } | null = null
  let preserveTempDirectory = false
  let outcome: AggregatePatchResult = failed('aggregate patch check did not run')
  try {
    tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'clean-merged-branches-index-'))
    const tempStat = lstatSync(tempDirectory)
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) {
      outcome = failed('temporary index directory is not a real directory')
    } else {
      tempIdentity = { dev: tempStat.dev, ino: tempStat.ino }
      const indexPath = path.join(tempDirectory, 'index')
      const env = { GIT_INDEX_FILE: indexPath, LC_ALL: 'C' }
      const readTreeArgs = ['read-tree', defaultRef]
      const readTree = git(repo, readTreeArgs, { env })
      if (!readTree.ok) {
        outcome = failed(commandError(readTreeArgs, readTree))
      } else {
        const patchArgs = [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          mergeBase,
          expectedHead,
        ]
        const applyArgs = [
          'apply',
          '--cached',
          '--reverse',
          '--check',
          '--binary',
          '--verbose',
          '--whitespace=nowarn',
        ]
        const streamed = await streamAggregatePatch(
          repo,
          patchArgs,
          applyArgs,
          environment,
          { ...environment, ...env },
          afterDiffSpawn,
        )
        if (!streamed.terminationConfirmed) {
          preserveTempDirectory = true
          outcome = {
            ...failed(
              `${streamed.failure || 'aggregate patch subprocess termination could not be confirmed'}; temporary index directory preserved for inspection: ${tempDirectory}`,
            ),
            terminationUnconfirmed: true,
          }
        } else if (streamed.failure) {
          outcome = failed(streamed.failure)
        } else if (!streamed.diff.ok) {
          outcome = failed(commandError(patchArgs, streamed.diff))
        } else if (streamed.patchBytes === 0) {
          outcome = {
            ok: true,
            merged: false,
            reason: 'empty-net-diff',
            merge_base: mergeBase,
            commit_count: commitCount,
            changed_path_count: changedPathCount,
          }
        } else if (
          !streamed.reverse.ok &&
          (streamed.reverse.status !== 1 || streamed.reverse.error || streamed.inputClosedEarly)
        ) {
          outcome = failed(commandError(applyArgs, streamed.reverse))
        } else if (streamed.reverse.ok && streamed.inputClosedEarly) {
          outcome = failed(
            'git apply closed its input before the complete aggregate patch was streamed',
          )
        } else {
          const reverseOutput = `${streamed.reverse.stdout}\n${streamed.reverse.stderr}`
          const relocatedHunk = reverseOutput.split(/\r?\n/).some((line) => {
            return /^\s*Hunk #\d+ succeeded\b.*\b(?:offset|fuzz)\b/i.test(line)
          })
          if (streamed.reverse.ok && relocatedHunk) {
            outcome = failed(
              'aggregate reverse patch required offset or fuzz; patch placement is ambiguous',
            )
          } else if (streamed.reverse.ok) {
            outcome = {
              ok: true,
              merged: true,
              merge_base: mergeBase,
              commit_count: commitCount,
              changed_path_count: changedPathCount,
            }
          } else {
            outcome = {
              ok: true,
              merged: false,
              reason: 'aggregate-patch-not-present',
              merge_base: mergeBase,
              commit_count: commitCount,
              changed_path_count: changedPathCount,
            }
          }
        }
      }
    }
  } catch (error) {
    outcome = failed(
      `aggregate patch temporary-index operation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (tempDirectory && !preserveTempDirectory) {
    try {
      const current = lstatSync(tempDirectory)
      if (
        !tempIdentity ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== tempIdentity.dev ||
        current.ino !== tempIdentity.ino
      ) {
        return failed('temporary index directory identity changed; preserving it for inspection')
      }
      rmSync(tempDirectory, { recursive: true })
    } catch (error) {
      return failed(
        `temporary index directory cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return outcome
}
