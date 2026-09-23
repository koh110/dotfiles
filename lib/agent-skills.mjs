import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

export class SkillDeployConflictError extends Error {
  constructor(conflicts) {
    super('skill deployment conflicts detected')
    this.name = 'SkillDeployConflictError'
    this.conflicts = conflicts
  }
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function signature(path) {
  const stat = await lstat(path)
  if (stat.isDirectory()) return 'dir'
  if (stat.isSymbolicLink()) return 'link:' + await readlink(path)
  if (stat.isFile()) {
    const hash = createHash('sha256').update(await readFile(path)).digest('hex')
    return 'file:' + hash
  }
  throw new Error(`unsupported skill artifact: ${path}`)
}

async function snapshotPath(path, rel, out) {
  out[rel] = await signature(path)
  const stat = await lstat(path)
  if (!stat.isDirectory()) return

  const entries = await readdir(path, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    await snapshotPath(join(path, entry.name), join(rel, entry.name), out)
  }
}

async function snapshotEntries(root, names) {
  const out = {}
  for (const name of [...names].sort()) {
    const path = join(root, name)
    if (await exists(path)) await snapshotPath(path, name, out)
  }
  return out
}

async function topLevelEntries(root) {
  const entries = await readdir(root, { withFileTypes: true })
  return entries.map((entry) => entry.name).sort()
}

async function readManifest(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.entries) ||
      typeof parsed.paths !== 'object' ||
      parsed.paths === null
    ) {
      throw new Error(`invalid skill deploy manifest: ${path}`)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: 1, entries: [], paths: {} }
    }
    throw error
  }
}

function detectConflicts(source, target, previous) {
  const conflicts = []
  const paths = new Set([
    ...Object.keys(source),
    ...Object.keys(target),
    ...Object.keys(previous),
  ])

  for (const path of [...paths].sort()) {
    const src = source[path]
    const dst = target[path]
    const prev = previous[path]

    if (dst === undefined) continue
    if (prev !== undefined && dst === prev) continue
    if (src !== undefined && dst === src) continue

    conflicts.push({
      path,
      reason: prev === undefined && src === undefined
        ? 'managed skill directory contains an unmanaged artifact'
        : 'installed snapshot was modified outside deploy',
    })
  }

  return conflicts
}

export async function inspectSkillsSnapshot({
  sourceDir,
  targetDir,
  manifestPath,
}) {
  const currentEntries = await topLevelEntries(sourceDir)
  const previous = await readManifest(manifestPath)
  const managedEntries = new Set([...currentEntries, ...previous.entries])
  const source = await snapshotEntries(sourceDir, currentEntries)
  const target = await snapshotEntries(targetDir, managedEntries)
  const conflicts = detectConflicts(source, target, previous.paths)

  return {
    conflicts,
    currentEntries,
    source,
    previous,
  }
}

export async function deploySkillsSnapshot({
  sourceDir,
  targetDir,
  manifestPath,
  force = false,
  check = false,
}) {
  const state = await inspectSkillsSnapshot({ sourceDir, targetDir, manifestPath })

  if (state.conflicts.length > 0 && !force) {
    throw new SkillDeployConflictError(state.conflicts)
  }
  if (check) return state

  const parent = dirname(targetDir)
  const stageDir = join(parent, `.${basename(targetDir)}.dotfiles-stage-${process.pid}`)
  const backupDir = join(parent, `.${basename(targetDir)}.dotfiles-backup-${process.pid}`)
  const managedEntries = new Set([...state.currentEntries, ...state.previous.entries])

  await mkdir(parent, { recursive: true })
  await rm(stageDir, { recursive: true, force: true })
  await rm(backupDir, { recursive: true, force: true })

  const targetExists = await exists(targetDir)
  if (targetExists) {
    const targetStat = await lstat(targetDir)
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
      throw new Error(`skill install root must be a real directory: ${targetDir}`)
    }
    await cp(targetDir, stageDir, { recursive: true })
  } else {
    await mkdir(stageDir, { recursive: true })
  }

  try {
    for (const name of managedEntries) {
      await rm(join(stageDir, name), { recursive: true, force: true })
    }
    for (const name of state.currentEntries) {
      await cp(join(sourceDir, name), join(stageDir, name), { recursive: true })
    }

    if (targetExists) await rename(targetDir, backupDir)
    try {
      await rename(stageDir, targetDir)
    } catch (error) {
      if (targetExists && await exists(backupDir)) {
        await rename(backupDir, targetDir)
      }
      throw error
    }
    await rm(backupDir, { recursive: true, force: true })
  } finally {
    await rm(stageDir, { recursive: true, force: true })
  }

  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    entries: state.currentEntries,
    paths: state.source,
  }, null, 2) + '\n')

  return state
}

async function sameTree(a, b) {
  if (!await exists(a) || !await exists(b)) return false
  const left = {}
  const right = {}
  await snapshotPath(a, '.', left)
  await snapshotPath(b, '.', right)

  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  if (leftEntries.length !== rightEntries.length) return false

  return leftEntries.every(([path, value]) => right[path] === value)
}

async function pointsTo(linkPath, expectedPath) {
  const stat = await lstat(linkPath)
  if (!stat.isSymbolicLink()) return false
  const target = await readlink(linkPath)
  return resolve(dirname(linkPath), target) === resolve(expectedPath)
}

async function skillNames(canonicalDir) {
  const names = []
  for (const entry of await readdir(canonicalDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (await exists(join(canonicalDir, entry.name, 'SKILL.md'))) {
      names.push(entry.name)
    }
  }
  return names.sort()
}

export async function reconcileRuntimeSkills({
  canonicalDir,
  runtimeSkillsDir,
  mode,
  force = false,
  replaceRealEntries = false,
  check = false,
}) {
  const conflicts = []
  const changes = []
  const names = await skillNames(canonicalDir)

  if (await exists(runtimeSkillsDir)) {
    const rootStat = await lstat(runtimeSkillsDir)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`runtime skill root must be a real directory: ${runtimeSkillsDir}`)
    }
  } else if (!check) {
    await mkdir(runtimeSkillsDir, { recursive: true })
  }

  for (const name of names) {
    const expected = join(canonicalDir, name)
    const actual = join(runtimeSkillsDir, name)

    if (!await exists(actual)) {
      if (mode === 'symlink') {
        changes.push({ path: actual, action: 'create-symlink' })
        if (!check) await symlink(expected, actual, 'dir')
      }
      continue
    }

    const stat = await lstat(actual)
    if (stat.isSymbolicLink()) {
      const correct = await pointsTo(actual, expected)
      if (mode === 'symlink' && correct) continue
      if (!correct && !force) {
        conflicts.push({ path: actual, reason: 'existing symlink points to another target' })
        continue
      }

      changes.push({ path: actual, action: mode === 'symlink' ? 'replace-symlink' : 'remove-legacy' })
      if (!check) {
        await rm(actual, { force: true })
        if (mode === 'symlink') await symlink(expected, actual, 'dir')
      }
      continue
    }

    const identical = await sameTree(actual, expected)
    if (!identical && !replaceRealEntries && !force) {
      conflicts.push({ path: actual, reason: 'legacy runtime skill differs from canonical snapshot' })
      continue
    }

    changes.push({ path: actual, action: mode === 'symlink' ? 'replace-with-symlink' : 'remove-legacy' })
    if (!check) {
      await rm(actual, { recursive: true, force: true })
      if (mode === 'symlink') await symlink(expected, actual, 'dir')
    }
  }

  if (conflicts.length > 0 && !force) {
    throw new SkillDeployConflictError(conflicts)
  }

  return { conflicts, changes }
}
